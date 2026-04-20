/**
 * Adaptive-loop hooks for `SessionPrompt.runLoop`.
 *
 * This module provides the API surface for observers that want to participate
 * in mid-run mutation of the session prompt loop. It is ported (round 1) from
 * codex_git's adaptive mechanisms — specifically the three decision points
 * inside `run_turn` (Rust: `codex-rs/core/src/codex.rs` ~6747) where the parent
 * loop can inject synthetic history, nudge the model, or hold the turn open
 * while async children finish.
 *
 * # Status — round 1: scaffolding only
 *
 * - Defines {@link AdaptiveState} (per-session mutable accumulators).
 * - Defines the three hook points (`preIteration`, `postIteration`, `preBreak`).
 * - Runs observers in registration order and merges their directives with
 *   precedence `break` > `inject` > `continue`.
 * - No live observers are registered. The runner is wired into
 *   `runLoop` as a no-op today so round 2 observers (S4 autobest LLM,
 *   S5 autosteer, stop-hook pipeline) can plug in without touching the
 *   loop again.
 *
 * # Registration contract (for round-2 observers)
 *
 * An observer is an {@link Observer} value supplied to {@link register}.
 * Observers MUST:
 *
 * - Treat the {@link AdaptiveState} as mutable — they may write counter
 *   values, remember last text, etc. Concurrent access within a single
 *   session loop iteration is serialized by the runner.
 * - Return a {@link Directive} from `postIteration` / `preBreak`. The runner
 *   collapses multiple observers' directives:
 *     - If any returned `{ kind: "break" }` the loop breaks.
 *     - Otherwise if any returned `{ kind: "inject", message }` the first
 *       injection wins (observers run in registration order) and the loop
 *       continues with the injected user message appended.
 *     - Otherwise the loop continues unchanged.
 * - Be side-effect-light from Effect's perspective — persistent state should
 *   live in the `AdaptiveState` itself, not observer closures.
 *
 * # Wiring from `SessionPrompt.runLoop`
 *
 * ```
 * const state = yield* AdaptiveState.for(sessionID)
 * while (true) {
 *   yield* AdaptiveHooks.runPreIteration(state, { step, lastUser, lastAssistant })
 *   // ... build messages, call handle.process ...
 *   const post = yield* AdaptiveHooks.runPostIteration(state, { step, lastResponse })
 *   if (post.kind === "inject") { inject(post.message); continue }
 *   if (post.kind === "break") break
 *   if (outcome === "break") {
 *     const pre = yield* AdaptiveHooks.runPreBreak(state, { step })
 *     if (pre.kind === "inject") { inject(pre.message); continue }
 *     if (pre.kind === "continue") continue
 *     break
 *   }
 * }
 * ```
 *
 * Round-2 agents map:
 *   - S4 (autobest LLM): registers a `postIteration` observer that emits the
 *     empty-output follow-up ("what's next?" / "where is the plan?").
 *   - S5 (autosteer): registers a `postIteration` observer that runs the
 *     stagnation detector and emits the action-nudge inject.
 *   - Guardian/stop-hook: registers `preBreak` to hold the turn when blocked.
 *   - SubagentRegistry.autoWait: registers `preBreak` to await children.
 */

import { SessionID, MessageID } from "./schema"
import { InstanceState } from "@/effect"
import { Effect, Layer, Context } from "effect"

export namespace AdaptiveState {
  export interface MaterializationEvent {
    readonly phase: "postIteration" | "preBreak" | "external"
    readonly source: string
    readonly text: string
  }

  /**
   * Per-session mutable accumulator shared across all observers and the
   * adaptive hook runner. Field semantics mirror the codex_git `Session`
   * atomics that gate nudges/follow-ups.
   */
  export interface Value {
    /** Monotonically increasing iteration counter within the current turn. */
    iteration: number
    /** Count of consecutive planning-only / similar assistant replies. */
    stagnationCount: number
    /** Count of consecutive empty assistant outputs within the current cycle. */
    emptyOutputCount: number
    /** Last assistant text observed (used for Jaccard similarity checks). */
    lastAssistantText?: string
    /**
     * Number of "where is the plan?" follow-ups already dispatched in the
     * current cycle. Round-2 (S4) caps this against `autobest_where_is_plan_max_asks_per_cycle`.
     */
    whereIsPlanAsks: number
    /** Number of "what's next?" follow-ups already dispatched. */
    whatNextAsks: number
    /**
     * Scratch space for observers that need per-session bookkeeping without
     * cluttering the strongly-typed fields above.
     */
    scratch: Record<string, unknown>
    /** FIFO of synthetic-turn injections accepted by the shared owner. */
    pendingInjects: Array<{ text: string; source: string; parentMessageID?: MessageID }>
    /** Recent diagnostic trace of arbitration/materialization decisions. */
    trace: Array<MaterializationEvent>
  }

  export const empty = (): Value => ({
    iteration: 0,
    stagnationCount: 0,
    emptyOutputCount: 0,
    lastAssistantText: undefined,
    whereIsPlanAsks: 0,
    whatNextAsks: 0,
    scratch: {},
    pendingInjects: [],
    trace: [],
  })

  /**
   * Reset counters that are scoped to a single "cycle" (= turn) while
   * preserving accumulators that span turns. Call when a new user message
   * starts a fresh cycle.
   */
  export const resetCycle = (state: Value): void => {
    state.whereIsPlanAsks = 0
    state.whatNextAsks = 0
    state.stagnationCount = 0
    state.emptyOutputCount = 0
  }
}

export namespace AdaptiveHooks {
  /**
   * A synthetic user-turn injection emitted by an observer. The runner is
   * responsible for turning this into a real `MessageV2.User` with a
   * `synthetic: true` text part.
   */
  export interface Inject {
    /** The raw text body injected as a synthetic `<system-reminder>`. */
    readonly text: string
    /** Observer tag for telemetry (e.g. "autosteer:nudge", "autobest:where-plan"). */
    readonly source: string
    /** Optional pre-computed parent message id. */
    readonly parentMessageID?: MessageID
  }

  export type Directive =
    | { readonly kind: "continue" }
    | { readonly kind: "break" }
    | { readonly kind: "inject"; readonly message: Inject }

  export const Continue = { kind: "continue" } as const satisfies Directive
  export const Break = { kind: "break" } as const satisfies Directive
  export const Inject = (message: Inject): Directive => ({ kind: "inject", message })

  export interface PreIterationArgs {
    readonly sessionID: SessionID
    readonly step: number
    readonly lastUserID?: MessageID
    readonly lastAssistantID?: MessageID
  }

  export interface PostIterationArgs {
    readonly sessionID: SessionID
    readonly step: number
    /** Assistant message id emitted during this iteration, if any. */
    readonly assistantMessageID?: MessageID
    /** The finish reason reported by the provider for this iteration. */
    readonly finish?: string
    /** The loop outcome computed by the default loop logic. */
    readonly defaultOutcome: "continue" | "break"
    /** Concatenated assistant text produced this iteration, if any. */
    readonly assistantText?: string
  }

  export interface PreBreakArgs {
    readonly sessionID: SessionID
    readonly step: number
  }

  export interface Observer {
    readonly name: string
    /** Optional pre-iteration hook. Return void; state mutation only. */
    readonly preIteration?: (state: AdaptiveState.Value, args: PreIterationArgs) => Effect.Effect<void>
    /** Optional post-iteration hook. Return a directive. */
    readonly postIteration?: (state: AdaptiveState.Value, args: PostIterationArgs) => Effect.Effect<Directive>
    /** Optional pre-break hook. Return a directive. */
    readonly preBreak?: (state: AdaptiveState.Value, args: PreBreakArgs) => Effect.Effect<Directive>
  }

  export interface Interface {
    /** Register a new observer. Returns an unregister function. */
    readonly register: (observer: Observer) => Effect.Effect<() => void>
    /** Read-only list of currently-registered observer names. */
    readonly registered: Effect.Effect<ReadonlyArray<string>>
    /** Get or create the per-session state bag. */
    readonly stateFor: (sessionID: SessionID) => Effect.Effect<AdaptiveState.Value>
    /** Drop a session's state bag (call on session delete). */
    readonly clear: (sessionID: SessionID) => Effect.Effect<void>
    /**
     * Reset per-cycle counters on a fresh user-message boundary. Called by
     * `SessionPrompt.prompt` when a new user-initiated turn begins (not on
     * synthetic injections). Preserves cross-cycle scratch state.
     */
    readonly resetCycleFor: (sessionID: SessionID) => Effect.Effect<void>
    /**
     * Notify the runner that a synthetic user message was injected by a
     * directive. Bumps the per-session inject counter; observers may read
     * this from `state.scratch.injectCount` for diagnostics / loop guards.
     */
    readonly noteInject: (sessionID: SessionID, source: string) => Effect.Effect<void>
    /**
     * Single append/accounting path for synthetic user-turn injections.
     * Loop-boundary injectors should use this instead of calling
     * `Session.appendUserText(...)` directly so source accounting stays
     * coherent across adaptive and non-adaptive producers.
     */
    readonly appendSyntheticUserText: (args: {
      sessionID: SessionID
      source: string
      text: string
      phase?: "postIteration" | "preBreak" | "external"
      append: Effect.Effect<void, never, never>
    }) => Effect.Effect<void>
    /** Snapshot the accepted injection queue for diagnostics/tests. */
    readonly pendingInjectsFor: (sessionID: SessionID) => Effect.Effect<ReadonlyArray<Inject>>
    /** Drain accepted injections after they have been materialized into messages. */
    readonly clearPendingInjectsFor: (sessionID: SessionID) => Effect.Effect<void>
    /** Snapshot recent arbitration/materialization trace. */
    readonly traceFor: (sessionID: SessionID) => Effect.Effect<ReadonlyArray<AdaptiveState.MaterializationEvent>>
    /** Clear diagnostic trace for a session. */
    readonly clearTraceFor: (sessionID: SessionID) => Effect.Effect<void>
    /** Run all registered `preIteration` observers in registration order. */
    readonly runPreIteration: (args: PreIterationArgs) => Effect.Effect<void>
    /** Run all registered `postIteration` observers and merge directives. */
    readonly runPostIteration: (args: PostIterationArgs) => Effect.Effect<Directive>
    /** Run all registered `preBreak` observers and merge directives. */
    readonly runPreBreak: (args: PreBreakArgs) => Effect.Effect<Directive>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAdaptiveHooks") {}

  /**
   * Merge observer directives according to precedence `break` > `inject` > `continue`.
   * Exported for the runner, and for tests that exercise the precedence rules.
   */
  export const mergeDirectives = (directives: ReadonlyArray<Directive>): Directive => {
    let inject: Directive | undefined
    for (const d of directives) {
      if (d.kind === "break") return Break
      if (d.kind === "inject" && inject === undefined) inject = d
    }
    return inject ?? Continue
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      // Observers are process-wide — they describe code that hooks into
      // every session loop. We deliberately keep them in a layer-local
      // closure (NOT in InstanceState) so registration happens at layer
      // build time without requiring an active `Instance` context. The
      // per-session AdaptiveState bags DO live in InstanceState — those
      // are accessed only at hook invocation time when Instance is active.
      const observers: Observer[] = []
      const data = yield* InstanceState.make(
        Effect.fn("AdaptiveHooks.state")(function* () {
          const sessions = new Map<SessionID, AdaptiveState.Value>()
          return { sessions }
        }),
      )

      const getState = InstanceState.get(data)

      const register: Interface["register"] = (observer) =>
        Effect.sync(() => {
          observers.push(observer)
          return () => {
            const idx = observers.indexOf(observer)
            if (idx >= 0) observers.splice(idx, 1)
          }
        })

      const registered: Interface["registered"] = Effect.sync(() => observers.map((o) => o.name))

      const stateFor: Interface["stateFor"] = (sessionID) =>
        Effect.map(getState, (state) => {
          let v = state.sessions.get(sessionID)
          if (!v) {
            v = AdaptiveState.empty()
            state.sessions.set(sessionID, v)
          }
          return v
        })

      const clear: Interface["clear"] = (sessionID) =>
        Effect.map(getState, (state) => {
          state.sessions.delete(sessionID)
        })

      const resetCycleFor: Interface["resetCycleFor"] = (sessionID) =>
        Effect.map(getState, (state) => {
          const v = state.sessions.get(sessionID)
          if (v) AdaptiveState.resetCycle(v)
        })

      const noteInject: Interface["noteInject"] = (sessionID, source) =>
        Effect.gen(function* () {
          const bag = yield* stateFor(sessionID)
          const prior = (bag.scratch.injectCount as number | undefined) ?? 0
          bag.scratch.injectCount = prior + 1
          bag.scratch.lastInjectSource = source
        })

      const appendSyntheticUserText: Interface["appendSyntheticUserText"] = (args) =>
        Effect.gen(function* () {
          const bag = yield* stateFor(args.sessionID)
          bag.pendingInjects.push({ text: args.text, source: args.source })
          bag.trace.push({
            phase: args.phase ?? "external",
            source: args.source,
            text: args.text,
          })
          if (args.append) yield* args.append
          yield* noteInject(args.sessionID, args.source)
        })

      const pendingInjectsFor: Interface["pendingInjectsFor"] = (sessionID) =>
        Effect.map(stateFor(sessionID), (bag) => [...bag.pendingInjects])

      const clearPendingInjectsFor: Interface["clearPendingInjectsFor"] = (sessionID) =>
        Effect.map(stateFor(sessionID), (bag) => {
          bag.pendingInjects.length = 0
        })

      const traceFor: Interface["traceFor"] = (sessionID) =>
        Effect.map(stateFor(sessionID), (bag) => [...bag.trace])

      const clearTraceFor: Interface["clearTraceFor"] = (sessionID) =>
        Effect.map(stateFor(sessionID), (bag) => {
          bag.trace.length = 0
        })

      const runPreIteration: Interface["runPreIteration"] = (args) =>
        Effect.gen(function* () {
          const bag = yield* stateFor(args.sessionID)
          bag.iteration = args.step
          for (const obs of observers) {
            if (!obs.preIteration) continue
            yield* obs.preIteration(bag, args)
          }
        })

      const runPostIteration: Interface["runPostIteration"] = (args) =>
        Effect.gen(function* () {
          const bag = yield* stateFor(args.sessionID)
          if (args.assistantText !== undefined) bag.lastAssistantText = args.assistantText
          const directives: Directive[] = []
          for (const obs of observers) {
            if (!obs.postIteration) continue
            directives.push(yield* obs.postIteration(bag, args))
          }
          return mergeDirectives(directives)
        })

      const runPreBreak: Interface["runPreBreak"] = (args) =>
        Effect.gen(function* () {
          const bag = yield* stateFor(args.sessionID)
          const directives: Directive[] = []
          for (const obs of observers) {
            if (!obs.preBreak) continue
            directives.push(yield* obs.preBreak(bag, args))
          }
          return mergeDirectives(directives)
        })

      return Service.of({
        register,
        registered,
        stateFor,
        clear,
        resetCycleFor,
        noteInject,
        appendSyntheticUserText,
        pendingInjectsFor,
        clearPendingInjectsFor,
        traceFor,
        clearTraceFor,
        runPreIteration,
        runPostIteration,
        runPreBreak,
      })
    }),
  )

  export const defaultLayer = layer
}
