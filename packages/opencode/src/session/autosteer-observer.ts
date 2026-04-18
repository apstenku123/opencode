import { Bus } from "@/bus"
import { Config } from "@/config"
import { InstanceState } from "@/effect"
import { BusEvent } from "@/bus/bus-event"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Session } from "./index"
import type { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionAutosteer } from "./autosteer"
import { AdaptiveHooks } from "./adaptive"

/**
 * Autosteer observer (round 3).
 *
 * Ported to the {@link AdaptiveHooks} pipeline — round 1's
 * `Bus.subscribeCallback(SessionStatus.Event.Idle)` has been removed.
 * Stagnation detection now runs in a `postIteration` observer so the hook
 * runner arbitrates directive precedence (`break` > `inject` > `continue`)
 * between autosteer, autobest, and any other registered observers.
 *
 * The observer no longer calls `Session.Service.appendUserText` itself —
 * that is now the runLoop's responsibility via the `Inject` directive
 * plumbing in `prompt.ts`. This avoids racing a bus-thread `appendUserText`
 * against the runLoop's next iteration.
 *
 * The Service interface is preserved for the TUI sidebar + server routes
 * (autosteering toggle, cumulative nudge count). Tests call
 * `evaluateSession` with `{inject: true}` to retain the round-2
 * append-user-message side-effect; the hook pathway passes `{inject: false}`.
 */
export namespace SessionAutosteerObserver {
  export interface Interface {
    /** Inspect current counter for a session. */
    readonly getCount: (sessionID: SessionID) => Effect.Effect<number>
    /**
     * Evaluate now against the last two assistant messages. Returns the
     * evaluation outcome plus (optionally) the text the runner should
     * inject as a synthetic user turn.
     *
     * @param opts.inject — when `true` (the default, for back-compat with
     *   the round-2 test suite), performs the legacy side-effect of
     *   appending a synthetic user message via `Session.Service.appendUserText`
     *   when a nudge fires. The hook-driven path passes `false`.
     */
    readonly evaluateSession: (
      sessionID: SessionID,
      opts?: { inject?: boolean },
    ) => Effect.Effect<{
      stagnant: boolean
      nudge: boolean
      count: number
      nudgeText?: string
    }>
    /**
     * Runtime override for `autosteering.enabled`. Set → takes precedence
     * over `opencode.json`. `undefined` clears the override.
     *
     * Powers the `/autosteering on|off` slash command and the
     * `POST /config/autosteering` server route.
     */
    readonly setEnabledOverride: (enabled: boolean | undefined) => Effect.Effect<void>
    /** Read the effective enabled value (override > config > default true). */
    readonly isEnabled: () => Effect.Effect<boolean>
    /** Cumulative count of nudges fired since process start, summed across all sessions. */
    readonly cumulativeNudgeCount: () => Effect.Effect<number>
    /** Per-session cumulative nudge counts since process start. */
    readonly perSessionNudgeCounts: () => Effect.Effect<ReadonlyMap<SessionID, number>>
  }

  export const Event = {
    NudgeInjected: BusEvent.define(
      "session.autosteer.nudge",
      z.object({
        sessionID: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAutosteerObserver") {}

  /** Extract the text content of an assistant MessageV2.WithParts into a single string. */
  function extractAssistantText(msg: MessageV2.WithParts): string {
    return msg.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const session = yield* Session.Service
      const config = yield* Config.Service
      const adaptive = yield* AdaptiveHooks.Service

      // Per-session counter map.
      const states = yield* InstanceState.make(
        Effect.fn("SessionAutosteerObserver.states")(() => Effect.succeed(new Map<SessionID, SessionAutosteer.State>())),
      )

      // Cumulative-nudge tracker (lifetime tally, separate from detection counter).
      const nudgeCounts = yield* InstanceState.make(
        Effect.fn("SessionAutosteerObserver.nudgeCounts")(() =>
          Effect.succeed(new Map<SessionID, number>()),
        ),
      )

      const overrideRef: { value: boolean | undefined } = { value: undefined }

      const getCount: Interface["getCount"] = (sessionID) =>
        Effect.gen(function* () {
          const map = yield* InstanceState.get(states)
          return map.get(sessionID)?.stagnationCount ?? 0
        })

      const isEnabled: Interface["isEnabled"] = () =>
        Effect.gen(function* () {
          if (overrideRef.value !== undefined) return overrideRef.value
          const cfg = yield* config.get()
          return cfg.autosteering?.enabled ?? true
        })

      const setEnabledOverride: Interface["setEnabledOverride"] = (enabled) =>
        Effect.sync(() => {
          overrideRef.value = enabled
        })

      const cumulativeNudgeCount: Interface["cumulativeNudgeCount"] = () =>
        Effect.gen(function* () {
          const map = yield* InstanceState.get(nudgeCounts)
          let total = 0
          for (const n of map.values()) total += n
          return total
        })

      const perSessionNudgeCounts: Interface["perSessionNudgeCounts"] = () =>
        Effect.gen(function* () {
          const map = yield* InstanceState.get(nudgeCounts)
          return new Map(map) as ReadonlyMap<SessionID, number>
        })

      const evaluateSession: Interface["evaluateSession"] = (sessionID, opts) =>
        Effect.gen(function* () {
          const enabled = yield* isEnabled()
          if (!enabled) return { stagnant: false, nudge: false, count: 0 }

          const cfg = yield* config.get()
          const thresholds: SessionAutosteer.Thresholds = {
            stagnationTrigger: cfg.autosteering?.stagnationTrigger,
            similarityThreshold: cfg.autosteering?.similarityThreshold,
            minResponseLength: cfg.autosteering?.minResponseLength,
            planningPhrases: cfg.autosteering?.planningPhrases,
            actionMarkers: cfg.autosteering?.actionMarkers,
          }

          // Walk newest-first; grab the two most recent assistant messages.
          let latest: string | undefined
          let prior: string | undefined
          for (const item of MessageV2.stream(sessionID)) {
            if (item.info.role !== "assistant") continue
            const text = extractAssistantText(item)
            if (!text) continue
            if (latest === undefined) {
              latest = text
              continue
            }
            prior = text
            break
          }
          if (!latest) return { stagnant: false, nudge: false, count: 0 }

          const map = yield* InstanceState.get(states)
          const existing = map.get(sessionID) ?? { ...SessionAutosteer.initialState }
          const state: SessionAutosteer.State = {
            previousResponse:
              prior?.slice(0, SessionAutosteer.SIMILARITY_PREFIX_CHARS) ?? existing.previousResponse,
            stagnationCount: existing.stagnationCount,
          }
          const out = SessionAutosteer.evaluate(state, latest, thresholds)
          map.set(sessionID, out.nextState)

          if (out.nudge) {
            // Backwards-compatible side-effect path — when the caller opts
            // into direct injection (default), persist the nudge as a
            // synthetic user message exactly as round-2 did.
            if (opts?.inject !== false) {
              yield* session.appendUserText({
                sessionID,
                text: SessionAutosteer.NUDGE_TEXT,
                synthetic: true,
              })
            }
            const counts = yield* InstanceState.get(nudgeCounts)
            const nextLifetime = (counts.get(sessionID) ?? 0) + 1
            counts.set(sessionID, nextLifetime)
            yield* bus.publish(Event.NudgeInjected, {
              sessionID,
              count: nextLifetime,
            })
          }
          return {
            stagnant: out.stagnant,
            nudge: out.nudge,
            count: out.nextState.stagnationCount,
            nudgeText: out.nudge ? SessionAutosteer.NUDGE_TEXT : undefined,
          }
        })

      // Register postIteration observer — replaces the round-2
      // Bus.subscribeCallback(SessionStatus.Event.Idle) path. The runLoop
      // invokes `runPostIteration` at the end of each assistant step; we
      // evaluate stagnation and surface `Inject` so the runner appends the
      // synthetic user message and continues the loop. We pass
      // `inject: false` to `evaluateSession` so the runner (not this
      // observer) performs the append — prevents double-injection.
      yield* adaptive.register({
        name: "autosteer",
        postIteration: (_state, args) =>
          Effect.gen(function* () {
            const out = yield* evaluateSession(args.sessionID, { inject: false })
            if (!out.nudge || !out.nudgeText) return AdaptiveHooks.Continue
            return AdaptiveHooks.Inject({
              text: out.nudgeText,
              source: "autosteer:nudge",
            })
          }),
      })

      return Service.of({
        getCount,
        evaluateSession,
        setEnabledOverride,
        isEnabled,
        cumulativeNudgeCount,
        perSessionNudgeCounts,
      })
    }),
  )

  /**
   * Default layer. Bundles `AdaptiveHooks.defaultLayer` via `Layer.provideMerge`
   * so the Service is re-exported to consumers of this layer. Combined with
   * the fact that `SessionPrompt.defaultLayer` also consumes this same
   * `AdaptiveHooks.defaultLayer` identity (ManagedRuntime memoMap), the
   * runLoop observer registration and the hook invocation pathway share a
   * single in-process registry.
   */
  export const defaultLayer = layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provideMerge(AdaptiveHooks.defaultLayer),
  )
}
