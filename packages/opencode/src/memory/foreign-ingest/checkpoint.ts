/**
 * Foreign-ingest dedup checkpoint table.
 *
 * Port of `codex-rs/core/src/memories/foreign_ingest/checkpoint.rs`. Backed by
 * the SQLite `foreign_ingest_done` table (migration 20260417130000). Crash
 * safety: rows are only inserted *after* the per-session pipeline (parse +
 * extract + persist sextuples) finishes. A killed process leaves no row and
 * the work is redone next pass.
 *
 * The composite key is `(tool, source_path, content_hash)`. When the same
 * `(tool, source_path, git_root)` is re-ingested with a *different*
 * `content_hash` (file rewritten, e.g. a JSONL session gained turns), the
 * stale rows for that triple are deleted before the new row is inserted.
 * Without that cleanup, multiple rows would accumulate for what callers see
 * as a single logical session, breaking deterministic per-session lookups.
 */

import { Context, Effect, Layer } from "effect"
import { Database, and, asc, eq, ne, sql } from "../../storage"
import { ForeignIngestDoneTable } from "../memory.sql"
import { MemoryStorageError } from "../schema"

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface CheckpointKey {
  readonly tool: string
  readonly sourcePath: string
  readonly contentHash: string
}

export interface CheckpointRow extends CheckpointKey {
  /** Repo-root that owns this row; defaults to "" when unknown. */
  readonly gitRoot: string
  /** Insertion time in unix milliseconds. */
  readonly doneAt: number
}

export type CheckpointInsert = Omit<CheckpointRow, "doneAt"> & {
  readonly doneAt?: number
}

// --------------------------------------------------------------------------
// Service contract
// --------------------------------------------------------------------------

export namespace ForeignIngestCheckpoint {
  export interface Interface {
    readonly isDone: (key: CheckpointKey) => Effect.Effect<boolean, MemoryStorageError>
    readonly insertDone: (input: CheckpointInsert) => Effect.Effect<void, MemoryStorageError>
    readonly listByTool: (tool: string) => Effect.Effect<CheckpointRow[], MemoryStorageError>
    readonly listByGitRoot: (gitRoot: string) => Effect.Effect<CheckpointRow[], MemoryStorageError>
    readonly deleteByKey: (key: CheckpointKey) => Effect.Effect<boolean, MemoryStorageError>
    readonly countByTool: () => Effect.Effect<Array<{ tool: string; count: number }>, MemoryStorageError>
  }
}

export class ForeignIngestCheckpoint extends Context.Service<
  ForeignIngestCheckpoint,
  ForeignIngestCheckpoint.Interface
>()("@opencode/memory/ForeignIngestCheckpoint") {}

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

type Row = typeof ForeignIngestDoneTable.$inferSelect

function fromRow(row: Row): CheckpointRow {
  return {
    tool: row.tool,
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    gitRoot: row.git_root,
    doneAt: row.done_at,
  }
}

export const layer: Layer.Layer<ForeignIngestCheckpoint> = Layer.succeed(ForeignIngestCheckpoint, {
  isDone: (key) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const row = db
            .select({ one: sql<number>`1` })
            .from(ForeignIngestDoneTable)
            .where(
              and(
                eq(ForeignIngestDoneTable.tool, key.tool),
                eq(ForeignIngestDoneTable.source_path, key.sourcePath),
                eq(ForeignIngestDoneTable.content_hash, key.contentHash),
              ),
            )
            .get()
          return row !== undefined
        }),
      catch: (cause) => new MemoryStorageError({ message: "foreign-ingest isDone failed", cause }),
    }),

  insertDone: (input) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const now = input.doneAt ?? Date.now()
          // Drop any stale rows that share (tool, source_path, git_root) but
          // carry a different content_hash. Without this, repeated ingest of
          // a session file that grew between runs piles up rows and breaks
          // per-session lookups (see Rust checkpoint.rs invariant comment).
          db.delete(ForeignIngestDoneTable)
            .where(
              and(
                eq(ForeignIngestDoneTable.tool, input.tool),
                eq(ForeignIngestDoneTable.source_path, input.sourcePath),
                eq(ForeignIngestDoneTable.git_root, input.gitRoot),
                ne(ForeignIngestDoneTable.content_hash, input.contentHash),
              ),
            )
            .run()
          db.insert(ForeignIngestDoneTable)
            .values({
              tool: input.tool,
              source_path: input.sourcePath,
              content_hash: input.contentHash,
              git_root: input.gitRoot,
              done_at: now,
            })
            .onConflictDoUpdate({
              target: [
                ForeignIngestDoneTable.tool,
                ForeignIngestDoneTable.source_path,
                ForeignIngestDoneTable.content_hash,
              ],
              set: { done_at: now, git_root: input.gitRoot },
            })
            .run()
        }),
      catch: (cause) => new MemoryStorageError({ message: "foreign-ingest insertDone failed", cause }),
    }),

  listByTool: (tool) =>
    Effect.try({
      try: () =>
        Database.use((db) =>
          db
            .select()
            .from(ForeignIngestDoneTable)
            .where(eq(ForeignIngestDoneTable.tool, tool))
            .orderBy(
              asc(ForeignIngestDoneTable.done_at),
              asc(ForeignIngestDoneTable.source_path),
              asc(ForeignIngestDoneTable.content_hash),
            )
            .all()
            .map(fromRow),
        ),
      catch: (cause) => new MemoryStorageError({ message: "foreign-ingest listByTool failed", cause }),
    }),

  listByGitRoot: (gitRoot) =>
    Effect.try({
      try: () =>
        Database.use((db) =>
          db
            .select()
            .from(ForeignIngestDoneTable)
            .where(eq(ForeignIngestDoneTable.git_root, gitRoot))
            .orderBy(
              asc(ForeignIngestDoneTable.done_at),
              asc(ForeignIngestDoneTable.source_path),
              asc(ForeignIngestDoneTable.content_hash),
            )
            .all()
            .map(fromRow),
        ),
      catch: (cause) => new MemoryStorageError({ message: "foreign-ingest listByGitRoot failed", cause }),
    }),

  deleteByKey: (key) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const result = db
            .delete(ForeignIngestDoneTable)
            .where(
              and(
                eq(ForeignIngestDoneTable.tool, key.tool),
                eq(ForeignIngestDoneTable.source_path, key.sourcePath),
                eq(ForeignIngestDoneTable.content_hash, key.contentHash),
              ),
            )
            .run()
          return (result as unknown as { changes?: number }).changes !== 0
        }),
      catch: (cause) => new MemoryStorageError({ message: "foreign-ingest deleteByKey failed", cause }),
    }),

  countByTool: () =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const rows = db
            .select({
              tool: ForeignIngestDoneTable.tool,
              count: sql<number>`COUNT(*)`,
            })
            .from(ForeignIngestDoneTable)
            .groupBy(ForeignIngestDoneTable.tool)
            .orderBy(asc(ForeignIngestDoneTable.tool))
            .all()
          return rows.map((r) => ({ tool: r.tool as string, count: Number(r.count) }))
        }),
      catch: (cause) => new MemoryStorageError({ message: "foreign-ingest countByTool failed", cause }),
    }),
})
