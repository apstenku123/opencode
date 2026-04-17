import { Bus } from "@/bus"
import { Effect, Layer, Context, Option } from "effect"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import * as LlmExtract from "@/autobest/llm-extract"
import type { Candidate, CycleState, StepKind } from "@/autobest"

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
  export interface Interface {}

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

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAutobestObserver") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const session = yield* Session.Service
      const off = yield* bus.subscribeCallback(SessionStatus.Event.Idle, (evt) => {
        void Effect.runPromise(
          Effect.gen(function* () {
            const sessionID = evt.properties.sessionID
            const enabled = yield* session.getAutobestEnabled(sessionID)
            if (!enabled) return
            const msg = yield* session.findMessage(sessionID, (item) => item.info.role === "assistant")
            if (Option.isNone(msg)) return
            const text = msg.value.parts
              .filter((part): part is MessageV2.TextPart => part.type === "text")
              .map((part) => part.text.trim())
              .filter(Boolean)
              .join("\n")
            if (!text) return
            const picks = extract(text)
            if (!picks.length) return
            yield* session.applyAutobest({ sessionID, candidates: picks, ts: Date.now() })
          }),
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      return Service.of({})
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Session.defaultLayer))
}
