import { sqliteTable, text, integer, blob, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { SextupleSource } from "./schema"

/**
 * Stored MemCoder sextuples. One row per unique `(problem, root_cause,
 * solution)` triple (dedup via the `hash_id` unique index). `keywords` and
 * `source` are JSON-encoded; `embedding` is a raw little-endian Float32
 * blob — see `schema.ts#encodeEmbedding`.
 *
 * Indexes:
 *  - `hash_id` unique — drives dedup on `store`.
 *  - `project_id` — scopes retrieval to a project.
 *  - `time_created` — supports listByProject ordering.
 */
export const MemorySextupleTable = sqliteTable(
  "memory_sextuple",
  {
    id: text().primaryKey(),
    hash_id: text().notNull(),
    project_id: text(),
    keywords: text({ mode: "json" }).notNull().$type<string[]>(),
    problem: text().notNull(),
    root_cause: text().notNull(),
    solution: text().notNull(),
    source: text({ mode: "json" }).notNull().$type<SextupleSource>(),
    embedding: blob({ mode: "buffer" }),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_sextuple_hash_id_idx").on(table.hash_id),
    index("memory_sextuple_project_id_idx").on(table.project_id),
    index("memory_sextuple_time_created_idx").on(table.time_created),
  ],
)

/**
 * Round-2 foreign-ingest checkpoint table.
 *
 * One row per successfully processed foreign-ingest input. Presence of a row
 * means the work is done; absence means the pipeline should (re)process it.
 * No state column, no lease — crash safety comes from only inserting after the
 * full per-session pipeline succeeds. Killed processes leave no row and the
 * work is redone on the next pass.
 *
 * Composite primary key `(tool, source_path, content_hash)` so the same
 * source file can record multiple snapshots over time (e.g. a Claude session
 * that grew between ingest runs gets distinct rows). Re-ingesting the same
 * `(tool, source_path, git_root)` with a new `content_hash` removes any
 * stale rows for that triple — see `checkpoint.ts#insertDone` for the
 * dedup invariant.
 *
 * Mirrors `codex-rs/state/migrations/0019_foreign_ingest_done.sql` +
 * `0020_foreign_ingest_done_add_git_root.sql`. Schema lives in
 * `packages/opencode/migration/20260417130000_foreign_ingest_done/`.
 */
export const ForeignIngestDoneTable = sqliteTable(
  "foreign_ingest_done",
  {
    tool: text().notNull(),
    source_path: text().notNull(),
    content_hash: text().notNull(),
    git_root: text().notNull().default(""),
    done_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tool, table.source_path, table.content_hash] }),
    index("foreign_ingest_done_tool_idx").on(table.tool),
    index("foreign_ingest_done_git_root_idx").on(table.git_root),
  ],
)
