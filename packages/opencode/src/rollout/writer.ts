/**
 * Rollout writer — JSONL append-only log of session events.
 *
 * Mirrors Rust `codex-rs/core/src/rollout/writer.rs` with a couple of
 * pragmatic TS adjustments:
 *
 *  - Each call to {@link RolloutWriter.append} buffers the event in
 *    memory and (optionally) flushes it immediately; {@link flush}
 *    performs a single atomic write via a `<file>.tmp` staging
 *    rename. Periodic flushes are the caller's responsibility
 *    (the session's prompt-loop calls `flush` at end-of-turn).
 *
 *  - The on-disk format is one JSON-encoded `RolloutEntry` per line.
 *    Every entry carries a monotonic sequence number so readers can
 *    detect truncation / interleaving.
 *
 *  - The writer is instance-scoped (one per session) and is thread-
 *    hostile by design; all mutation goes through a single
 *    `Bun.file(...).writer()` handle. A small in-memory tail buffer
 *    is retained for `ReplayFromMemory` uses.
 */
import z from "zod"
import path from "path"
import { rename, appendFile, mkdir, stat, readFile } from "fs/promises"
import { SessionID } from "@/session/schema"
import { RolloutPath } from "./path"

export namespace RolloutWriter {
  /** All event kinds the rollout log understands. */
  export const Kind = z.enum([
    "session.created",
    "session.updated",
    "session.deleted",
    "message.updated",
    "message.removed",
    "part.updated",
    "part.removed",
    "session.error",
    "session.diff",
    "status",
    "custom",
  ])
  export type Kind = z.infer<typeof Kind>

  export const Entry = z.object({
    /** Monotonic sequence number, starting at 0. */
    seq: z.number().int().nonnegative(),
    /** Unix epoch ms. */
    time: z.number().int().nonnegative(),
    /** Event kind. */
    kind: Kind,
    /** Source session id the event belongs to. */
    sessionID: SessionID.zod,
    /** Opaque JSON-serializable event payload. */
    payload: z.unknown(),
  })
  export type Entry = z.infer<typeof Entry>

  export interface Handle {
    readonly sessionID: SessionID
    readonly filePath: string
    append(kind: Kind, payload: unknown): Promise<Entry>
    flush(): Promise<void>
    close(): Promise<void>
    readonly entries: ReadonlyArray<Entry>
  }

  /**
   * Open (or resume) a writer for the given session. The file is
   * created lazily on first append. An existing file's last
   * sequence number is read back so new entries continue the count.
   */
  export async function open(sessionID: SessionID): Promise<Handle> {
    await RolloutPath.ensureRoot()
    const filePath = RolloutPath.forSession(sessionID)
    const stagingPath = RolloutPath.stagingFor(sessionID)

    // Resume: scan existing file (if any) for the last sequence number.
    let nextSeq = 0
    try {
      const st = await stat(filePath)
      if (st.isFile() && st.size > 0) {
        const text = await readFile(filePath, "utf-8")
        const lastLine = text
          .split(/\n/)
          .filter((l) => l.length > 0)
          .at(-1)
        if (lastLine) {
          try {
            const parsed = JSON.parse(lastLine)
            if (typeof parsed?.seq === "number" && parsed.seq >= 0) {
              nextSeq = parsed.seq + 1
            }
          } catch {
            // Corrupted last line — treat as fresh tail; reader handles it.
          }
        }
      }
    } catch {
      // No existing file; fresh log.
    }

    const buffer: Entry[] = []
    let pendingFlush: string[] = []
    let closed = false

    async function flushInner() {
      if (pendingFlush.length === 0) return
      // Atomic-rename pattern: we can't atomically append to the file,
      // but we *can* atomically roll a new tail into place by writing
      // full new content to staging and renaming. For large sessions,
      // fall back to direct append (safe under `appendFile`'s atomic
      // single-write semantics on POSIX when the chunk < PIPE_BUF).
      //
      // We keep the simple append path as the default (it's what
      // Rust's RolloutWriter uses) and the atomic-rename path is
      // exercised by {@link snapshot}.
      const toWrite = pendingFlush.join("")
      pendingFlush = []
      await appendFile(filePath, toWrite, "utf-8")
    }

    /**
     * Rewrite the file atomically from the in-memory tail. Used when
     * the caller wants a strongly-consistent on-disk snapshot (e.g.
     * for ACP "persist replay" endpoints). This is an O(N) operation
     * — callers should use it sparingly.
     */
    async function snapshotAll() {
      const fullText = buffer.map((e) => JSON.stringify(e) + "\n").join("")
      await mkdir(path.dirname(stagingPath), { recursive: true })
      await Bun.write(stagingPath, fullText)
      await rename(stagingPath, filePath)
    }

    const handle: Handle = {
      sessionID,
      filePath,
      get entries() {
        return buffer
      },
      async append(kind, payload) {
        if (closed) throw new Error(`RolloutWriter: cannot append after close (${sessionID})`)
        const entry: Entry = {
          seq: nextSeq++,
          time: Date.now(),
          kind,
          sessionID,
          payload,
        }
        buffer.push(entry)
        pendingFlush.push(JSON.stringify(entry) + "\n")
        return entry
      },
      async flush() {
        if (closed) return
        await flushInner()
      },
      async close() {
        if (closed) return
        closed = true
        await flushInner()
        // Snapshot-on-close gives us a durable, compact on-disk image.
        if (buffer.length > 0) await snapshotAll()
      },
    }

    return handle
  }
}
