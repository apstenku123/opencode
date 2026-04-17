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
 * Mirror of the Rust `Session::what_next_asks_used_this_cycle` + iteration
 * bookkeeping from `autobest_extract.rs`.
 */
export type CycleState = {
  iteration: number
  stepKind: StepKind
  turnID?: string
  whatNextAsked?: boolean
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

/**
 * Advance the cycle state — called each time the observer applies a Step A/B/C/D result.
 * Returns a new state with iteration+1 and the provided stepKind / turnID.
 */
export function advanceCycle(
  state: State,
  input: { stepKind: StepKind; turnID?: string; whatNextAsked?: boolean },
): State {
  const prev = state.cycle ?? { iteration: 0, stepKind: "a" as StepKind }
  return {
    ...state,
    cycle: {
      iteration: prev.iteration + 1,
      stepKind: input.stepKind,
      turnID: input.turnID ?? prev.turnID,
      whatNextAsked: input.whatNextAsked ?? prev.whatNextAsked,
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
