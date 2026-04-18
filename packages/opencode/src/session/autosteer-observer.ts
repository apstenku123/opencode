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
 * Autosteer observer (round 4 consolidation).
 *
 * Ported to the {@link AdaptiveHooks} pipeline — round 1's
 * `Bus.subscribeCallback(SessionStatus.Event.Idle)` has been removed.
 * Stagnation detection runs in a `postIteration` observer so the hook
 * runner arbitrates directive precedence (`break` > `inject` > `continue`)
 * between autosteer, autobest, and any other registered observers.
 *
 * Round-4 consolidation removed the legacy `{inject: true}` back-compat
 * path: `evaluateSession` is now pure detection and never appends a user
 * message itself. All nudge injection flows through the postIteration
 * observer's `Inject` directive, which the runLoop handles by calling
 * `Session.Service.appendUserText` with the enclosing turn's
 * agent/model/provider context (see `prompt.ts` post-iteration branch).
 *
 * The Service interface is preserved for the TUI sidebar + server routes
 * (autosteering toggle, cumulative nudge count).
 */
export namespace SessionAutosteerObserver {
  export interface Interface {
    /** Inspect current counter for a session. */
    readonly getCount: (sessionID: SessionID) => Effect.Effect<number>
    /**
     * Evaluate now against the last two assistant messages. Returns the
     * evaluation outcome plus the text the runner should inject as a
     * synthetic user turn. Detection-only — after round-4 consolidation
     * this method never mutates session state; actual injection happens
     * via the registered `postIteration` observer (see layer body).
     */
    readonly evaluateSession: (sessionID: SessionID) => Effect.Effect<{
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

      const evaluateSession: Interface["evaluateSession"] = (sessionID) =>
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
          return {
            stagnant: out.stagnant,
            nudge: out.nudge,
            count: out.nextState.stagnationCount,
            nudgeText: out.nudge ? SessionAutosteer.NUDGE_TEXT : undefined,
          }
        })

      // Register postIteration observer — this is the single entrypoint
      // for autosteer behavior after round-4 consolidation. The runLoop
      // invokes `runPostIteration` at the end of each assistant step; we
      // evaluate stagnation and surface `Inject` so the runner appends
      // the synthetic user message (with the turn's agent/model/provider
      // context preserved) and continues the loop. Cumulative-nudge
      // telemetry is updated here so it tracks real nudge injections
      // only — evaluateSession itself is detection-only.
      yield* adaptive.register({
        name: "autosteer",
        postIteration: (_state, args) =>
          Effect.gen(function* () {
            const out = yield* evaluateSession(args.sessionID)
            if (!out.nudge || !out.nudgeText) return AdaptiveHooks.Continue
            const counts = yield* InstanceState.get(nudgeCounts)
            const nextLifetime = (counts.get(args.sessionID) ?? 0) + 1
            counts.set(args.sessionID, nextLifetime)
            yield* bus.publish(Event.NudgeInjected, {
              sessionID: args.sessionID,
              count: nextLifetime,
            })
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
