import { sqliteTable, text, integer, blob, uniqueIndex, index } from "drizzle-orm/sqlite-core"
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
