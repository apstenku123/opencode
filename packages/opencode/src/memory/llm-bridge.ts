/**
 * Memory LLM bridge — resolves a `Phase1Model` / `SynthesizeModel` /
 * `RerankModel` / `RefiningModel` from a provider/model identifier string,
 * returning a one-shot `(prompt: string) => Effect<string | null>` callback
 * compatible with every memory sub-module that needs an LLM call.
 *
 * The bridge uses `generateText` from the `ai` package against a
 * `LanguageModelV3` resolved via `Provider.getLanguage(model)`. We keep the
 * surface deliberately narrow so the memory pipeline stays decoupled from
 * `LLM.Service` (which is streaming-first + tool-aware + permission-aware —
 * overkill for the plain-text "prompt in → JSON out" contract our
 * extractor / query-synth / rerank / refining modules need).
 *
 * Usage:
 *
 *   const bridge = yield* makePhase1Bridge("openai/gpt-4.1")
 *   if (bridge) yield* memory.extractFromTurn({ ..., extractionModel: bridge })
 *
 * When the provider/model cannot be resolved (auth missing, model unknown,
 * config empty) `makePhase1Bridge` returns `undefined` so the caller can
 * fall through to the memory subsystem's no-model short-circuit without
 * raising.
 */

import { Effect } from "effect"
import { generateText } from "ai"

import { Provider } from "@/provider"
import type { Phase1Model } from "./phase1"
import type { SynthesizeModel } from "./query-synth"
import type { RerankModel } from "./rerank"
import type { RefiningModel } from "./refining"

/** Per-call deadline for a memory-side one-shot LLM call (ms). Kept
 * generous because Phase-1 on a 32 KiB rollout can take a minute. */
export const MEMORY_LLM_TIMEOUT_MS = 90_000

/** Common options threaded through the low-level `generateText` call. */
export interface MemoryBridgeOptions {
  /** Provider/model pair in `"providerID/modelID"` form (e.g. `"openai/gpt-4.1"`). */
  readonly modelSpec: string
  /** Optional per-call sampling temperature. Default 0.2 — low so JSON
   *  output stays well-formed. */
  readonly temperature?: number
  /** Optional max-tokens cap on the generated response. */
  readonly maxOutputTokens?: number
}

/**
 * Build a one-shot prompt-to-text bridge using the `ai` SDK's
 * `generateText`. Returns `undefined` when the provider/model cannot be
 * resolved — callers treat that as "no LLM configured" and short-circuit
 * to the deterministic fallback path.
 *
 * NB: the returned Effect depends on `Provider.Service`; callers that want
 * a bare `(prompt) => Effect` with no Requirements must first provide the
 * layer themselves (e.g. `.pipe(Effect.provide(Provider.defaultLayer))`).
 * For the observer wiring path we do this at layer-build time.
 */
export const makeMemoryBridge = (
  opts: MemoryBridgeOptions,
): Effect.Effect<Phase1Model | undefined, never, Provider.Service> =>
  Effect.gen(function* () {
    const spec = opts.modelSpec.trim()
    if (!spec) return undefined
    const provider = yield* Provider.Service
    const { providerID, modelID } = Provider.parseModel(spec)
    // Resolve the model info + language model up-front so the bridge
    // closure never needs Provider.Service in its dependency set.
    const info = yield* provider
      .getModel(providerID, modelID)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined as never)))
    if (!info) return undefined
    const language = yield* provider
      .getLanguage(info)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined as never)))
    if (!language) return undefined

    const bridge: Phase1Model = (prompt: string) =>
      Effect.tryPromise({
        try: async () => {
          const res = await generateText({
            model: language,
            prompt,
            temperature: opts.temperature ?? 0.2,
            maxOutputTokens: opts.maxOutputTokens,
          })
          const text = (res.text ?? "").trim()
          return text.length > 0 ? text : null
        },
        catch: (err) => err,
      }).pipe(
        Effect.catchCause((c) => {
          // Surface failures only when the debug env var is set — memory
          // bridges degrade silently by design so a missing model doesn't
          // block the main turn loop.
          if (process.env.OPENCODE_MEMORY_BRIDGE_DEBUG === "1") {
            process.stderr.write(`[llm-bridge] generateText failed: ${String(c)}\n`)
          }
          return Effect.succeed(null as string | null)
        }),
      )

    return bridge
  })

/**
 * Sibling alias — the bridge shape is compatible with every memory
 * sub-module's model-callback type. Re-exported separately so callers can
 * state intent at the call-site.
 */
export const makePhase1Bridge = makeMemoryBridge
export const makeSynthesizeBridge = makeMemoryBridge as (
  opts: MemoryBridgeOptions,
) => Effect.Effect<SynthesizeModel | undefined, never, Provider.Service>
export const makeRerankBridge = makeMemoryBridge as (
  opts: MemoryBridgeOptions,
) => Effect.Effect<RerankModel | undefined, never, Provider.Service>
export const makeRefiningBridge = makeMemoryBridge as (
  opts: MemoryBridgeOptions,
) => Effect.Effect<RefiningModel | undefined, never, Provider.Service>
