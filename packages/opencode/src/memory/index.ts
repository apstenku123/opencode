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
import { EmbeddingService, mockLayer as mockEmbeddingLayerImpl } from "./embedding"
import { layer as storageLayerImpl } from "./storage"
import { layer as retrievalLayerImpl } from "./retrieval"
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
  extractAndRefineTurnSextuples,
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

    /**
     * Convenience wrapper — given a sessionID + raw user text, synthesize
     * the `<similar_past_problems>` block (if any) using the default
     * retrieval knobs. Shorter signature intended for in-process callers
     * (session/prompt.ts turn loop, tests). Never throws; on any miss the
     * `block` field is `null`.
     */
    readonly enrichPromptForSession: (
      sessionID: string,
      text: string,
      options?: {
        readonly projectID?: string
        readonly topK?: number
        readonly minScore?: number
      },
    ) => Effect.Effect<EnrichUserPromptResult>

    /**
     * Convenience wrapper for the post-turn extractor. Accepts a flat
     * list of `{ role, text }` turn events (most-recent-last) — assistant
     * entries are concatenated to form the turn summary, user entries
     * are forwarded as the recent-user-messages window.
     */
    readonly extractFromTurn: (input: {
      readonly turnEvents: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>
      readonly source: SextupleSource
      readonly projectID?: string
      readonly extractionModel?: Phase1Model
      readonly polishModel?: import("./refining").RefiningModel
    }) => Effect.Effect<import("./turn-hooks").ExtractAndRefineResult>
  }
}

export class Memory extends Context.Service<Memory, Memory.Interface>()("@opencode/memory/Memory") {}

// Re-exported below (see "Re-exports"); declared here so `defaultLayer`
// can reference it without introducing a circular import at parse time.
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

    const addImpl = (input: DefectSextupleInput) =>
      Effect.gen(function* () {
        const { inserted, record } = yield* storage.store(input)
        if (!inserted && record.embedding) {
          return { inserted: false, embedded: true, record }
        }
        yield* embedOne(record)
        return { inserted, embedded: true, record }
      })

    // Build a Memory.Interface-shaped sub-facade used by `enrichPrompt` /
    // `runPhase1` / `extractFromTurn` to avoid a self-referential capture
    // cycle. The sub-facade exposes only the calls the pipeline needs
    // (retrieval, storage peeks, `add`); everything else is wired to
    // `Effect.die` so misuse surfaces loudly.
    const subFacade = (tag: string): Memory.Interface => ({
      add: (i) => addImpl(i),
      addWithoutEmbedding: () => Effect.die(`${tag}: addWithoutEmbedding not allowed`),
      embed: () => Effect.die(`${tag}: embed not allowed`),
      get: (hashId) => storage.getByHash(hashId),
      listByProject: (projectID, limit) => storage.listByProject(projectID, limit),
      retrieve: ({ queryText, projectID, topK, minScore }) =>
        Effect.gen(function* () {
          const queryEmbedding = yield* embedder.embed(queryText)
          return yield* retrieval.retrieve({ queryEmbedding, projectID, topK, minScore })
        }),
      retrieveByEmbedding: (i) => retrieval.retrieve(i),
      enrichPrompt: () => Effect.die(`${tag}: enrichPrompt recursion not allowed`),
      runPhase1: () => Effect.die(`${tag}: runPhase1 recursion not allowed`),
      enrichPromptForSession: () =>
        Effect.die(`${tag}: enrichPromptForSession recursion not allowed`),
      extractFromTurn: () => Effect.die(`${tag}: extractFromTurn recursion not allowed`),
    })

    return {
      add: addImpl,

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
        enrichUserPromptWithMemories({ ...input, memory: subFacade("Memory.enrichPrompt") }),

      runPhase1: (input) => runPhase1Impl(subFacade("Memory.runPhase1"), input),

      enrichPromptForSession: (_sessionID, text, options) =>
        enrichUserPromptWithMemories({
          memory: subFacade("Memory.enrichPromptForSession"),
          userPrompt: text,
          projectID: options?.projectID,
          topK: options?.topK,
          minScore: options?.minScore,
        }),

      extractFromTurn: (input) => {
        // Split turn events into assistant summary + recent user-messages
        // window, then hand off to the refining pipeline.
        const assistant = input.turnEvents
          .filter((e) => e.role === "assistant")
          .map((e) => e.text.trim())
          .filter(Boolean)
        const users = input.turnEvents
          .filter((e) => e.role === "user")
          .map((e) => e.text.trim())
          .filter(Boolean)
        return extractAndRefineTurnSextuples({
          memory: subFacade("Memory.extractFromTurn"),
          turnSummary: assistant.join("\n"),
          recentUserMessages: users,
          source: input.source,
          projectID: input.projectID,
          extractionModel: input.extractionModel,
          polishModel: input.polishModel,
        })
      },
    }
  }),
)

/**
 * Default, self-contained Memory layer suitable for `AppLayer`.
 *
 * Bundles:
 *   - `MemoryStorage.layer` (SQLite-backed CRUD)
 *   - `MemoryRetrieval.layer` (cosine ranker)
 *   - `mockEmbeddingLayer` (deterministic hash embeddings — safe no-LLM default)
 *   - `Memory.layer` (facade)
 *
 * The mock embedding layer is a deliberate default: round-3 keeps memories
 * OFF by default (`memories.enabled=false`) so the embedding backend is
 * effectively unused until a user opts in. When an embedding provider is
 * configured via `openAICompatLayer` it can be substituted by replacing
 * this layer at `AppLayer` composition time.
 */
export const defaultLayer: Layer.Layer<Memory | MemoryStorage | MemoryRetrieval | EmbeddingService> = Layer.suspend(
  () => {
    const deps = Layer.mergeAll(storageLayerImpl, mockEmbeddingLayerImpl())
    const retrieval = Layer.provide(retrievalLayerImpl, storageLayerImpl)
    const facade = Layer.provide(layer, Layer.mergeAll(deps, retrieval))
    return Layer.mergeAll(deps, retrieval, facade)
  },
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
