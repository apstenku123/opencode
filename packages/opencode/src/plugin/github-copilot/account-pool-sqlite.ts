/**
 * SQLite-backed persistence for `AccountPool` cooldown state.
 *
 * Ports the Copilot `AccountPoolPersistence` adapter from
 * `codex-rs/core/src/account_pool_persistence.rs` and the rate-limit subset of
 * `core/src/stats_store.rs` — only what's required to make 429 cooldowns,
 * headerless-429 escalator counts, and `last_429_at` survive a process
 * restart.  We deliberately keep this much smaller than the Rust StatsStore:
 *
 *  - one table (`account_rate_state`) keyed by account `key`
 *  - debounced background writer (100 ms), inspired by Rust's "flush on
 *    interval" pattern but implemented as a setTimeout coalescer
 *  - synchronous boot-time `loadAll()` for hydration into `AccountPool`
 *
 * The DB lives next to the JSON connection store so users can wipe both at
 * once if they need a fresh slate.  When `bun:sqlite` is unavailable (e.g.
 * test environments running on Node), `open()` returns a no-op store so the
 * pool can fall back to the in-memory escalator transparently.
 */

import path from "path"
import fs from "fs"

export type RateRow = {
  key: string
  exhaustedUntil?: number
  headerless429Count: number
  last429At?: number
}

export type RateStore = {
  /** Synchronous read of every row at boot time. */
  loadAll(): RateRow[]
  /** Queue a debounced upsert. Multiple calls within the window coalesce. */
  upsert(row: RateRow): void
  /** Queue a debounced delete. */
  remove(key: string): void
  /** Force any pending writes to flush immediately (used by tests + shutdown). */
  flush(): void
  /** Permanently close the underlying handle. */
  close(): void
}

const DEFAULT_DEBOUNCE_MS = 100

const NOOP: RateStore = {
  loadAll: () => [],
  upsert: () => {},
  remove: () => {},
  flush: () => {},
  close: () => {},
}

type DatabaseLike = {
  exec(sql: string): unknown
  prepare(sql: string): {
    all(...args: unknown[]): unknown[]
    run(...args: unknown[]): unknown
  }
  close(): unknown
}

/**
 * Open (and lazily create) the rate-state SQLite store.
 *
 * On any error — missing `bun:sqlite`, unwritable directory, schema failure —
 * returns the {@link NOOP} store so the pool still works without persistence.
 */
export async function openRateStore(filePath: string, debounceMs = DEFAULT_DEBOUNCE_MS): Promise<RateStore> {
  let mod: { Database: new (path: string, opts?: unknown) => DatabaseLike }
  try {
    mod = (await import("bun:sqlite")) as unknown as {
      Database: new (path: string, opts?: unknown) => DatabaseLike
    }
  } catch {
    return NOOP
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  } catch {
    // proceed; Database will surface the real error
  }
  let db: DatabaseLike
  try {
    db = new mod.Database(filePath, { create: true })
  } catch {
    return NOOP
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_rate_state (
        key TEXT PRIMARY KEY,
        exhausted_until INTEGER,
        headerless_429_count INTEGER NOT NULL DEFAULT 0,
        last_429_at INTEGER
      );
    `)
  } catch {
    try { db.close() } catch {}
    return NOOP
  }
  return makeStore(db, debounceMs)
}

/** Synchronous variant used by tests that already have a DatabaseLike instance. */
export function makeRateStoreFromDb(db: DatabaseLike, debounceMs = DEFAULT_DEBOUNCE_MS): RateStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_rate_state (
      key TEXT PRIMARY KEY,
      exhausted_until INTEGER,
      headerless_429_count INTEGER NOT NULL DEFAULT 0,
      last_429_at INTEGER
    );
  `)
  return makeStore(db, debounceMs)
}

function makeStore(db: DatabaseLike, debounceMs: number): RateStore {
  type Pending = { type: "upsert"; row: RateRow } | { type: "remove"; key: string }
  const pending = new Map<string, Pending>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.size === 0 || closed) return
    const items = [...pending.values()]
    pending.clear()
    try {
      db.exec("BEGIN")
      for (const item of items) {
        if (item.type === "remove") {
          db.prepare("DELETE FROM account_rate_state WHERE key = ?").run(item.key)
        } else {
          db.prepare(
            "INSERT INTO account_rate_state (key, exhausted_until, headerless_429_count, last_429_at) " +
              "VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(key) DO UPDATE SET " +
              "exhausted_until = excluded.exhausted_until, " +
              "headerless_429_count = excluded.headerless_429_count, " +
              "last_429_at = excluded.last_429_at",
          ).run(
            item.row.key,
            item.row.exhaustedUntil ?? null,
            item.row.headerless429Count,
            item.row.last429At ?? null,
          )
        }
      }
      db.exec("COMMIT")
    } catch {
      try { db.exec("ROLLBACK") } catch {}
    }
  }

  const schedule = () => {
    if (closed) return
    if (timer) return
    timer = setTimeout(flushNow, debounceMs)
    ;(timer as { unref?(): void } | undefined)?.unref?.()
  }

  return {
    loadAll(): RateRow[] {
      try {
        const rows = db
          .prepare(
            "SELECT key, exhausted_until, headerless_429_count, last_429_at FROM account_rate_state",
          )
          .all() as Array<{
          key: string
          exhausted_until: number | null
          headerless_429_count: number | null
          last_429_at: number | null
        }>
        return rows.map((row) => ({
          key: row.key,
          exhaustedUntil: row.exhausted_until ?? undefined,
          headerless429Count: row.headerless_429_count ?? 0,
          last429At: row.last_429_at ?? undefined,
        }))
      } catch {
        return []
      }
    },
    upsert(row) {
      pending.set(row.key, { type: "upsert", row })
      schedule()
    },
    remove(key) {
      pending.set(key, { type: "remove", key })
      schedule()
    },
    flush: flushNow,
    close() {
      if (closed) return
      flushNow()
      closed = true
      try { db.close() } catch {}
    },
  }
}
