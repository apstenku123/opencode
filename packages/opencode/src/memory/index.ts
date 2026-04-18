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
  type SextupleSource,
  embeddingKey,
} from "./schema"
import { MemoryRetrieval, type RetrieveInput, type ScoredSextuple } from "./retrieval"
import { MemoryStorage } from "./storage"
import {
  enrichUserPromptWithMemories,
  type EnrichUserPromptInput,
  type EnrichUserPromptResult,
} from "./turn-hooks"
import { runPhase1 as runPhase1Impl, type Phase1Model, type RunPhase1Result } from "./phase1"

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

    /**
     * Round-2 turn-hook entry point. Synthesize a retrieval query from the
     * raw user prompt, run the cosine + (optional) LLM rerank pipeline, and
     * return the rendered `<similar_past_problems>` block alongside the
     * underlying hits. Best-effort: never throws; on any miss the `block`
     * field is `null` and the caller leaves the user message untouched.
     */
    readonly enrichPrompt: (
      input: Omit<EnrichUserPromptInput, "memory">,
    ) => Effect.Effect<EnrichUserPromptResult>

    /**
     * Round-2 Phase-1 extractor entry point. Given a rollout/turn text
     * blob, run the LLM extractor + dedup-store pipeline and return the
     * raw response, the `DefectSextupleInput`s that survived validation,
     * and the storage-side outcome for each persisted record.
     *
     * NB: this entry point does NOT run the refining gate — turn-hooks
     * does that as a separate stage. Callers that want refining should
     * use `extractAndRefineTurnSextuples` from `./turn-hooks` directly.
     */
    readonly runPhase1: (input: {
      readonly rolloutText: string
      readonly source: SextupleSource
      readonly projectID?: string
      readonly model?: Phase1Model
      readonly timeoutMs?: number
    }) => Effect.Effect<RunPhase1Result>
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

      enrichPrompt: (input) =>
        // Defer construction of `Memory.Interface` here to avoid a self-
        // referential capture cycle: turn-hooks reaches into `memory.retrieve`,
        // and that closure wraps `embedder` + `retrieval` from the outer
        // scope. We rebuild a lightweight wrapper that mirrors the public
        // `retrieve`/`retrieveByEmbedding` so enrichment can run without
        // routing back through this same factory.
        enrichUserPromptWithMemories({
          ...input,
          memory: {
            // Only `retrieve` is exercised by the enrichment path; the rest
            // are wired so the type-check passes and unexpected callers
            // surface as a defect rather than silent no-ops.
            add: () => Effect.die("Memory.enrichPrompt → add not allowed"),
            addWithoutEmbedding: () =>
              Effect.die("Memory.enrichPrompt → addWithoutEmbedding not allowed"),
            embed: () => Effect.die("Memory.enrichPrompt → embed not allowed"),
            get: (hashId) => storage.getByHash(hashId),
            listByProject: (projectID, limit) => storage.listByProject(projectID, limit),
            retrieve: ({ queryText, projectID, topK, minScore }) =>
              Effect.gen(function* () {
                const queryEmbedding = yield* embedder.embed(queryText)
                return yield* retrieval.retrieve({ queryEmbedding, projectID, topK, minScore })
              }),
            retrieveByEmbedding: (i) => retrieval.retrieve(i),
            enrichPrompt: () =>
              Effect.die("Memory.enrichPrompt → enrichPrompt recursion not allowed"),
            runPhase1: () => Effect.die("Memory.enrichPrompt → runPhase1 not allowed"),
          },
        }),

      runPhase1: (input) =>
        // Build a thin façade that exposes only `add` (the pipeline never
        // calls anything else); same self-referential rationale as above.
        runPhase1Impl(
          {
            add: (i) =>
              Effect.gen(function* () {
                const { inserted, record } = yield* storage.store(i)
                if (!inserted && record.embedding) {
                  return { inserted: false, embedded: true, record }
                }
                yield* embedOne(record)
                return { inserted, embedded: true, record }
              }),
            addWithoutEmbedding: () =>
              Effect.die("Memory.runPhase1 → addWithoutEmbedding not allowed"),
            embed: () => Effect.die("Memory.runPhase1 → embed not allowed"),
            get: (hashId) => storage.getByHash(hashId),
            listByProject: () => Effect.die("Memory.runPhase1 → listByProject not allowed"),
            retrieve: () => Effect.die("Memory.runPhase1 → retrieve not allowed"),
            retrieveByEmbedding: () =>
              Effect.die("Memory.runPhase1 → retrieveByEmbedding not allowed"),
            enrichPrompt: () => Effect.die("Memory.runPhase1 → enrichPrompt not allowed"),
            runPhase1: () => Effect.die("Memory.runPhase1 → runPhase1 recursion not allowed"),
          },
          input,
        ),
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

// Round-2 surfaces.
export {
  synthesizeMemoryQuery,
  buildQueryPrompt,
  parseQueryResponse,
  fallbackQuery,
  regexKeywordQuery,
  truncateWithEllipsis,
} from "./query-synth"
export type { SynthesizeModel, SynthesizeMemoryQueryInput, SynthesizeMemoryQueryResult } from "./query-synth"
export {
  scoreCandidate,
  refineSextuple,
  buildRefiningPrompt,
  parseRefiningResponse,
  toSextupleInput,
  objectiveSignal,
  sentimentSignal,
  circlesSignal,
  momentumSignal,
  tokenize,
  SCORE_KEEP_THRESHOLD,
} from "./refining"
export type { RefiningInput, RefiningCandidate, RefinedOutput, SuccessScore, RefiningModel } from "./refining"
export {
  buildPhase1Prompt,
  parsePhase1Response,
  buildSextupleInputs,
  tailBiasedTruncate,
  sanitizeJsonControlChars,
  redactSecrets,
  runPhase1,
  PHASE1_SYSTEM_PROMPT,
} from "./phase1"
export type { Phase1Model, Phase1Response, RunPhase1Input, RunPhase1Result } from "./phase1"
export {
  buildRerankPrompt,
  parseRerankResponse,
  mergeScores,
  filterAndSort,
  rerank,
  RERANK_BATCH_LIMIT,
  STAGE1_WEIGHT,
  STAGE2_WEIGHT,
  DEFAULT_MIN_SCORE,
} from "./rerank"
export type { RerankInput, RerankResult, RerankModel } from "./rerank"
export {
  enrichUserPromptWithMemories,
  extractAndRefineTurnSextuples,
  formatSimilarProblemsBlock,
  truncateChars,
  isInjectedContextFragment,
  pickRecentUserMessages,
  buildTurnRolloutText,
  registerMemoryTurnObserver,
  dequeueEnrichmentBlock,
  ENRICHMENT_SCRATCH_KEY,
  DEFAULT_HOOKS_CONFIG,
  DEFAULT_RETRIEVAL_TOP_K,
  FIELD_CHAR_LIMIT,
} from "./turn-hooks"
export type {
  EnrichUserPromptInput,
  EnrichUserPromptResult,
  ExtractAndRefineInput,
  ExtractAndRefineResult,
  MemoryHooksConfig,
  MemoryTurnObserverOptions,
} from "./turn-hooks"

// Round-3 surfaces.
export {
  autoTrigger,
  autoTriggerOnBootstrap,
  autoTriggerMarkerPath,
  readLastTriggerAt,
  writeLastTriggerAt,
  NOOP_POLISHER,
  AUTO_TRIGGER_COOLDOWN_MS,
  AUTO_TRIGGER_COMMIT_LIMIT,
} from "./auto-trigger"
export type { AutoTriggerInput, AutoTriggerResult } from "./auto-trigger"
