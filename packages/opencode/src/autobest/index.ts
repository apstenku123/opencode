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

export type State = {
  active?: Pick
  picks: Pick[]
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
