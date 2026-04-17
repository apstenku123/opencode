/**
 * Advisory per-git-root writer lock for foreign ingest.
 *
 * Port of `codex-rs/core/src/memories/foreign_ingest/writer_lock.rs`. Ensures
 * only one OpenCode process per git root runs the foreign-ingest pipeline at
 * a time. Multiple OpenCode instances in the same directory still run
 * normally; only one acquires the lock — the others get
 * [`WriterGate.AlreadyHeld`] and silently skip.
 *
 * Implementation: O_EXCL lockfile under `<dataDir>/foreign_ingest/<hash>.lock`
 * where `<hash>` is the first 16 hex chars of `sha256(gitRoot)`. The lockfile
 * holds `<hostname>:<pid>` so callers can debug stuck locks. The kernel does
 * NOT release this lock automatically — we use a BEST-EFFORT stale check:
 * if an existing lockfile's pid does not point at a live process on this
 * host, the lock is treated as stale and forcibly reclaimed. Cross-host
 * locks always lose to the existing holder (we can't introspect remote pids).
 *
 * The Rust impl uses `fs4`/POSIX `flock` for true kernel-managed leases;
 * Bun/Node has no flock binding in the standard library, so we accept the
 * pid-check tradeoff. A second OpenCode process that crashes mid-run with no
 * cleanup releases its lock as soon as another process runs the stale check.
 */

import { Effect } from "effect"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface WriterLockGuard {
  readonly path: string
  readonly release: () => void
}

export type WriterGate =
  | { readonly _tag: "Acquired"; readonly guard: WriterLockGuard }
  | { readonly _tag: "AlreadyHeld"; readonly heldBy: string }

// --------------------------------------------------------------------------
// Path computation
// --------------------------------------------------------------------------

/**
 * Compute the lockfile path for a given git root. Deterministic across
 * processes: `<dataDir>/foreign_ingest/<8-byte-sha256-hex>.lock`.
 */
export function lockPathFor(dataDir: string, gitRoot: string): string {
  const hasher = createHash("sha256")
  hasher.update(gitRoot)
  const digest = hasher.digest()
  const name = digest.subarray(0, 8).toString("hex") + ".lock"
  return path.join(dataDir, "foreign_ingest", name)
}

// --------------------------------------------------------------------------
// Acquire / release
// --------------------------------------------------------------------------

interface LockContent {
  readonly host: string
  readonly pid: number
}

function readLockContent(filePath: string): LockContent | undefined {
  try {
    const raw = readFileSync(filePath, "utf8").trim()
    if (!raw) return undefined
    const idx = raw.lastIndexOf(":")
    if (idx <= 0) return undefined
    const host = raw.slice(0, idx)
    const pid = Number(raw.slice(idx + 1))
    if (!Number.isFinite(pid) || pid <= 0) return undefined
    return { host, pid }
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 — no-op probe; throws ESRCH if pid doesn't exist.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM means the process exists but we lack permission — treat as alive
    // so we don't race a foreign user's process.
    if (code === "EPERM") return true
    return false
  }
}

function tryClaim(filePath: string): { ok: boolean; existing?: LockContent } {
  // O_EXCL | O_CREAT — fails atomically if another process already created
  // the file. wx flag in Node maps to those flags.
  let fd: number | undefined
  try {
    fd = openSync(filePath, "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, existing: readLockContent(filePath) }
    }
    throw err
  }
  try {
    const payload = `${hostname()}:${process.pid}`
    writeFileSync(fd, payload, "utf8")
  } finally {
    closeSync(fd)
  }
  return { ok: true }
}

/**
 * Try to acquire the single-writer lock for a git root.
 *
 * Returns `WriterGate.Acquired` on success, `WriterGate.AlreadyHeld` if
 * another process owns the lock. Throws on real I/O errors (permissions,
 * disk full).
 */
export function tryAcquireWriterLock(dataDir: string, gitRoot: string): WriterGate {
  const lockPath = lockPathFor(dataDir, gitRoot)
  mkdirSync(path.dirname(lockPath), { recursive: true })

  // First attempt.
  const first = tryClaim(lockPath)
  if (first.ok) {
    return { _tag: "Acquired", guard: makeGuard(lockPath) }
  }

  // Stale check: only reclaim if the lock points at a dead pid on the
  // SAME host. Cross-host locks always lose.
  const existing = first.existing
  const heldBy = existing ? `${existing.host}:${existing.pid}` : "<unreadable>"
  if (existing && existing.host === hostname() && !isProcessAlive(existing.pid)) {
    try {
      unlinkSync(lockPath)
    } catch {
      // Concurrent reclaim won the race — fall through and report AlreadyHeld.
      return { _tag: "AlreadyHeld", heldBy }
    }
    const second = tryClaim(lockPath)
    if (second.ok) return { _tag: "Acquired", guard: makeGuard(lockPath) }
  }

  return { _tag: "AlreadyHeld", heldBy }
}

function makeGuard(filePath: string): WriterLockGuard {
  let released = false
  return {
    path: filePath,
    release: () => {
      if (released) return
      released = true
      try {
        // Only delete if WE still own the lock. Race-safe enough: a stale
        // reclaim by another process between our open and unlink would mean
        // they hold a different fd/content — we'd just delete their file. To
        // mitigate, we read & verify content before unlinking.
        const content = readLockContent(filePath)
        if (content && content.host === hostname() && content.pid === process.pid) {
          unlinkSync(filePath)
        }
      } catch {
        // Best-effort cleanup; OS will reclaim eventually.
      }
    },
  }
}

// --------------------------------------------------------------------------
// Effect helper
// --------------------------------------------------------------------------

/**
 * Run `task` while holding the writer lock for `gitRoot`. If the lock cannot
 * be acquired, `task` is skipped and `onSkip` (default: undefined) is
 * returned. The lock is always released, even if `task` fails.
 */
export const withWriterLock = <A, E, R>(
  dataDir: string,
  gitRoot: string,
  task: Effect.Effect<A, E, R>,
  onSkip?: A,
): Effect.Effect<A | undefined, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => tryAcquireWriterLock(dataDir, gitRoot)),
    (gate) => {
      if (gate._tag === "Acquired") return task as Effect.Effect<A | undefined, E, R>
      return Effect.succeed(onSkip)
    },
    (gate) =>
      Effect.sync(() => {
        if (gate._tag === "Acquired") gate.guard.release()
      }),
  )
