/**
 * SessionMemoryObserver — wiring layer for the codemem turn-hooks.
 *
 * Round-3 scaffold, round-4 wiring. Mirrors the structural shape of
 * `SessionAutobestObserver` / `SessionAutosteerObserver`: the layer is a
 * marker service whose *build* effect does nothing; actual registration
 * of the `AdaptiveHooks.Observer` happens lazily via `ensureRegistered()`
 * so the `register` call (which touches `InstanceState`) runs inside an
 * active `Instance` scope from the session-prompt runloop.
 *
 * What it wires (round-4):
 *   - Reads `config.memories.*` toggles and forwards them to
 *     `DEFAULT_HOOKS_CONFIG`, so users can opt-in via `opencode.json`.
 *   - Resolves the last user-message text + the recent assistant turn
 *     summary from the live `Session.Service` API (no speculation about
 *     message ids; we walk `messages({ sessionID })` newest-first).
 *   - Resolves a real `Phase1Model` / `RerankModel` / `RefiningModel` /
 *     `SynthesizeModel` from `config.memories.{extractionModel,
 *     rerankModel, polishModel, querySynthModel}` — falling back to the
 *     session's configured default model when the dedicated slot is
 *     empty. Bridges are built through the `Provider.Service` +
 *     `ai.generateText` path (see `memory/llm-bridge.ts`) so the memory
 *     subsystem stays decoupled from the streaming/permission-aware
 *     `LLM.Service` used by the main runLoop.
 *   - Extraction fires fire-and-forget via `Effect.forkDaemon` inside
 *     `turn-hooks.registerMemoryTurnObserver` so a user turn is never
 *     blocked by the Phase-1 extractor round-trip.
 *
 * Safety net: any exception inside the observer collapses to `Continue`
 * (see `registerMemoryTurnObserver` itself). Config-driven toggles make
 * the whole subsystem opt-in, so the default AppLayer pathway is a no-op.
 */

import { Context, Effect, Layer } from "effect"

import { AdaptiveHooks } from "./adaptive"
import { Config } from "@/config"
import { Memory, defaultLayer as memoryDefaultLayer } from "@/memory"
import { makeMemoryBridge } from "@/memory/llm-bridge"
import {
  DEFAULT_HOOKS_CONFIG,
  registerMemoryTurnObserver,
  type MemoryHooksConfig,
  type MemoryTurnObserverOptions,
} from "@/memory/turn-hooks"
import { Provider } from "@/provider"
import { Session } from "./index"
import type { SessionID } from "./schema"
import type { Phase1Model } from "@/memory/phase1"
import type { SynthesizeModel } from "@/memory/query-synth"
import type { RerankModel } from "@/memory/rerank"
import type { RefiningModel } from "@/memory/refining"
import type { SextupleSource } from "@/memory/schema"

export namespace SessionMemoryObserver {
  export interface Interface {
    /**
     * Compute the effective `MemoryHooksConfig` from the current config.
     * Exposed for tests and the `/memory/status` RPC so callers can see
     * what the observer will do without waiting for a turn to fire.
     */
    readonly resolveConfig: () => Effect.Effect<MemoryHooksConfig>
    /**
     * Idempotent registration of the memory turn observer against
     * `AdaptiveHooks`. Safe to call multiple times — subsequent calls are
     * no-ops. Returns void; the observer lives for the lifetime of the
     * `AdaptiveHooks.Service` instance.
     */
    readonly ensureRegistered: () => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()(
    "@opencode/SessionMemoryObserver",
  ) {}

  /**
   * Extract the trailing text content of the most-recent user message (or
   * the most-recent assistant message) as a single newline-joined string.
   */
  function joinText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
    return parts
      .filter((p) => p.type === "text")
      .map((p) => (p.text ?? "").trim())
      .filter(Boolean)
      .join("\n")
  }

  /**
   * Pull the config into a typed `MemoryHooksConfig`. Falls back to
   * `DEFAULT_HOOKS_CONFIG` semantics (memories disabled by default).
   */
  export function buildHooksConfig(cfg: { memories?: Partial<MemoryHooksConfig> } | undefined): MemoryHooksConfig {
    const m = cfg?.memories
    return {
      enabled: m?.enabled ?? DEFAULT_HOOKS_CONFIG.enabled,
      retrievalEnabled: m?.retrievalEnabled ?? DEFAULT_HOOKS_CONFIG.retrievalEnabled,
      extractionEnabled: m?.extractionEnabled ?? DEFAULT_HOOKS_CONFIG.extractionEnabled,
      rerankEnabled: m?.rerankEnabled ?? DEFAULT_HOOKS_CONFIG.rerankEnabled,
      retrievalTopK: m?.retrievalTopK ?? DEFAULT_HOOKS_CONFIG.retrievalTopK,
      retrievalMinScore: m?.retrievalMinScore ?? DEFAULT_HOOKS_CONFIG.retrievalMinScore,
    }
  }

  /**
   * Resolve the effective model spec string for a given memory phase.
   * Falls back to the session's configured default model (`cfg.model`)
   * when the phase-specific slot is empty. Returns `undefined` when
   * neither is set.
   */
  export function resolveModelSpec(
    cfg: { model?: string; memories?: { extractionModel?: string; rerankModel?: string; polishModel?: string; querySynthModel?: string } } | undefined,
    phase: "extraction" | "rerank" | "polish" | "querySynth",
  ): string | undefined {
    const slot =
      phase === "extraction"
        ? cfg?.memories?.extractionModel
        : phase === "rerank"
          ? cfg?.memories?.rerankModel
          : phase === "polish"
            ? cfg?.memories?.polishModel
            : cfg?.memories?.querySynthModel
    if (slot && slot.trim()) return slot.trim()
    // Fallback to the session's default model for extraction / rerank —
    // query synthesis + polish are smaller hops, so leave them unset so
    // the deterministic fallback kicks in rather than burning a heavy
    // model round-trip. Users can opt in per-phase via the config slots.
    if (phase === "extraction" || phase === "rerank") {
      if (cfg?.model && cfg.model.trim()) return cfg.model.trim()
    }
    return undefined
  }

  /**
   * Build the observer options. Factored out so tests can drive the
   * resolver functions directly without standing up a Session service.
   *
   * `deps.bridges` is optional — callers that don't want LLM-backed
   * extraction (tests, minimal embeds) omit it and the observer
   * short-circuits to the no-model fallback inside the memory subsystem.
   */
  export const makeObserverOptions = (deps: {
    readonly memory: Memory.Interface
    readonly session: Session.Interface
    readonly config: Config.Interface
    readonly bridges?: {
      readonly extraction?: Phase1Model
      readonly rerank?: RerankModel
      readonly polish?: RefiningModel
      readonly querySynth?: SynthesizeModel
    }
  }): MemoryTurnObserverOptions => ({
    memory: deps.memory,
    config: () =>
      Effect.gen(function* () {
        const cfg = yield* deps.config.get()
        return buildHooksConfig(cfg)
      }),
    resolveUserPrompt: (sessionID) =>
      Effect.gen(function* () {
        const msgs = yield* deps.session
          .messages({ sessionID: sessionID as SessionID })
          .pipe(Effect.catchCause(() => Effect.succeed([])))
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!
          if (m.info.role !== "user") continue
          const text = joinText(m.parts)
          if (text) return text
        }
        return null
      }),
    resolveTurn: (sessionID) =>
      Effect.gen(function* () {
        const msgs = yield* deps.session
          .messages({ sessionID: sessionID as SessionID })
          .pipe(Effect.catchCause(() => Effect.succeed([])))
        // Walk newest-first until we collect the trailing assistant block
        // plus the user messages preceding it.
        const assistantChunks: string[] = []
        const userChunks: string[] = []
        let sawAssistant = false
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!
          const text = joinText(m.parts)
          if (!text) continue
          if (m.info.role === "assistant") {
            if (!sawAssistant || assistantChunks.length < 3) {
              assistantChunks.unshift(text)
              sawAssistant = true
            }
          } else if (m.info.role === "user") {
            if (sawAssistant) {
              userChunks.unshift(text)
              if (userChunks.length >= 4) break
            }
          }
        }
        if (!sawAssistant) return null
        return {
          turnSummary: assistantChunks.join("\n"),
          recentUserMessages: userChunks,
        }
      }),
    source: (_sessionID) =>
      Effect.succeed({
        _tag: "rollout" as const,
        threadID: _sessionID,
        timestamp: Date.now(),
      } as SextupleSource),
    // LLM bridges come from `deps.bridges`. When a phase's bridge is
    // unset the memory subsystem short-circuits gracefully:
    //   - querySynthModel: regex-based fallback (`regexKeywordQuery`) is used.
    //   - rerankModel: stage-2 rerank is skipped (pure cosine).
    //   - extractionModel: `runPhase1` short-circuits to `no-model`, so
    //     extraction produces no sextuples.
    //   - polishModel: refining gate runs verbatim signals only.
    extractionModel: deps.bridges?.extraction,
    rerankModel: deps.bridges?.rerank,
    polishModel: deps.bridges?.polish,
    querySynthModel: deps.bridges?.querySynth,
  })

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const memory = yield* Memory
      const session = yield* Session.Service
      const config = yield* Config.Service
      const hooks = yield* AdaptiveHooks.Service
      const provider = yield* Effect.serviceOption(Provider.Service)

      // Resolve the LLM bridges eagerly at layer-build time. We read the
      // config once and bind the bridges to the currently configured
      // models; subsequent config edits require a process restart to
      // pick up (matches the semantics of `autobest.model` et al).
      //
      // When `Provider.Service` is unavailable (e.g. minimal test
      // stacks) we skip bridge resolution entirely and the observer
      // degrades to deterministic fallbacks per `makeObserverOptions`.
      const cfg = yield* config.get()
      const bridges: {
        extraction?: Phase1Model
        rerank?: RerankModel
        polish?: RefiningModel
        querySynth?: SynthesizeModel
      } = {}
      if (provider._tag === "Some") {
        const providerSvc = provider.value
        const tryResolve = (phase: "extraction" | "rerank" | "polish" | "querySynth") =>
          Effect.gen(function* () {
            const spec = resolveModelSpec(cfg, phase)
            if (!spec) return undefined
            const bridge = yield* makeMemoryBridge({ modelSpec: spec }).pipe(
              Effect.provideService(Provider.Service, providerSvc),
              Effect.catchCause(() => Effect.succeed(undefined as Phase1Model | undefined)),
            )
            return bridge
          })
        bridges.extraction = yield* tryResolve("extraction")
        bridges.rerank = yield* tryResolve("rerank")
        bridges.polish = yield* tryResolve("polish")
        bridges.querySynth = yield* tryResolve("querySynth")
      }

      const opts = makeObserverOptions({ memory, session, config, bridges })

      const resolveConfig = opts.config

      // Registration is deferred — wrapping in a guard so repeated calls
      // from runLoop don't stack observers.
      let registered = false
      const ensureRegistered = () =>
        Effect.sync(() => {
          if (registered) return
          registered = true
          // `hooks.register` returns an unregister callback; we ignore it
          // because the observer is process-lifetime. Fire the Effect
          // synchronously — `register` is a pure sync push onto an array.
          Effect.runSync(hooks.register({ ...registerMemoryTurnObserver(opts) }))
        })

      return Service.of({
        resolveConfig,
        ensureRegistered,
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(memoryDefaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(AdaptiveHooks.defaultLayer),
    // Provider is a SOFT dependency — we read it via `Effect.serviceOption`
    // inside `layer` so tests / minimal stacks that don't wire a provider
    // still get a working (LLM-less) observer. When the ambient AppLayer
    // provides `Provider.defaultLayer` elsewhere (production) bridges
    // resolve as expected; when it doesn't, we degrade silently.
  )
}
