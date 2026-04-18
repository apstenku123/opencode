/**
 * Turn-loop hooks for memory enrichment + extraction.
 *
 * Port of `codex-rs/core/src/memories/turn_hooks.rs`. Two responsibilities:
 *
 *   1. **Pre-iteration enrichment** (`enrichUserPromptWithMemories`): given a
 *      user prompt, synthesize a retrieval query, run the (optional) two-
 *      stage retrieval (cosine + LLM rerank), and format the top hits into
 *      a `<similar_past_problems>...</similar_past_problems>` block ready
 *      to be prepended to the user message. Best-effort — any failure
 *      returns `null` so the turn loop never blocks on a memory miss.
 *
 *   2. **Post-iteration extraction** (`extractAndRefineTurnSextuples`):
 *      given the assistant text + recent user messages, run the Phase-1
 *      LLM extractor + refining gate to produce a list of refined
 *      sextuples. Caller persists them via `Memory.add`.
 *
 * The S8 `AdaptiveHooks` plumbing (`packages/opencode/src/session/adaptive.ts`)
 * is the integration surface. `registerMemoryTurnObserver` builds an
 * `AdaptiveHooks.Observer` that the session-prompt layer registers at
 * boot when memories are enabled. The observer's `preIteration` hook
 * caches the synthesized block on `AdaptiveState.scratch` so the loop
 * code (which controls how user-message text is mutated) can pick it up
 * via `dequeueEnrichmentBlock(state)` during message assembly.
 *
 * NB: the round-2 wiring is intentionally non-mutating from the observer's
 * perspective — the observer prepares the block but does not directly
 * rewrite the in-flight `MessageV2.User` parts. That mutation lives in
 * the session-prompt layer (one place, easy to audit) and is gated on
 * `state.scratch[ENRICHMENT_SCRATCH_KEY]` being present. Round-3 will
 * harden this with a dedicated AdaptiveHooks `inject` directive variant.
 */

import { Effect } from "effect"

import { AdaptiveHooks, type AdaptiveState } from "@/session/adaptive"
import type { Memory } from "./index"
import { synthesizeMemoryQuery, type SynthesizeModel } from "./query-synth"
import { rerank, type RerankModel } from "./rerank"
import { runPhase1, type Phase1Model } from "./phase1"
import {
  refineSextuple,
  type RefiningInput,
  type RefiningCandidate,
  type RefinedOutput,
  type RefiningModel,
} from "./refining"
import type { HybridWeights, RetrievalMode, ScoredSextuple } from "./retrieval"
import type { DefectSextupleInput, SextupleSource } from "./schema"

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Default top-K hits to surface in the enrichment block. */
export const DEFAULT_RETRIEVAL_TOP_K = 5
/** Hard cap on each rendered field in the enrichment block. */
export const FIELD_CHAR_LIMIT = 280
/** Recent user messages window forwarded to the post-turn extractor. */
export const LIVE_TURN_RECENT_USER_MESSAGES_LIMIT = 4
/** Scratch-key the observer writes the rendered enrichment block under. */
export const ENRICHMENT_SCRATCH_KEY = "memories.enrichmentBlock"

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

/** Truncate `s` to at most `maxChars` UTF-16 units, appending "..." if cut. */
export function truncateChars(s: string, maxChars = FIELD_CHAR_LIMIT): string {
  if (maxChars <= 0) return ""
  const trimmed = s.trim()
  if (trimmed.length <= maxChars) return trimmed
  if (maxChars <= 3) return trimmed.slice(0, maxChars)
  return trimmed.slice(0, maxChars - 3) + "..."
}

/** Render the top retrieval hits as a compact `<similar_past_problems>` block. */
export function formatSimilarProblemsBlock(hits: ReadonlyArray<ScoredSextuple>): string {
  if (hits.length === 0) return ""
  const lines: string[] = ["<similar_past_problems>"]
  hits.forEach((hit, idx) => {
    const sx = hit.record
    lines.push(
      `${idx + 1}. PROBLEM: ${truncateChars(sx.problem)}\n   ROOT CAUSE: ${truncateChars(sx.rootCause)}\n   SOLUTION: ${truncateChars(sx.solution)}`,
    )
  })
  lines.push("</similar_past_problems>")
  return lines.join("\n")
}

/**
 * Drop synthetic fragments the observer itself injects (so subsequent turns
 * don't round-trip the enrichment block back through the extractor).
 */
export function isInjectedContextFragment(text: string): boolean {
  if (!text) return false
  return text.includes("<turn_aborted>") || text.includes("<similar_past_problems>")
}

/**
 * Filter recent user messages down to the budget consumed by the post-turn
 * extractor. Drops empties, drops the injected enrichment / abort context,
 * and clamps to `limit` most-recent entries.
 */
export function pickRecentUserMessages(
  messages: ReadonlyArray<string>,
  limit = LIVE_TURN_RECENT_USER_MESSAGES_LIMIT,
): string[] {
  const cleaned = messages.filter((m) => m.trim().length > 0 && !isInjectedContextFragment(m))
  if (cleaned.length <= limit) return cleaned.slice()
  return cleaned.slice(cleaned.length - limit)
}

// --------------------------------------------------------------------------
// Pre-iteration: build enrichment block
// --------------------------------------------------------------------------

export interface EnrichUserPromptInput {
  readonly memory: Memory.Interface
  readonly userPrompt: string
  /** Optional project scoping forwarded to retrieval. */
  readonly projectID?: string
  /** Optional cwd-context blob forwarded to query synthesis. */
  readonly cwdContext?: string
  /** Top-K hits to surface (default `DEFAULT_RETRIEVAL_TOP_K`). */
  readonly topK?: number
  /** Cosine-merged minScore floor (default `0.4`). */
  readonly minScore?: number
  /** Synthesize-query LLM bridge (omit ⇒ regex/fallback). */
  readonly querySynthModel?: SynthesizeModel
  /** Stage-2 rerank LLM bridge (omit ⇒ skip stage-2). */
  readonly rerankModel?: RerankModel
  /**
   * Stage-1 retrieval mode. Default `"hybrid"` — blends BM25 + cosine. Use
   * `"cosine"` to preserve round-1 semantics; `"bm25"` for lex-only (no
   * embedding provider needed).
   */
  readonly retrievalMode?: RetrievalMode
  /** Hybrid blend weights (only meaningful when `retrievalMode === "hybrid"`). */
  readonly retrievalWeights?: HybridWeights
}

export interface EnrichUserPromptResult {
  /** Rendered `<similar_past_problems>` block, or `null` when retrieval is empty. */
  readonly block: string | null
  /** Synthesized query that was used for retrieval. */
  readonly query: string
  /** Stage-1 hits (pre-rerank) — exposed for telemetry / tests. */
  readonly stage1: ReadonlyArray<ScoredSextuple>
  /** Stage-2 (post-rerank, post-filter) hits. */
  readonly hits: ReadonlyArray<ScoredSextuple>
  readonly reason:
    | "empty-prompt"
    | "empty-query"
    | "stage1-empty"
    | "stage2-empty"
    | "ok"
}

/**
 * Best-effort enrichment: never throws; on any miss returns
 * `{ block: null, ... }` so the caller can leave the user message untouched.
 */
export function enrichUserPromptWithMemories(
  input: EnrichUserPromptInput,
): Effect.Effect<EnrichUserPromptResult> {
  return Effect.gen(function* () {
    if (!input.userPrompt.trim()) {
      return {
        block: null,
        query: "",
        stage1: [],
        hits: [],
        reason: "empty-prompt" as const,
      }
    }
    const synth = yield* synthesizeMemoryQuery({
      userPrompt: input.userPrompt,
      cwdContext: input.cwdContext,
      model: input.querySynthModel,
    })
    if (!synth.query.trim()) {
      return {
        block: null,
        query: "",
        stage1: [],
        hits: [],
        reason: "empty-query" as const,
      }
    }
    const topK = input.topK ?? DEFAULT_RETRIEVAL_TOP_K
    // Stage-1: pull a pool of `topK * 4` candidates so the rerank stage has
    // room to re-order. Match Rust's STAGE1_POOL_MULTIPLIER behavior.
    // `minScore = -1` for cosine so negative cosines still feed the rerank;
    // hybrid + bm25 modes produce non-negative scores so the floor is a no-op
    // for them but we pass it through uniformly for consistency.
    const mode: RetrievalMode = input.retrievalMode ?? "hybrid"
    const stage1 = yield* input.memory
      .retrieve({
        queryText: synth.query,
        projectID: input.projectID,
        topK: topK * 4,
        minScore: mode === "cosine" ? -1 : 0,
        mode,
        weights: input.retrievalWeights,
      })
      .pipe(Effect.catchCause(() => Effect.succeed([] as ScoredSextuple[])))
    if (stage1.length === 0) {
      return {
        block: null,
        query: synth.query,
        stage1: [],
        hits: [],
        reason: "stage1-empty" as const,
      }
    }
    const reranked = yield* rerank({
      query: synth.query,
      stage1,
      model: input.rerankModel,
      minScore: input.minScore,
      topK,
    })
    if (reranked.hits.length === 0) {
      return {
        block: null,
        query: synth.query,
        stage1,
        hits: [],
        reason: "stage2-empty" as const,
      }
    }
    return {
      block: formatSimilarProblemsBlock(reranked.hits),
      query: synth.query,
      stage1,
      hits: reranked.hits,
      reason: "ok" as const,
    }
  })
}

// --------------------------------------------------------------------------
// Post-iteration: extract + refine + persist
// --------------------------------------------------------------------------

export interface ExtractAndRefineInput {
  readonly memory: Memory.Interface
  /** Concatenated assistant + tool turn text. Empty ⇒ short-circuit. */
  readonly turnSummary: string
  readonly recentUserMessages: ReadonlyArray<string>
  readonly source: SextupleSource
  readonly projectID?: string
  /** Phase-1 LLM bridge (omit ⇒ extraction skipped entirely). */
  readonly extractionModel?: Phase1Model
  /** Optional polish LLM bridge for the refining stage. */
  readonly polishModel?: RefiningModel
}

export interface ExtractAndRefineResult {
  /** Sextuples that cleared the gate AND were successfully persisted. */
  readonly persisted: ReadonlyArray<{ readonly hashId: string; readonly inserted: boolean }>
  /** Per-candidate refining outputs (incl. gate rejections) for telemetry. */
  readonly outputs: ReadonlyArray<RefinedOutput>
  readonly reason:
    | "extraction-disabled"
    | "empty-turn"
    | "no-extraction-model"
    | "no-candidates"
    | "ok"
}

/**
 * Run the post-turn extractor + refining gate. Best-effort: any failure
 * collapses to an empty `persisted` list and never throws.
 */
export function extractAndRefineTurnSextuples(
  input: ExtractAndRefineInput,
): Effect.Effect<ExtractAndRefineResult> {
  return Effect.gen(function* () {
    if (!input.turnSummary.trim()) {
      return { persisted: [], outputs: [], reason: "empty-turn" as const }
    }
    if (!input.extractionModel) {
      return { persisted: [], outputs: [], reason: "no-extraction-model" as const }
    }

    // Phase-1 returns DefectSextupleInputs — but we want to refine them
    // BEFORE persistence. So we run the phase-1 prompt with a stub `memory`
    // that captures inputs without storing them. Easier path: parse the
    // raw response ourselves via a thin shim; but the cleanest reuse is to
    // run `runPhase1` end-to-end and then re-refine each persisted record.
    // For round-2 we keep the layering simple: gate first, persist second.
    const phase1 = yield* runPhase1(
      // Provide a no-op memory façade so phase-1 doesn't touch storage yet.
      noopMemory(),
      {
        rolloutText: buildTurnRolloutText(input.turnSummary, input.recentUserMessages),
        source: input.source,
        projectID: input.projectID,
        model: input.extractionModel,
      },
    )
    if (phase1.inputs.length === 0) {
      return { persisted: [], outputs: [], reason: "no-candidates" as const }
    }

    const recent = pickRecentUserMessages(input.recentUserMessages)
    const outputs: RefinedOutput[] = []
    const persisted: { hashId: string; inserted: boolean }[] = []

    for (const candidateInput of phase1.inputs) {
      const refiningInput: RefiningInput = {
        candidate: {
          keywords: candidateInput.keywords,
          problem: candidateInput.problem,
          rootCause: candidateInput.rootCause,
          solution: candidateInput.solution,
        } satisfies RefiningCandidate,
        recentUserMessages: recent,
        tailSummary: input.turnSummary,
      }
      const refined = yield* refineSextuple(refiningInput, {
        model: input.polishModel,
      })
      outputs.push(refined)
      if (!refined.refined) continue
      const persistInput: DefectSextupleInput = {
        keywords: refined.refined.keywords,
        problem: refined.refined.problem,
        rootCause: refined.refined.rootCause,
        solution: refined.refined.solution,
        source: candidateInput.source,
        projectID: candidateInput.projectID,
      }
      const stored = yield* input.memory.add(persistInput).pipe(
        Effect.match({
          onSuccess: (r) => ({ hashId: r.record.hashId, inserted: r.inserted }),
          onFailure: () => null,
        }),
      )
      if (stored) persisted.push(stored)
    }
    return { persisted, outputs, reason: "ok" as const }
  })
}

/** Compose a synthetic "rollout text" the Phase-1 extractor can ingest. */
export function buildTurnRolloutText(
  turnSummary: string,
  recentUserMessages: ReadonlyArray<string>,
): string {
  const recent = pickRecentUserMessages(recentUserMessages)
  if (recent.length === 0) return turnSummary
  const userBlock = recent.map((m, i) => `[user ${i + 1}] ${m.trim()}`).join("\n")
  return `${userBlock}\n\n[assistant turn]\n${turnSummary}`
}

// --------------------------------------------------------------------------
// AdaptiveHooks observer registration
// --------------------------------------------------------------------------

export interface MemoryTurnObserverOptions {
  readonly memory: Memory.Interface
  /**
   * Resolve the most-recent user prompt for a given session id. Wired in
   * `session/prompt.ts` to the in-flight `lastUser` text. When this returns
   * `null` the observer skips enrichment.
   */
  readonly resolveUserPrompt: (sessionID: string) => Effect.Effect<string | null>
  /**
   * Resolve the most-recent assistant turn text + recent user messages for
   * the post-turn extractor. Returning `null` skips extraction.
   */
  readonly resolveTurn: (
    sessionID: string,
  ) => Effect.Effect<{ readonly turnSummary: string; readonly recentUserMessages: ReadonlyArray<string> } | null>
  readonly source: (sessionID: string) => Effect.Effect<SextupleSource>
  readonly projectID?: (sessionID: string) => Effect.Effect<string | undefined>
  /** Returns runtime config — checked on every fire so toggles take effect mid-session. */
  readonly config: () => Effect.Effect<MemoryHooksConfig>
  readonly querySynthModel?: SynthesizeModel
  readonly rerankModel?: RerankModel
  readonly extractionModel?: Phase1Model
  readonly polishModel?: RefiningModel
}

export interface MemoryHooksConfig {
  readonly enabled: boolean
  readonly retrievalEnabled: boolean
  readonly extractionEnabled: boolean
  readonly rerankEnabled: boolean
  readonly retrievalTopK: number
  readonly retrievalMinScore: number
  /**
   * Stage-1 retrieval mode: `"cosine"` (round-1 default), `"bm25"`, or
   * `"hybrid"` (default in S8 — blends BM25 + embedding).
   */
  readonly retrievalMode: RetrievalMode
  /** Hybrid blend weights; applied when `retrievalMode === "hybrid"`. */
  readonly retrievalBm25Weight: number
  readonly retrievalEmbeddingWeight: number
}

export const DEFAULT_HOOKS_CONFIG: MemoryHooksConfig = {
  enabled: false,
  retrievalEnabled: false,
  extractionEnabled: true,
  rerankEnabled: true,
  retrievalTopK: DEFAULT_RETRIEVAL_TOP_K,
  retrievalMinScore: 0.4,
  retrievalMode: "hybrid",
  retrievalBm25Weight: 0.4,
  retrievalEmbeddingWeight: 0.6,
}

/**
 * Build an `AdaptiveHooks.Observer` that wires the memory enrichment +
 * extraction hooks into the session-prompt loop. The observer is
 * idempotent and safe to register multiple times (the loop runs each
 * registration once); callers should store the unregister function and
 * call it on shutdown.
 */
const MEMORY_DBG = process.env.OPENCODE_MEMORY_OBSERVER_DEBUG === "1"
const memdbg = (msg: string) => {
  if (MEMORY_DBG) process.stderr.write(`[memory.observer] ${msg}\n`)
}

export function registerMemoryTurnObserver(opts: MemoryTurnObserverOptions): AdaptiveHooks.Observer {
  return {
    name: "memories",
    preIteration: (state, args) =>
      Effect.gen(function* () {
        const cfg = yield* opts.config()
        memdbg(`preIteration: enabled=${cfg.enabled} retrievalEnabled=${cfg.retrievalEnabled} sessionID=${args.sessionID}`)
        if (!cfg.enabled || !cfg.retrievalEnabled) {
          dequeueEnrichmentBlock(state)
          return
        }
        const userPrompt = yield* opts.resolveUserPrompt(args.sessionID)
        if (!userPrompt || !userPrompt.trim()) {
          dequeueEnrichmentBlock(state)
          return
        }
        const projectID = opts.projectID ? yield* opts.projectID(args.sessionID) : undefined
        const result = yield* enrichUserPromptWithMemories({
          memory: opts.memory,
          userPrompt,
          projectID,
          topK: cfg.retrievalTopK,
          minScore: cfg.retrievalMinScore,
          querySynthModel: opts.querySynthModel,
          rerankModel: cfg.rerankEnabled ? opts.rerankModel : undefined,
          retrievalMode: cfg.retrievalMode,
          retrievalWeights: {
            bm25Weight: cfg.retrievalBm25Weight,
            embeddingWeight: cfg.retrievalEmbeddingWeight,
          },
        })
        if (result.block) {
          state.scratch[ENRICHMENT_SCRATCH_KEY] = result.block
        } else {
          dequeueEnrichmentBlock(state)
        }
      }).pipe(Effect.catchCause(() => Effect.void)),
    postIteration: (_state, args) =>
      Effect.gen(function* () {
        const cfg = yield* opts.config()
        memdbg(
          `postIteration: enabled=${cfg.enabled} extractionEnabled=${cfg.extractionEnabled} sessionID=${args.sessionID} extractionModel=${!!opts.extractionModel}`,
        )
        if (!cfg.enabled || !cfg.extractionEnabled) return AdaptiveHooks.Continue
        const turn = yield* opts.resolveTurn(args.sessionID)
        memdbg(
          `postIteration: resolveTurn=${turn ? `summary=${turn.turnSummary.length}ch userMsgs=${turn.recentUserMessages.length}` : "null"}`,
        )
        if (!turn || !turn.turnSummary.trim()) return AdaptiveHooks.Continue
        const source = yield* opts.source(args.sessionID)
        const projectID = opts.projectID ? yield* opts.projectID(args.sessionID) : undefined
        // Run extraction in the background — never block the loop.
        yield* extractAndRefineTurnSextuples({
          memory: opts.memory,
          turnSummary: turn.turnSummary,
          recentUserMessages: turn.recentUserMessages,
          source,
          projectID,
          extractionModel: opts.extractionModel,
          polishModel: opts.polishModel,
        })
          .pipe(
            Effect.tap((r) =>
              Effect.sync(() =>
                memdbg(
                  `extractAndRefineTurnSextuples: reason=${r?.reason} persisted=${r?.persisted?.length ?? "?"} outputs=${r?.outputs?.length ?? "?"}`,
                ),
              ),
            ),
            Effect.catchCause((c) =>
              Effect.sync(() =>
                memdbg(`extractAndRefineTurnSextuples failed: ${String(c).slice(0, 500)}`),
              ),
            ),
            Effect.forkDetach,
          )
        return AdaptiveHooks.Continue as AdaptiveHooks.Directive
      }).pipe(Effect.catchCause((c) =>
        Effect.sync(() => {
          memdbg(`postIteration outer fail: ${String(c).slice(0, 500)}`)
          return AdaptiveHooks.Continue as AdaptiveHooks.Directive
        }),
      )),
  }
}

/**
 * Pop the most recent enrichment block from `AdaptiveState.scratch`.
 * Returns `null` when no block was queued. Idempotent: subsequent calls
 * within the same iteration return `null` until the observer fires
 * `preIteration` again.
 */
export function dequeueEnrichmentBlock(state: AdaptiveState.Value): string | null {
  const v = state.scratch[ENRICHMENT_SCRATCH_KEY]
  if (typeof v !== "string" || !v) {
    delete state.scratch[ENRICHMENT_SCRATCH_KEY]
    return null
  }
  delete state.scratch[ENRICHMENT_SCRATCH_KEY]
  return v
}

/** No-op `Memory.Interface` used internally to short-circuit the
 * `runPhase1` storage path while still exercising its prompt/parse logic. */
function noopMemory(): Memory.Interface {
  // We type-cast the partial implementation: only `add` is exercised by
  // the post-turn extractor (every other method is stubbed to `Effect.die`
  // because it should never be called from here).
  return {
    add: (input) =>
      Effect.succeed({
        inserted: false,
        embedded: false,
        record: {
          id: "noop",
          hashId: "noop",
          keywords: input.keywords,
          problem: input.problem,
          rootCause: input.rootCause,
          solution: input.solution,
          source: input.source,
          projectID: input.projectID,
          timeCreated: 0,
          timeUpdated: 0,
        } as Memory.AddResult["record"],
      } as Memory.AddResult),
    addWithoutEmbedding: () =>
      Effect.die("noopMemory.addWithoutEmbedding called from turn-hooks") as never,
    embed: () => Effect.die("noopMemory.embed called from turn-hooks") as never,
    get: () => Effect.die("noopMemory.get called from turn-hooks") as never,
    listByProject: () => Effect.die("noopMemory.listByProject called from turn-hooks") as never,
    retrieve: () => Effect.die("noopMemory.retrieve called from turn-hooks") as never,
    retrieveByEmbedding: () =>
      Effect.die("noopMemory.retrieveByEmbedding called from turn-hooks") as never,
    enrichPrompt: () => Effect.die("noopMemory.enrichPrompt called from turn-hooks") as never,
    runPhase1: () => Effect.die("noopMemory.runPhase1 called from turn-hooks") as never,
    enrichPromptForSession: () =>
      Effect.die("noopMemory.enrichPromptForSession called from turn-hooks") as never,
    extractFromTurn: () => Effect.die("noopMemory.extractFromTurn called from turn-hooks") as never,
    runPhase1OnTurn: () =>
      Effect.die("noopMemory.runPhase1OnTurn called from turn-hooks") as never,
  }
}
