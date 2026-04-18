/**
 * SessionMemoryObserver — wiring layer for the codemem turn-hooks.
 *
 * Round-3 integration. Mirrors the structural shape of
 * `SessionAutobestObserver` / `SessionAutosteerObserver`: the layer is a
 * marker service whose *build* effect does nothing; actual registration of
 * the `AdaptiveHooks.Observer` happens lazily via `ensureRegistered()` so
 * the `register` call (which touches `InstanceState`) runs inside an
 * active `Instance` scope from the session-prompt runloop.
 *
 * What it wires:
 *   - Reads `config.memories.*` toggles and forwards them to
 *     `DEFAULT_HOOKS_CONFIG`, so users can opt-in via `opencode.json`.
 *   - Resolves the last user-message text + the recent assistant turn
 *     summary from the live `Session.Service` API (no speculation about
 *     message ids; we walk `messages({ sessionID })` newest-first).
 *   - Leaves `extractionModel` / `rerankModel` / `polishModel` unset by
 *     default — when the user doesn't ship a Phase-1 LLM bridge the
 *     observer silently short-circuits to "no-extraction-model" /
 *     "stage-1-only" modes. A future round wires an LLM adapter.
 *
 * Safety net: any exception inside the observer collapses to `Continue`
 * (see `registerMemoryTurnObserver` itself). Config-driven toggles make
 * the whole subsystem opt-in, so the default AppLayer pathway is a no-op.
 */

import { Context, Effect, Layer } from "effect"

import { AdaptiveHooks } from "./adaptive"
import { Config } from "@/config"
import { Memory, defaultLayer as memoryDefaultLayer } from "@/memory"
import {
  DEFAULT_HOOKS_CONFIG,
  registerMemoryTurnObserver,
  type MemoryHooksConfig,
  type MemoryTurnObserverOptions,
} from "@/memory/turn-hooks"
import { Session } from "./index"
import type { SessionID } from "./schema"
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
   * Build the observer options. Factored out so tests can drive the
   * resolver functions directly without standing up a Session service.
   */
  export const makeObserverOptions = (deps: {
    readonly memory: Memory.Interface
    readonly session: Session.Interface
    readonly config: Config.Interface
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
    // No LLM bridges supplied by default. When unset:
    //   - querySynthModel: regex-based fallback (`regexKeywordQuery`) is used.
    //   - rerankModel: stage-2 rerank is skipped (pure cosine).
    //   - extractionModel: `runPhase1` short-circuits to `no-model`, so
    //     extraction produces no sextuples.
    //   - polishModel: refining gate runs verbatim signals only.
  })

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const memory = yield* Memory
      const session = yield* Session.Service
      const config = yield* Config.Service
      const hooks = yield* AdaptiveHooks.Service

      const opts = makeObserverOptions({ memory, session, config })

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
  )
}
