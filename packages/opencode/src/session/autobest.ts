import * as DateTime from "effect/DateTime"
import * as Autobest from "@/autobest"
import * as History from "@/history"
import type { SessionEvent } from "@/v2/session-event"

export function fromEvent(event: SessionEvent.Autobest) {
  return {
    ts: DateTime.toDateUtc(event.timestamp).getTime(),
    type: "autobest.state",
    sessionID: String(event.metadata?.sessionID ?? ""),
    active: event.active
      ? {
          key: event.active.key,
          ts: event.active.ts,
          source: event.active.source === "manual" ? "manual" : "auto",
          ...(event.active.score === undefined ? {} : { score: event.active.score }),
        }
      : undefined,
    selected: event.selected
      ? {
          key: event.selected.key,
          score: event.selected.score,
          ...(event.selected.reason ? { reason: [...event.selected.reason] } : {}),
        }
      : undefined,
    changed: event.changed,
    candidates: event.candidates.length,
    top: event.candidates[0]
      ? {
          key: event.candidates[0].key,
          score: event.candidates[0].score,
          ...(event.candidates[0].reason ? { reason: [...event.candidates[0].reason] } : {}),
        }
      : undefined,
    log: {
      active: event.active
        ? {
            key: event.active.key,
            ts: event.active.ts,
            source: event.active.source === "manual" ? "manual" : "auto",
            ...(event.active.score === undefined ? {} : { score: event.active.score }),
          }
        : undefined,
      selected: event.selected
        ? {
            key: event.selected.key,
            score: event.selected.score,
            ...(event.selected.reason ? { reason: [...event.selected.reason] } : {}),
          }
        : undefined,
      changed: event.changed,
      candidates: event.candidates.map((item) => ({
        key: item.key,
        score: item.score,
        ...(item.reason ? { reason: [...item.reason] } : {}),
      })),
    },
  } satisfies History.Event
}

export function resultEvent(input: {
  sessionID: string
  ts: number
  changed: boolean
  candidates: Autobest.Candidate[]
  resultingAction?: string | null
  selected?: Autobest.Candidate
}) {
  return {
    ts: input.ts,
    type: "autobest.result",
    sessionID: input.sessionID,
    resultingAction: input.resultingAction ?? null,
    ...(input.selected
      ? {
          selected: {
            key: input.selected.key,
            score: input.selected.score,
            ...(input.selected.reason ? { reason: [...input.selected.reason] } : {}),
          },
        }
      : {}),
    changed: input.changed,
    candidates: input.candidates.map((item) => ({
      key: item.key,
      score: item.score,
      ...(item.reason ? { reason: [...item.reason] } : {}),
    })),
  } satisfies History.Event
}

export function resultEventFromDecision(input: {
  sessionID: string
  ts?: number
  decision: Autobest.Decision
}) {
  return resultEvent({
    sessionID: input.sessionID,
    ts: input.decision.active?.ts ?? input.ts ?? Date.now(),
    resultingAction: input.decision.active?.key ?? null,
    selected: input.decision.selected,
    changed: input.decision.changed,
    candidates: input.decision.candidates,
  })
}

export async function append(sessionID: string, state: Autobest.State, input: { candidates: Autobest.Candidate[]; ts?: number }) {
  const out = Autobest.apply(state, input)
  await History.append(sessionID, {
    ts: input.ts ?? Date.now(),
    type: "autobest.state",
    sessionID,
    active: out.decision.active,
    selected: out.decision.selected,
    changed: out.decision.changed,
    candidates: out.decision.candidates.length,
    top: out.decision.candidates[0]
      ? {
          key: out.decision.candidates[0].key,
          score: out.decision.candidates[0].score,
          ...(out.decision.candidates[0].reason ? { reason: [...out.decision.candidates[0].reason] } : {}),
        }
      : undefined,
    log: {
      active: out.decision.active,
      selected: out.decision.selected,
      changed: out.decision.changed,
      candidates: out.decision.candidates.map((item) => ({
        key: item.key,
        score: item.score,
        ...(item.reason ? { reason: [...item.reason] } : {}),
      })),
    },
  })
  return out
}
