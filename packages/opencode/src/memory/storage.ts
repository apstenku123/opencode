/**
 * SQLite-backed CRUD for `DefectSextuple` records.
 *
 * Port of the storage-facing half of `codex-rs/core/src/memories/` — rounds 2+
 * will add the on-disk artifact layout (`raw_memories.md`, `rollout_summaries`,
 * `commit_memory/*.jsonl`) that Rust maintains in parallel. Round 1 is
 * DB-only, which is enough for retrieval-over-sextuples.
 *
 * Invariants:
 *  - `hash_id` is unique; `store` is a no-op on conflict (returns
 *    `{inserted: false}`). Matches Rust's `sha256(problem ⊕ …)` dedup.
 *  - `embedding` is written as little-endian Float32 bytes by
 *    `schema.ts#encodeEmbedding`; reads decode back to Float32Array.
 *  - All writes set `time_updated`; `time_created` is preserved.
 */

import { Context, Effect, Layer, Option } from "effect"
import { Database, desc, eq } from "../storage"
import { MemorySextupleTable } from "./memory.sql"
import {
  type DefectSextuple,
  type DefectSextupleInput,
  MemoryStorageError,
  MemoryValidationError,
  cleanKeywords,
  decodeEmbedding,
  encodeEmbedding,
  hashId as computeHashId,
  validateInput,
} from "./schema"
import { Identifier } from "@/id/id"

export namespace MemoryStorage {
  export interface Interface {
    readonly store: (
      input: DefectSextupleInput,
    ) => Effect.Effect<{ inserted: boolean; record: DefectSextuple }, MemoryStorageError | MemoryValidationError>

    readonly getByHash: (hashId: string) => Effect.Effect<Option.Option<DefectSextuple>, MemoryStorageError>

    readonly listByProject: (
      projectID: string | undefined,
      limit?: number,
    ) => Effect.Effect<DefectSextuple[], MemoryStorageError>

    readonly updateEmbedding: (
      hashId: string,
      embedding: Float32Array,
    ) => Effect.Effect<void, MemoryStorageError>

    readonly deleteByHash: (hashId: string) => Effect.Effect<boolean, MemoryStorageError>

    /**
     * List every record with a populated embedding, optionally scoped to a
     * project. Used by retrieval.
     */
    readonly listEmbedded: (
      projectID: string | undefined,
    ) => Effect.Effect<DefectSextuple[], MemoryStorageError>
  }
}

export class MemoryStorage extends Context.Service<MemoryStorage, MemoryStorage.Interface>()(
  "@opencode/memory/MemoryStorage",
) {}

// --------------------------------------------------------------------------
// Implementation
// --------------------------------------------------------------------------

type Row = typeof MemorySextupleTable.$inferSelect

function fromRow(row: Row): DefectSextuple {
  const base = {
    id: row.id,
    hashId: row.hash_id,
    keywords: row.keywords,
    problem: row.problem,
    rootCause: row.root_cause,
    solution: row.solution,
    source: row.source,
    projectID: row.project_id ?? undefined,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  } as DefectSextuple
  if (row.embedding) {
    const buf = row.embedding as Buffer | Uint8Array
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    return { ...base, embedding: decodeEmbedding(bytes) } as DefectSextuple
  }
  return base
}

function newID(): string {
  return Identifier.descending("memory")
}

export const layer: Layer.Layer<MemoryStorage> = Layer.succeed(MemoryStorage, {
  store: (input) => {
    const validation = validateInput(input)
    if (validation) return Effect.fail(validation)
    return Effect.try({
      try: () =>
        Database.use((db) => {
          const keywords = cleanKeywords(input.keywords)
          const hash = computeHashId({
            problem: input.problem,
            rootCause: input.rootCause,
            solution: input.solution,
          })

          const existing = db.select().from(MemorySextupleTable).where(eq(MemorySextupleTable.hash_id, hash)).get()
          if (existing) {
            return { inserted: false, record: fromRow(existing) }
          }

          const now = Date.now()
          const id = newID()
          db.insert(MemorySextupleTable)
            .values({
              id,
              hash_id: hash,
              project_id: input.projectID ?? null,
              keywords,
              problem: input.problem,
              root_cause: input.rootCause,
              solution: input.solution,
              source: input.source,
              embedding: null,
              time_created: now,
              time_updated: now,
            })
            .run()
          const record = {
            id,
            hashId: hash,
            keywords,
            problem: input.problem,
            rootCause: input.rootCause,
            solution: input.solution,
            source: input.source,
            projectID: input.projectID,
            timeCreated: now,
            timeUpdated: now,
          } as DefectSextuple
          return { inserted: true, record }
        }),
      catch: (cause) => new MemoryStorageError({ message: "memory store operation failed", cause }),
    })
  },

  getByHash: (hashId) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const row = db.select().from(MemorySextupleTable).where(eq(MemorySextupleTable.hash_id, hashId)).get()
          return row ? Option.some(fromRow(row)) : Option.none<DefectSextuple>()
        }),
      catch: (cause) => new MemoryStorageError({ message: "memory getByHash failed", cause }),
    }),

  listByProject: (projectID, limit) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const base = db.select().from(MemorySextupleTable)
          const scoped =
            projectID === undefined ? base : base.where(eq(MemorySextupleTable.project_id, projectID))
          const ordered = scoped.orderBy(desc(MemorySextupleTable.time_created))
          const query = limit !== undefined && limit > 0 ? ordered.limit(limit) : ordered
          return query.all().map((row: Row) => fromRow(row))
        }),
      catch: (cause) => new MemoryStorageError({ message: "memory listByProject failed", cause }),
    }),

  updateEmbedding: (hashId, embedding) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const bytes = encodeEmbedding(embedding)
          const result = db
            .update(MemorySextupleTable)
            .set({ embedding: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) })
            .where(eq(MemorySextupleTable.hash_id, hashId))
            .run()
          if ((result as unknown as { changes?: number }).changes === 0) {
            throw new Error(`no memory_sextuple row with hash_id ${hashId}`)
          }
        }),
      catch: (cause) => new MemoryStorageError({ message: "memory updateEmbedding failed", cause }),
    }),

  deleteByHash: (hashId) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const result = db.delete(MemorySextupleTable).where(eq(MemorySextupleTable.hash_id, hashId)).run()
          return (result as unknown as { changes?: number }).changes !== 0
        }),
      catch: (cause) => new MemoryStorageError({ message: "memory deleteByHash failed", cause }),
    }),

  listEmbedded: (projectID) =>
    Effect.try({
      try: () =>
        Database.use((db) => {
          const base = db.select().from(MemorySextupleTable)
          const scoped =
            projectID === undefined ? base : base.where(eq(MemorySextupleTable.project_id, projectID))
          return scoped
            .all()
            .map((row: Row) => fromRow(row))
            .filter((record: DefectSextuple) => record.embedding !== undefined)
        }),
      catch: (cause) => new MemoryStorageError({ message: "memory listEmbedded failed", cause }),
    }),
})
