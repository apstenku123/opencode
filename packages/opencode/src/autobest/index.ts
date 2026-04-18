export type Candidate = {
  key: string
  score: number
  reason?: string[]
}

export type Pick = {
  key: string
  score?: number
  source: "manual" | "auto"
  ts: number
}

/** Step kind for post-turn continuation pipeline (A→B→C→D).
 * See `codex-rs/core/src/autobest_extract.rs::AutobestStep`. */
export type StepKind = "a" | "b" | "c" | "d"

/**
 * Per-session cycle state — tracks iteration count and the last step kind /
 * turn correlation to gate the auto-continue feedback loop.
 * Mirror of the Rust `Session::what_next_asks_used_this_cycle` +
 * `where_is_plan_asks_used_this_cycle` + iteration bookkeeping from
 * `autobest_extract.rs`.
 *
 * # Cycle flags
 *
 *   - `whatNextAsked`: true after Step C has fired "And what's next?" at
 *     least once. Prevents re-asking in the same cycle.
 *   - `whereIsPlanAsked`: true after Step C has fired "Where is the plan?"
 *     at least once. Symmetric with `whatNextAsked`.
 *   - `stagnationCount`: monotonic counter incremented each time the
 *     observer observes a Step A empty / Step B plan-skip ping-pong.
 *     Decremented on a forward-progress signal (Step A with fresh
 *     candidates + changed plan). Mirrors Rust `autosteering_stagnation_count`.
 */
export type CycleState = {
  iteration: number
  stepKind: StepKind
  turnID?: string
  whatNextAsked?: boolean
  whereIsPlanAsked?: boolean
  stagnationCount?: number
}

/**
 * Per-session autobest cycle configuration. Values mirror Rust's `Session`
 * bag exposed to `run_step_b` / `decide_empty_followup`. When a flag is
 * `undefined` the observer falls back to the conservative default
 * documented below.
 */
export type CycleConfig = {
  /**
   * When true AND the cycle has not yet asked, Step C issues
   * "Where is the plan?" instead of "And what's next?". Matches
   * Rust's `ask_where_is_plan_on_empty`. Default: `false`.
   */
  askWhereIsPlanOnEmpty?: boolean
  /**
   * Cap on cycle iterations before Step D terminates regardless of
   * candidate availability. Mirrors Rust `max_autobest_iterations`.
   * Default: `3`.
   */
  maxIterations?: number
  /**
   * When true, the observer resets the cycle (iteration=0) whenever a
   * user message arrives that does not match a stop pattern. Matches
   * Rust `reset_cycle_on_user_turn`. Default: `true`.
   */
  resetOnUserTurn?: boolean
}

export type State = {
  active?: Pick
  picks: Pick[]
  cycle?: CycleState
}

export type Decision = {
  active?: Pick
  candidates: Candidate[]
  selected?: Candidate
  changed: boolean
}

export function empty(): State {
  return { picks: [] }
}

/** Default values for {@link CycleConfig} — exported for tests + observer. */
export const DEFAULT_CYCLE_CONFIG: Required<CycleConfig> = {
  askWhereIsPlanOnEmpty: false,
  maxIterations: 3,
  resetOnUserTurn: true,
}

/**
 * Merge a user-supplied {@link CycleConfig} override on top of
 * {@link DEFAULT_CYCLE_CONFIG}. Unknown / undefined keys fall through to
 * the default. Pure helper.
 */
export function resolveCycleConfig(override?: CycleConfig): Required<CycleConfig> {
  const src = override ?? {}
  return {
    askWhereIsPlanOnEmpty: src.askWhereIsPlanOnEmpty ?? DEFAULT_CYCLE_CONFIG.askWhereIsPlanOnEmpty,
    maxIterations: src.maxIterations ?? DEFAULT_CYCLE_CONFIG.maxIterations,
    resetOnUserTurn: src.resetOnUserTurn ?? DEFAULT_CYCLE_CONFIG.resetOnUserTurn,
  }
}

/**
 * Advance the cycle state — called each time the observer applies a Step A/B/C/D result.
 * Returns a new state with iteration+1 and the provided stepKind / turnID.
 */
export function advanceCycle(
  state: State,
  input: {
    stepKind: StepKind
    turnID?: string
    whatNextAsked?: boolean
    whereIsPlanAsked?: boolean
    stagnationDelta?: number
  },
): State {
  const prev = state.cycle ?? { iteration: 0, stepKind: "a" as StepKind }
  const baseStagnation = prev.stagnationCount ?? 0
  const delta = input.stagnationDelta ?? 0
  return {
    ...state,
    cycle: {
      iteration: prev.iteration + 1,
      stepKind: input.stepKind,
      turnID: input.turnID ?? prev.turnID,
      whatNextAsked: input.whatNextAsked ?? prev.whatNextAsked,
      whereIsPlanAsked: input.whereIsPlanAsked ?? prev.whereIsPlanAsked,
      stagnationCount: Math.max(0, baseStagnation + delta),
    },
  }
}

/** Reset the cycle. Matches `reset_what_next_cycle` in Rust. */
export function resetCycle(state: State): State {
  return {
    ...state,
    cycle: { iteration: 0, stepKind: "a" },
  }
}

export function setActive(state: State, input: { key: string; source?: Pick["source"]; ts?: number; score?: number }) {
  const next = {
    key: input.key,
    score: input.score,
    source: input.source ?? "manual",
    ts: input.ts ?? Date.now(),
  } satisfies Pick
  return {
    active: next,
    picks: [...state.picks, next],
  } satisfies State
}

export function extract(input: { candidates: Candidate[]; active?: string }) {
  const ranked = [...input.candidates].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.key.localeCompare(b.key)
  })
  return {
    active: input.active,
    candidates: ranked,
    top: ranked[0]?.key,
  }
}

export function decide(state: State, input: { candidates: Candidate[]; ts?: number }) {
  const view = extract({ candidates: input.candidates, active: state.active?.key })
  const top = view.candidates[0]
  if (!top) {
    return {
      active: state.active,
      candidates: [],
      selected: undefined,
      changed: false,
    } satisfies Decision
  }
  const changed = top.key !== state.active?.key
  return {
    active: changed
      ? {
          key: top.key,
          score: top.score,
          source: "auto",
          ts: input.ts ?? Date.now(),
        }
      : state.active,
    candidates: view.candidates,
    selected: top,
    changed,
  } satisfies Decision
}

export function apply(state: State, input: { candidates: Candidate[]; ts?: number }) {
  const out = decide(state, input)
  if (!out.active) return { state, decision: out }
  if (!out.changed) return { state, decision: out }
  const next = setActive(state, {
    key: out.active.key,
    source: out.active.source,
    ts: out.active.ts,
    score: out.active.score,
  })
  return { state: next, decision: { ...out, active: next.active } }
}

// ---------------------------------------------------------------------------
// Cycle history-event shapes (round 2)
// ---------------------------------------------------------------------------

/**
 * Durable cycle event types written to the per-session history JSONL.
 * Replaces the in-memory `Map<sessionID, CycleState>` left by round 1.
 *
 * Mirrors `Session::what_next_asks_used_this_cycle` etc. — survives process
 * restart and thread resume.
 */
export type CycleEvent =
  | {
      readonly ts: number
      readonly type: "autobest.cycle.advance"
      readonly sessionID: string
      readonly stepKind: StepKind
      readonly turnID?: string
      readonly whatNextAsked?: boolean
      /** New in R6: symmetric flag for `askWhereIsPlanOnEmpty`. */
      readonly whereIsPlanAsked?: boolean
      readonly iteration: number
      /** New in R6: stagnation counter for autosteer (parity with Rust). */
      readonly stagnationCount?: number
      readonly reason?: string
    }
  | {
      readonly ts: number
      readonly type: "autobest.cycle.reset"
      readonly sessionID: string
      readonly reason?: string
    }

/**
 * Reduce a stream of {@link CycleEvent}s into the latest {@link CycleState}.
 * `reset` zeroes iteration / whatNextAsked. `advance` takes the explicit
 * iteration value (caller-supplied, monotonic per cycle).
 *
 * Used by `Session.getAutobest` to hydrate the cycle bag on read.
 */
export function reduceCycleEvents(events: readonly CycleEvent[]): CycleState | undefined {
  let state: CycleState | undefined = undefined
  for (const ev of events) {
    if (ev.type === "autobest.cycle.reset") {
      state = { iteration: 0, stepKind: "a" }
      continue
    }
    if (ev.type === "autobest.cycle.advance") {
      state = {
        iteration: ev.iteration,
        stepKind: ev.stepKind,
        turnID: ev.turnID ?? state?.turnID,
        whatNextAsked: ev.whatNextAsked ?? state?.whatNextAsked,
        whereIsPlanAsked: ev.whereIsPlanAsked ?? state?.whereIsPlanAsked,
        stagnationCount: ev.stagnationCount ?? state?.stagnationCount,
      }
      continue
    }
  }
  return state
}

/** Build a `cycle.advance` event from a state delta. Pure helper — caller persists. */
export function buildCycleAdvanceEvent(input: {
  sessionID: string
  cycle: CycleState
  ts?: number
  reason?: string
}): Extract<CycleEvent, { type: "autobest.cycle.advance" }> {
  return {
    ts: input.ts ?? Date.now(),
    type: "autobest.cycle.advance",
    sessionID: input.sessionID,
    stepKind: input.cycle.stepKind,
    turnID: input.cycle.turnID,
    whatNextAsked: input.cycle.whatNextAsked,
    whereIsPlanAsked: input.cycle.whereIsPlanAsked,
    iteration: input.cycle.iteration,
    stagnationCount: input.cycle.stagnationCount,
    reason: input.reason,
  }
}

/** Build a `cycle.reset` event. Pure helper — caller persists. */
export function buildCycleResetEvent(input: {
  sessionID: string
  ts?: number
  reason?: string
}): Extract<CycleEvent, { type: "autobest.cycle.reset" }> {
  return {
    ts: input.ts ?? Date.now(),
    type: "autobest.cycle.reset",
    sessionID: input.sessionID,
    reason: input.reason,
  }
}
