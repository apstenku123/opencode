import { Bus } from "@/bus"
import { Config } from "@/config"
import { InstanceState } from "@/effect"
import { BusEvent } from "@/bus/bus-event"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Session } from "./index"
import type { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { SessionAutosteer } from "./autosteer"

/**
 * Observer layer mirroring {@link SessionAutobestObserver}: subscribes to
 * `SessionStatus.Event.Idle`, inspects the last two assistant replies,
 * runs {@link SessionAutosteer.evaluate}, and when a nudge fires injects
 * a canned user-role message via `Session.Service.appendUserText`.
 *
 * Gated by `autosteering.enabled` in config (default: true).
 * Counter state is kept per-session in an in-memory Map.
 */
export namespace SessionAutosteerObserver {
  export interface Interface {
    /** Inspect current counter for a session. */
    readonly getCount: (sessionID: SessionID) => Effect.Effect<number>
    /**
     * Evaluate now against the last two assistant messages and (if triggered)
     * inject a nudge. Returns the evaluation outcome. Exposed for tests /
     * manual triggering; the bus subscription also calls through here.
     */
    readonly evaluateSession: (sessionID: SessionID) => Effect.Effect<{
      stagnant: boolean
      nudge: boolean
      count: number
    }>
    /**
     * Runtime override for `autosteering.enabled`. When set, takes
     * precedence over the value loaded from `opencode.json`. `undefined`
     * clears the override and reverts to the config value.
     *
     * Powers the `/autosteering on|off` slash command and the
     * `POST /config/autosteering` server route — both want a *runtime*
     * toggle that does not require rewriting `opencode.json`.
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

      // Per-session counter map. previousResponse is derived from the
      // second-most-recent assistant message on demand, so we only persist
      // the stagnation count here.
      const states = yield* InstanceState.make(
        Effect.fn("SessionAutosteerObserver.states")(() => Effect.succeed(new Map<SessionID, SessionAutosteer.State>())),
      )

      // Cumulative-nudge tracker. Mirrors the Rust right-panel
      // `autosteering_count` per agent (right_panel.rs:194-195, 804-807).
      // Reset of `state.stagnationCount` after a nudge fires is the
      // detection counter — separate from this lifetime tally.
      const nudgeCounts = yield* InstanceState.make(
        Effect.fn("SessionAutosteerObserver.nudgeCounts")(() =>
          Effect.succeed(new Map<SessionID, number>()),
        ),
      )

      // Runtime override. Plain ref-style cell — single fiber writes,
      // many read; no need for an Effect-managed primitive.
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
          // Return a clone so callers can't mutate observer state.
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

          if (out.nudge) {
            yield* session.appendUserText({
              sessionID,
              text: SessionAutosteer.NUDGE_TEXT,
            })
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
          }
        })

      const off = yield* bus.subscribeCallback(SessionStatus.Event.Idle, (evt) => {
        void Effect.runPromise(
          Effect.gen(function* () {
            yield* evaluateSession(evt.properties.sessionID as SessionID)
          }).pipe(
            Effect.catchCause(() => Effect.void),
          ),
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

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

  export const defaultLayer = layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )
}
