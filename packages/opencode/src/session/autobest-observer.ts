import { Effect, Option } from "effect"
import { Session } from "./index"
import { AdaptiveHooks } from "./adaptive"
import { MessageV2 } from "./message-v2"
import * as LlmExtract from "@/autobest/llm-extract"
import * as Steps from "@/autobest/steps"
import * as Autobest from "@/autobest"
import * as Grounding from "@/autobest/grounding"
import { compactWindowReaderFromSession } from "@/autobest/compact"
import type { Candidate, CycleState, StepKind } from "@/autobest"
import * as History from "@/history"
import { MCP } from "@/mcp"

/**
 * Default cap on auto-continue feedback iterations.
 * Mirror of the loop guard in `chatwidget.rs::on_autobest_result`.
 */
export const DEFAULT_MAX_ITERATIONS = 3

/**
 * User message substrings that, when seen as the user's *most recent* turn,
 * halt the auto-continue loop. Matches the spirit of the Rust TUI's
 * "user typed /stop or pressed ESC" short-circuit path.
 */
export const STOP_PATTERNS: readonly string[] = ["/stop", "stop autobest", "disable autobest", "stop the loop"]

export type ContinuationDecision = {
  /** Whether to submit a new user turn carrying `active.key`. */
  shouldContinue: boolean
  reason: string
  iteration: number
  stepKind: StepKind
}

/** Pure helper — returns true iff continuation should fire. */
export function shouldContinue(input: {
  enabled: boolean
  changed: boolean
  activeKey?: string
  lastUserText?: string
  cycle?: CycleState
  maxIterations?: number
}): ContinuationDecision {
  const max = input.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const iteration = input.cycle?.iteration ?? 0
  const stepKind = input.cycle?.stepKind ?? "a"
  if (!input.enabled) return { shouldContinue: false, reason: "autobest-disabled", iteration, stepKind }
  if (!input.changed) return { shouldContinue: false, reason: "not-changed", iteration, stepKind }
  if (!input.activeKey) return { shouldContinue: false, reason: "no-active-key", iteration, stepKind }
  if (iteration >= max) return { shouldContinue: false, reason: "max-iterations-reached", iteration, stepKind }
  if (input.lastUserText) {
    const lower = input.lastUserText.toLowerCase()
    for (const pat of STOP_PATTERNS) {
      if (lower.includes(pat)) return { shouldContinue: false, reason: "stop-pattern", iteration, stepKind }
    }
  }
  return { shouldContinue: true, reason: "continue", iteration, stepKind }
}

export namespace SessionAutobestObserver {
  /**
   * Legacy deterministic bullet-regex extractor.
   * Kept for callers (and existing tests) that expect a synchronous return.
   * Equivalent to {@link LlmExtract.fallbackRegex} modulo the `reason` tag.
   */
  export function extract(text: string) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line, i) => {
        const m = line.match(/^[-*]\s+(.+)$/) ?? line.match(/^\d+[.)]\s+(.+)$/)
        if (!m) return []
        return [{ key: m[1].slice(0, 120), score: Math.max(1, 100 - i) }]
      })
      .slice(0, 5)
  }

  /**
   * Run Step A extraction with LLM + regex fallback.
   * Re-exported for call-sites that want a typed Effect interface.
   */
  export function extractLlm(text: string, opts: LlmExtract.ExtractOptions = {}) {
    return LlmExtract.extract(text, opts)
  }

  /** Convenience: threshold check used by `apply + continue`. */
  export function passesScoreThreshold(candidates: Candidate[], threshold: number): boolean {
    return !!candidates.length && (candidates[0]?.score ?? 0) >= threshold
  }

  /**
   * Build an {@link AdaptiveHooks.Observer} that runs the autobest A → B → C → D
   * pipeline at the end of each iteration. This is the **single** entrypoint
   * for autobest — round 1's bus-driven `Idle` listener and inline `runLoop`
   * hook have been consolidated into this observer (see migration plan §3.2 #12).
   *
   * The observer:
   *   - Reads `autobest.enabled` from history (skips when disabled).
   *   - Runs Step A regex extract on the iteration's assistant text.
   *   - Calls {@link Steps.runSteps} to choose A/B/C/D.
   *   - On Step A: persists candidates via {@link Session.applyAutobest} and
   *     returns `Inject` carrying the top candidate as the next user turn.
   *   - On Step B: returns `Inject` carrying the next plan item.
   *   - On Step C: returns `Inject` with `"And what's next?"`, marks
   *     `whatNextAsked=true` in the durable cycle event.
   *   - On Step D: returns `Continue` (no submit) and writes a terminal
   *     `autobest.cycle.advance` event.
   *
   * Cycle state is persisted via `autobest.cycle.advance` /
   * `autobest.cycle.reset` history events — see {@link Autobest.reduceCycleEvents}.
   */
  export const buildObserver = Effect.fn("autobest.observer.build")(function* (opts?: {
    maxIterations?: number
    /** Optional grounding config override. Defaults to Rust parity values. */
    grounding?: Partial<Grounding.GroundingConfig>
    /** Optional override for tests — defaults to `Session.Service.findMessage`. */
  }) {
    const session = yield* Session.Service
    const mcp = yield* Effect.serviceOption(MCP.Service)
    const maxIterations = opts?.maxIterations ?? DEFAULT_MAX_ITERATIONS
    const groundingCfg = opts?.grounding
    const compactReader = compactWindowReaderFromSession(session)
    const observer: AdaptiveHooks.Observer = {
      name: "autobest",
      postIteration: (state, args) =>
        Effect.gen(function* () {
          const enabled = yield* session.getAutobestEnabled(args.sessionID)
          if (!enabled) return AdaptiveHooks.Continue

          // Prefer the live assistant message snapshot. The runLoop's
          // `args.assistantText` is computed against `msgs` taken at the
          // START of the iteration and may not include text just produced
          // by `handle.process`; fetch the freshest assistant message via
          // `findMessage` instead. Falls back to `args.assistantText` when
          // the lookup fails (e.g. session not yet persisted).
          const fresh = yield* session
            .findMessage(args.sessionID, (m) => m.info.role === "assistant")
            .pipe(Effect.match({ onFailure: () => undefined as undefined, onSuccess: (v) => v }))
          const text = (() => {
            if (fresh && (fresh as { _tag?: string })._tag !== "None" && (fresh as any).value) {
              const msg = (fresh as { value: { parts: { type: string; text?: string }[] } }).value
              return msg.parts
                .filter((p) => p.type === "text")
                .map((p) => (p.text ?? "").trim())
                .filter(Boolean)
                .join("\n")
            }
            return (args.assistantText ?? "").trim()
          })()
          if (!text) return AdaptiveHooks.Continue

          // Step A — regex-only path for now (LLM-call wiring lives elsewhere
          // and is opt-in once a model is bound). Round 2 keeps the
          // deterministic path because tests require it; the LLM extractor in
          // `llm-extract.ts` is plumbed for round 3 once the model adapter
          // is available at observer scope.
          const candidates = extract(text)

          // Hydrate cycle state from history (durable across restarts).
          const rawEvents = yield* Effect.promise(() => History.read(args.sessionID))
          const cycleEvents = rawEvents.filter(
            (ev): ev is Autobest.CycleEvent =>
              ev.type === "autobest.cycle.advance" || ev.type === "autobest.cycle.reset",
          )
          const groundingEvents = rawEvents.filter(
            (ev): ev is Grounding.GroundingEvent => ev.type === "autobest.grounding",
          )
          const cycle = Autobest.reduceCycleEvents(cycleEvents)
          const iteration = cycle?.iteration ?? 0
          const lastGroundingTurn = Grounding.lastDispatchedGroundingTurn(groundingEvents)

          // Grounding — fire when Step A yielded no candidates AND an MCP
          // service is available. Uses per-session cooldown from the
          // `autobest.grounding` event history.
          //
          // Note: the Rust pipeline gates on `complaint=true`. Until the
          // observer is wired to the LLM extractor, we approximate "complaint"
          // with "empty Step A on a non-empty assistant text" — which is the
          // same starvation signal that triggers Step B/C/D. Once
          // `extractLlm()` is the observer's default we will switch to the
          // explicit `complaint` flag (see round-4 backlog).
          if (!candidates.length && Option.isSome(mcp)) {
            // `MCP.Interface.tools()` is structurally compatible with
            // `Grounding.McpInterface` — the latter is intentionally narrower
            // so the grounding module does not pull the full MCP surface.
            const mcpSvc: Grounding.McpInterface = mcp.value
            const toolNames = yield* Grounding.listSearchToolsFromMcp(mcpSvc)
            if (toolNames.length) {
              const outcome = yield* Grounding.maybeDispatchGrounding({
                currentTurn: iteration,
                lastGroundingTurn,
                complaintReason: "empty_extract",
                tail: text.slice(-4_000),
                tools: toolNames,
                config: groundingCfg,
                dispatcher: Grounding.dispatcherFromMcp(mcpSvc),
              })
              const groundingEv = Grounding.buildGroundingEvent({
                sessionID: args.sessionID,
                outcome,
                currentTurn: iteration,
              })
              yield* Effect.promise(() => History.append(args.sessionID, groundingEv))
            }
          }

          const decision = yield* Steps.runStepsEffect({
            sessionID: args.sessionID,
            stepACandidates: candidates,
            cycle,
            maxIterations,
            compactReader,
            assistantTail: text,
          })

          if (decision.kind === "a" && candidates.length) {
            // Step A: persist the candidate via `applyAutobest` (writes
            // `autobest.result` + `autobest.active` history events),
            // record the cycle advance, and auto-continue by injecting
            // the chosen bullet as the next synthetic user turn. The
            // max-iterations guard above (decision.kind falls through to
            // Step D when `iteration >= maxIterations`) prevents infinite
            // loops. `shouldContinue` callers can also short-circuit via
            // STOP_PATTERNS in the most recent user message.
            const result = yield* session
              .applyAutobest({ sessionID: args.sessionID, candidates, ts: Date.now() })
              .pipe(
                Effect.match({
                  onFailure: () => undefined as undefined,
                  onSuccess: (v) => v,
                }),
              )
            const next = Autobest.buildCycleAdvanceEvent({
              sessionID: args.sessionID,
              cycle: {
                iteration: iteration + 1,
                stepKind: "a",
                turnID: cycle?.turnID,
                whatNextAsked: cycle?.whatNextAsked,
              },
              reason: "step_a",
            })
            yield* Effect.promise(() => History.append(args.sessionID, next))
            state.iteration = iteration + 1
            const activeKey = result?.decision.active?.key ?? candidates[0]?.key
            if (!activeKey) return AdaptiveHooks.Continue
            // Stop-pattern short-circuit — when the most-recent
            // *non-synthetic* user message contains one of
            // `STOP_PATTERNS`, the observer has still captured the
            // candidates (so `active.key` is available for the UI) but
            // must not inject a follow-up synthetic user turn. Matches
            // the TUI's user-typed-`/stop` behaviour: the active pick
            // persists, but the auto-loop stops here. We scan user
            // messages in reverse chronological order (via
            // `MessageV2.stream`) and filter out synthetic injections
            // so a previous-iteration self-inject cannot hide a freshly
            // typed "stop autobest".
            const lastUserText = yield* session
              .findMessage(args.sessionID, (m) => {
                if (m.info.role !== "user") return false
                for (const p of m.parts ?? []) {
                  if (p.type === "text" && !p.synthetic && !p.ignored && (p.text ?? "").trim()) {
                    return true
                  }
                }
                return false
              })
              .pipe(
                Effect.match({
                  onFailure: () => "",
                  onSuccess: (v: any) => {
                    if (!v || v._tag === "None" || !v.value) return ""
                    const parts = v.value.parts ?? []
                    return parts
                      .filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored)
                      .map((p: any) => (p.text ?? "").trim())
                      .filter(Boolean)
                      .join("\n")
                      .toLowerCase()
                  },
                }),
              )
            for (const pat of STOP_PATTERNS) {
              if (lastUserText.includes(pat)) {
                return AdaptiveHooks.Continue
              }
            }
            return AdaptiveHooks.Inject({
              text: activeKey,
              source: "autobest:step-a",
            })
          }

          if (decision.kind === "b" && decision.action) {
            const next = Autobest.buildCycleAdvanceEvent({
              sessionID: args.sessionID,
              cycle: {
                iteration: iteration + 1,
                stepKind: "b",
                turnID: cycle?.turnID,
                whatNextAsked: cycle?.whatNextAsked,
              },
              reason: decision.reason,
            })
            yield* Effect.promise(() => History.append(args.sessionID, next))
            state.iteration = iteration + 1
            return AdaptiveHooks.Inject({
              text: decision.action,
              source: "autobest:step-b",
            })
          }

          if (decision.kind === "c") {
            const next = Autobest.buildCycleAdvanceEvent({
              sessionID: args.sessionID,
              cycle: {
                iteration: iteration + 1,
                stepKind: "c",
                turnID: cycle?.turnID,
                whatNextAsked: true,
              },
              reason: decision.reason,
            })
            yield* Effect.promise(() => History.append(args.sessionID, next))
            state.iteration = iteration + 1
            state.whatNextAsks += 1
            return AdaptiveHooks.Inject({
              text: decision.action,
              source: "autobest:step-c",
            })
          }

          // Step D — terminal.
          const next = Autobest.buildCycleAdvanceEvent({
            sessionID: args.sessionID,
            cycle: {
              iteration: iteration + 1,
              stepKind: "d",
              turnID: cycle?.turnID,
              whatNextAsked: cycle?.whatNextAsked,
            },
            reason: decision.reason,
          })
          yield* Effect.promise(() => History.append(args.sessionID, next))
          state.iteration = iteration + 1
          return AdaptiveHooks.Continue
        }),
    }
    return observer
  })

  /**
   * Per-instance idempotent registration helper. Safe to call multiple
   * times; subsequent calls are no-ops. Intended to be invoked lazily from
   * inside an Instance scope (e.g. on the first `runLoop` iteration), which
   * is necessary because {@link AdaptiveHooks.register} writes through
   * `InstanceState` and cannot run at layer-build time.
   *
   * Round-4 consolidation (migration plan §3.2 #12) removed the legacy
   * marker `Service` / `layer` / `defaultLayer`; the observer now registers
   * itself directly via this helper and the AdaptiveHooks pipeline is the
   * single entrypoint for autobest post-iteration behavior (Step A → D,
   * grounding, candidate persistence, cycle advance).
   */
  const registeredInstances = new WeakSet<object>()
  export const ensureRegistered = Effect.fn("autobest.observer.ensureRegistered")(function* () {
    const hooks = yield* AdaptiveHooks.Service
    if (registeredInstances.has(hooks)) return
    registeredInstances.add(hooks)
    const observer = yield* buildObserver()
    yield* hooks.register(observer)
  })
}

// MessageV2 referenced for parity with the prior file (kept as transitive type).
void MessageV2
void Option
