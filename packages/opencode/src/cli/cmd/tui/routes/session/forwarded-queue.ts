/**
 * Pure-logic FIFO queue for forwarded child-session questions.
 *
 * The guardian (see {@link Guardian} in `src/subagent/guardian.ts`) emits
 * `Question.Event.ForwardedToParent` whenever a child session asks a
 * question that can't be auto-resolved against the parent's ruleset.
 *
 * The TUI groups these by `parentID` (the parent session that owns the
 * UI). The parent session renders the head entry as an inline prompt;
 * once the user replies/rejects, the corresponding requestID is dropped
 * from the queue so the next forwarded question can surface.
 *
 * The reducer below is intentionally decoupled from Solid stores so
 * ordering/dismiss logic is covered by unit tests without rendering.
 */
import type { QuestionForwardedToParent } from "@opencode-ai/sdk/v2"

export type ForwardedEntry = QuestionForwardedToParent

export interface ForwardedQueueState {
  /** Map keyed by parentID. Values are FIFO ordered by arrival. */
  readonly byParent: Readonly<Record<string, ReadonlyArray<ForwardedEntry>>>
}

export const ForwardedQueue = {
  empty(): ForwardedQueueState {
    return { byParent: {} }
  },

  /**
   * Append a forwarded entry for `parentID`. If the same `requestID` is
   * already queued (duplicate bus delivery), the queue is returned
   * unchanged — we dedupe on requestID since the guardian may resend on
   * re-evaluation.
   */
  push(state: ForwardedQueueState, entry: ForwardedEntry): ForwardedQueueState {
    const existing = state.byParent[entry.parentID] ?? []
    if (existing.some((x) => x.requestID === entry.requestID)) {
      return state
    }
    return {
      byParent: {
        ...state.byParent,
        [entry.parentID]: [...existing, entry],
      },
    }
  },

  /**
   * Return all queued entries for `parentID` in FIFO order.
   */
  list(state: ForwardedQueueState, parentID: string): ReadonlyArray<ForwardedEntry> {
    return state.byParent[parentID] ?? []
  },

  /**
   * Head of the queue for `parentID`, or undefined when empty.
   */
  head(state: ForwardedQueueState, parentID: string): ForwardedEntry | undefined {
    const queue = state.byParent[parentID]
    if (!queue || queue.length === 0) return undefined
    return queue[0]
  },

  /**
   * Remove the entry with `requestID` from any parent queue. Used when
   * the parent replies/rejects, or when `question.replied`/`question.rejected`
   * arrive for a previously forwarded question.
   */
  dismissByRequestID(state: ForwardedQueueState, requestID: string): ForwardedQueueState {
    let changed = false
    const next: Record<string, ReadonlyArray<ForwardedEntry>> = {}
    for (const [parentID, queue] of Object.entries(state.byParent)) {
      const filtered = queue.filter((x) => x.requestID !== requestID)
      if (filtered.length !== queue.length) changed = true
      if (filtered.length > 0) next[parentID] = filtered
    }
    if (!changed) return state
    return { byParent: next }
  },
}
