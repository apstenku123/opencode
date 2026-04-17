/**
 * Round-1 Memory subsystem facade.
 *
 * Pulls the three capability surfaces (storage, embedding, retrieval) into a
 * single `Memory` service that upstream callers (turn-hook injection,
 * foreign-ingest pipeline — both round 2+) can depend on without reaching
 * into sub-modules.
 *
 * Round 1 scope (what this facade exposes today):
 *  - `add(input)`: hash-dedup insert + embed + attach embedding in one call.
 *  - `addWithoutEmbedding(input)`: BYO-sextuple JSONL imports that don't want
 *    to incur a live embedding round-trip.
 *  - `retrieve({queryText, ...})`: query-text → embed → cosine top-K.
 *  - `retrieveByEmbedding(...)`: skip the embed step when the caller already
 *    has a vector (tests, offline pipelines).
 *
 * Not yet wired (round 2+): LLM query synthesis, stage-2 rerank, turn-hook
 * injection into the user-prompt path, phase-1/phase-2 extraction pipeline,
 * commit crawler, foreign ingest.
 */

import { Context, Effect, Layer, Option } from "effect"
import { EmbeddingService } from "./embedding"
import {
  type DefectSextuple,
  type DefectSextupleInput,
  type MemoryEmbeddingError,
  type MemoryStorageError,
  type MemoryValidationError,
  embeddingKey,
} from "./schema"
import { MemoryRetrieval, type RetrieveInput, type ScoredSextuple } from "./retrieval"
import { MemoryStorage } from "./storage"

export namespace Memory {
  export interface AddResult {
    readonly inserted: boolean
    readonly embedded: boolean
    readonly record: DefectSextuple
  }

  export interface RetrieveByTextInput {
    readonly queryText: string
    readonly projectID?: string
    readonly topK?: number
    readonly minScore?: number
  }

  export interface Interface {
    /**
     * Validate, dedup, persist, then compute+attach the embedding. If the
     * embedding step fails, the record remains stored without an embedding —
     * the error is still surfaced so the caller can retry.
     */
    readonly add: (
      input: DefectSextupleInput,
    ) => Effect.Effect<AddResult, MemoryStorageError | MemoryValidationError | MemoryEmbeddingError>

    /**
     * Store without computing an embedding. Useful for BYO-sextuple imports
     * and tests. The record can be embedded later via `embed(hashId)`.
     */
    readonly addWithoutEmbedding: (
      input: DefectSextupleInput,
    ) => Effect.Effect<AddResult, MemoryStorageError | MemoryValidationError>

    /**
     * Embed (or re-embed) a stored record. Idempotent.
     */
    readonly embed: (hashId: string) => Effect.Effect<void, MemoryStorageError | MemoryEmbeddingError>

    readonly get: (hashId: string) => Effect.Effect<Option.Option<DefectSextuple>, MemoryStorageError>

    readonly listByProject: (
      projectID: string | undefined,
      limit?: number,
    ) => Effect.Effect<DefectSextuple[], MemoryStorageError>

    readonly retrieve: (
      input: RetrieveByTextInput,
    ) => Effect.Effect<ScoredSextuple[], MemoryStorageError | MemoryEmbeddingError>

    readonly retrieveByEmbedding: (
      input: RetrieveInput,
    ) => Effect.Effect<ScoredSextuple[], MemoryStorageError>
  }
}

export class Memory extends Context.Service<Memory, Memory.Interface>()("@opencode/memory/Memory") {}

export const layer: Layer.Layer<Memory, never, MemoryStorage | MemoryRetrieval | EmbeddingService> = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const retrieval = yield* MemoryRetrieval
    const embedder = yield* EmbeddingService

    const embedOne = (record: DefectSextuple) =>
      Effect.gen(function* () {
        const key = embeddingKey({ keywords: record.keywords, problem: record.problem })
        const vector = yield* embedder.embed(key)
        yield* storage.updateEmbedding(record.hashId, vector)
      })

    return {
      add: (input) =>
        Effect.gen(function* () {
          const { inserted, record } = yield* storage.store(input)
          // If the row already exists and already has an embedding, nothing to do.
          if (!inserted && record.embedding) {
            return { inserted: false, embedded: true, record }
          }
          yield* embedOne(record)
          return { inserted, embedded: true, record }
        }),

      addWithoutEmbedding: (input) =>
        Effect.gen(function* () {
          const { inserted, record } = yield* storage.store(input)
          return { inserted, embedded: record.embedding !== undefined, record }
        }),

      embed: (hashId) =>
        Effect.gen(function* () {
          const opt = yield* storage.getByHash(hashId)
          if (Option.isNone(opt)) return
          yield* embedOne(opt.value)
        }),

      get: (hashId) => storage.getByHash(hashId),
      listByProject: (projectID, limit) => storage.listByProject(projectID, limit),

      retrieve: ({ queryText, projectID, topK, minScore }) =>
        Effect.gen(function* () {
          const queryEmbedding = yield* embedder.embed(queryText)
          return yield* retrieval.retrieve({ queryEmbedding, projectID, topK, minScore })
        }),

      retrieveByEmbedding: (input) => retrieval.retrieve(input),
    }
  }),
)

// Re-exports so callers can `import { Memory, EmbeddingService, … } from "@/memory"`.
export { EmbeddingService, mockLayer as mockEmbeddingLayer, openAICompatLayer } from "./embedding"
export { MemoryStorage, layer as memoryStorageLayer } from "./storage"
export { MemoryRetrieval, cosineSimilarity, rankByCosine, layer as memoryRetrievalLayer } from "./retrieval"
export type { DefectSextuple, DefectSextupleInput, SextupleSource } from "./schema"
export type { ScoredSextuple, RetrieveInput } from "./retrieval"
export * as MemorySchema from "./schema"
