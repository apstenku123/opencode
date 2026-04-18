/**
 * Autobest Step B / C / D orchestration.
 *
 * Round-2 port of the post-extraction follow-up logic that lives at
 * `codex-rs/core/src/autobest_extract.rs::run_step_b` and
 * `decide_empty_followup`. Round 1 only landed Step A (LLM extract) plus the
 * auto-continue submitter; rounds C / D and plan-check were stubs.
 *
 * # Decision shape
 *
 * Each step produces a {@link StepDecision} that carries:
 *
 * - `kind`: which step ran (`"a" | "b" | "c" | "d"`).
 * - `reason`: short tag suitable for telemetry (e.g. `"plan_step_skipped"`,
 *   `"empty_step_a_no_plan"`, `"max_iterations"`).
 * - `action?`: the synthetic user-turn text to submit next, when applicable.
 *   `undefined` (or explicit `null` in Step D) means "do not continue".
 *
 * # Pipeline
 *
 * ```
 * Step A (llm-extract.ts)
 *   ├── candidates.length > 0  → submit top candidate, kind="a"
 *   └── candidates empty       → Step B
 *         ├── plan_check ⇒ {has_plan,hint}
 *         │     ├── plan_step_skipped → kind="b", action=continue-plan
 *         │     └── caught_up         → Step C
 *         └── compact unavailable     → Step C (gated off)
 *
 * Step C
 *   ├── !whatNextAsked          → kind="c", action="And what's next?"
 *   └── whatNextAsked already   → Step D
 *
 * Step D
 *   └── kind="d", action=null    (terminal — no submit)
 * ```
 *
 * Step B is gated on a {@link CompactWindow} reader because the compact
 * pipeline has not yet been ported. When the reader returns `undefined`
 * (default in this round), Step B is skipped and the orchestrator falls
 * through to Step C.
 */

import { Effect } from "effect"
import type { Candidate, CycleState, StepKind } from "./index"

/**
 * Subset of the Rust `CompactWindow` shape that Step B reads.
 *
 * Stub. Full compact-window porting will land in a later round and will
 * provide a real {@link CompactWindowReader} hooked up to history events.
 */
export interface CompactWindow {
  readonly id?: number
  readonly snippet?: string
  /** Bullet-form "next steps" extracted from the compact summary. */
  readonly actionItems: readonly string[]
  /** Items the assistant has already completed within the current window. */
  readonly completed: readonly string[]
  readonly planFilePath?: string
}

export type CompactWindowReader = (sessionID: string) => Effect.Effect<CompactWindow | undefined>

/** Default reader — no compact-window data available. Replace once the
 * compact pipeline is ported. */
export const noCompactWindow: CompactWindowReader = () => Effect.succeed(undefined)

/**
 * Result of {@link runStepB}. Mirrors `PlanCheckResult` in autobest_extract.rs.
 */
export interface PlanCheckResult {
  readonly hasPlan: boolean
  readonly nextItem?: string
  readonly windowID?: number
  readonly snippet?: string
}

/**
 * Empty-followup decision (Step C / D) — port of
 * `EmptyFollowupDecision { AskWhatNext, AskWhereIsThePlan, Terminate }`.
 */
export type EmptyFollowupDecision =
  | { readonly kind: "c"; readonly action: "And what's next?"; readonly reason: "ask_what_next" }
  | { readonly kind: "c"; readonly action: "Where is the plan?"; readonly reason: "ask_where_is_plan" }
  | { readonly kind: "d"; readonly resultingAction: null; readonly reason: string }

/**
 * Generic step decision returned by {@link runSteps} — captures a single
 * orchestration tick.
 */
export type StepDecision =
  | { readonly kind: "a"; readonly reason: string; readonly action?: string }
  | { readonly kind: "b"; readonly reason: string; readonly action?: string; readonly planCheck?: PlanCheckResult }
  | { readonly kind: "c"; readonly reason: string; readonly action: string }
  | { readonly kind: "d"; readonly reason: string; readonly resultingAction: null }

export interface RunStepsInput {
  /** Step A output. */
  readonly stepACandidates: readonly Candidate[]
  /** Current cycle state (history-derived; immutable). */
  readonly cycle?: CycleState
  /** Cap on cycle iterations before forced termination. */
  readonly maxIterations: number
  /** Step B compact-window reader. Returns undefined when unavailable. */
  readonly compactWindow?: CompactWindow
  /** Whether to ask "where is the plan?" when Step B reports has_plan but no
   * unfinished items. Default false (matches the conservative TS port). */
  readonly askWhereIsPlanOnEmpty?: boolean
}

/**
 * Step B plan-check.
 *
 * Scans the compact-window action items for the next unfinished item; if the
 * assistant's recent output ignored an explicit plan step, emit a `b` decision
 * with the next item as the resulting action.
 *
 * Returns `undefined` when there is no compact window (gated off) or when the
 * window contains no plan information.
 */
export function runStepB(window?: CompactWindow): PlanCheckResult | undefined {
  if (!window) return undefined
  if (!window.actionItems.length) {
    return { hasPlan: false, windowID: window.id, snippet: window.snippet }
  }
  const completedSet = new Set(window.completed.map((s) => normalizePlanItem(s)))
  for (const item of window.actionItems) {
    if (!item.trim()) continue
    if (!completedSet.has(normalizePlanItem(item))) {
      return {
        hasPlan: true,
        nextItem: item.trim(),
        windowID: window.id,
        snippet: window.snippet,
      }
    }
  }
  return { hasPlan: true, windowID: window.id, snippet: window.snippet }
}

function normalizePlanItem(s: string): string {
  return s.trim().toLowerCase().replace(/^[-*\d.)\s]+/, "")
}

/**
 * Step C/D decision — port of `decide_empty_followup_from_flags`.
 *
 * Fires "And what's next?" once per cycle. Subsequent empty turns terminate
 * with kind="d". When `askWhereIsPlanOnEmpty=true` and the cycle has not yet
 * asked, falls back to the "Where is the plan?" prompt instead.
 */
export function decideEmptyFollowup(input: {
  cycle?: CycleState
  iteration: number
  maxIterations: number
  askWhereIsPlanOnEmpty?: boolean
}): EmptyFollowupDecision {
  const whatNextAsked = input.cycle?.whatNextAsked === true
  if (input.iteration >= input.maxIterations) {
    return { kind: "d", resultingAction: null, reason: "max_iterations" }
  }
  if (whatNextAsked) {
    return { kind: "d", resultingAction: null, reason: "what_next_already_asked" }
  }
  if (input.askWhereIsPlanOnEmpty === true) {
    return { kind: "c", action: "Where is the plan?", reason: "ask_where_is_plan" }
  }
  return { kind: "c", action: "And what's next?", reason: "ask_what_next" }
}

/**
 * Single-shot orchestration tick. Runs Step A → B → C → D sequentially using
 * the supplied Step A candidates. Returns the first non-A decision (or `kind:"a"`
 * when Step A produced candidates).
 */
export function runSteps(input: RunStepsInput): StepDecision {
  const iteration = input.cycle?.iteration ?? 0
  // Step A → if non-empty, the caller submits the top candidate themselves.
  if (input.stepACandidates.length > 0) {
    return {
      kind: "a",
      reason: "step_a_candidates",
      action: input.stepACandidates[0]!.key,
    }
  }
  // Step B — only when compact window available.
  const planCheck = runStepB(input.compactWindow)
  if (planCheck && planCheck.hasPlan && planCheck.nextItem) {
    return {
      kind: "b",
      reason: "plan_step_skipped",
      action: planCheck.nextItem,
      planCheck,
    }
  }
  // Step C / D — empty follow-up.
  const followup = decideEmptyFollowup({
    cycle: input.cycle,
    iteration,
    maxIterations: input.maxIterations,
    askWhereIsPlanOnEmpty: input.askWhereIsPlanOnEmpty,
  })
  if (followup.kind === "c") {
    return { kind: "c", reason: followup.reason, action: followup.action }
  }
  return { kind: "d", reason: followup.reason, resultingAction: null }
}

/** Result-narrowing helpers exported for callers / tests. */
export const isStepA = (d: StepDecision): d is Extract<StepDecision, { kind: "a" }> => d.kind === "a"
export const isStepB = (d: StepDecision): d is Extract<StepDecision, { kind: "b" }> => d.kind === "b"
export const isStepC = (d: StepDecision): d is Extract<StepDecision, { kind: "c" }> => d.kind === "c"
export const isStepD = (d: StepDecision): d is Extract<StepDecision, { kind: "d" }> => d.kind === "d"

/** Convenience — should the runLoop submit a synthetic user turn for this decision? */
export function shouldSubmit(decision: StepDecision): boolean {
  switch (decision.kind) {
    case "a":
    case "b":
    case "c":
      return typeof (decision as { action?: string }).action === "string"
    case "d":
      return false
  }
}

export type { StepKind }

// ---------------------------------------------------------------------------
// Effect-based orchestration (round 3)
// ---------------------------------------------------------------------------

/**
 * Effect variant of {@link runSteps} that pulls the compact window via a
 * {@link CompactWindowReader} and checks whether the assistant's tail ignored
 * any plan step. When a plan step is skipped, the decision is emitted with
 * `reason: "plan_step_skipped"` and `action` = the skipped item; otherwise
 * delegates to the pure {@link runSteps} path.
 *
 * # Plan-skip detection
 *
 * - `runStepB` returns the next-unfinished plan item.
 * - If `assistantTail` (last assistant text) mentions the item verbatim,
 *   treat it as implicitly addressed and fall through to Step C.
 * - Otherwise emit a Step B decision with `plan_step_skipped`.
 *
 * Callers pass the `assistantTail` directly rather than re-reading messages,
 * so tests and production share one code path.
 */
export function runStepsEffect(input: {
  readonly sessionID: string
  readonly stepACandidates: readonly Candidate[]
  readonly cycle?: CycleState
  readonly maxIterations: number
  readonly compactReader?: CompactWindowReader
  readonly assistantTail?: string
  readonly askWhereIsPlanOnEmpty?: boolean
}): Effect.Effect<StepDecision> {
  return Effect.gen(function* () {
    // Step A — unchanged.
    if (input.stepACandidates.length > 0) {
      return {
        kind: "a",
        reason: "step_a_candidates",
        action: input.stepACandidates[0]!.key,
      } satisfies StepDecision
    }

    // Step B — read compact window via the supplied reader (may be absent).
    const reader = input.compactReader ?? noCompactWindow
    const window = yield* reader(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const planCheck = runStepB(window)
    if (planCheck && planCheck.hasPlan && planCheck.nextItem) {
      // Plan-skip detection — if the assistant tail already mentions the
      // next item, treat as addressed and fall through to C/D.
      const skipped = assistantIgnoredPlan(planCheck.nextItem, input.assistantTail ?? "")
      if (skipped) {
        return {
          kind: "b",
          reason: "plan_step_skipped",
          action: planCheck.nextItem,
          planCheck,
        } satisfies StepDecision
      }
    }

    // Step C / D — empty follow-up.
    const iteration = input.cycle?.iteration ?? 0
    const followup = decideEmptyFollowup({
      cycle: input.cycle,
      iteration,
      maxIterations: input.maxIterations,
      askWhereIsPlanOnEmpty: input.askWhereIsPlanOnEmpty,
    })
    if (followup.kind === "c") {
      return { kind: "c", reason: followup.reason, action: followup.action } satisfies StepDecision
    }
    return { kind: "d", reason: followup.reason, resultingAction: null } satisfies StepDecision
  })
}

/**
 * Returns `true` when the assistant's tail appears to have SKIPPED the
 * supplied plan item — i.e. neither mentions it nor completes it.
 *
 * Heuristic:
 *   - strip the bullet/number prefix from the item
 *   - case-insensitive substring match against tail
 *   - item text must be >= 6 chars to avoid spurious "go" / "do" matches
 *
 * Exported for tests.
 */
export function assistantIgnoredPlan(planItem: string, tail: string): boolean {
  const trimmed = planItem.trim().replace(/^[-*\d.)\s]+/, "").toLowerCase()
  if (trimmed.length < 6) return false
  return !tail.toLowerCase().includes(trimmed)
}
