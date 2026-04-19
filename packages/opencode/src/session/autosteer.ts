/**
 * Pure heuristics for autosteer / stagnation detection.
 *
 * Ported from codex-rs `core/src/codex.rs:4861-4958` (`check_core_autosteering`).
 * Detects two kinds of stagnation in successive assistant replies:
 *   1. Planning-only responses — contain "I will now" / "my plan is" / etc.
 *      but lack any action markers (fenced code blocks, Edited/Created/Ran).
 *   2. Near-duplicate responses — Jaccard similarity > 0.85 on the first
 *      500 characters (prefix-Jaccard to mirror the Rust TUI byte-prefix
 *      variant while staying Unicode-safe on the TS side).
 *
 * After two consecutive stagnations the caller should inject a canned
 * user-role nudge asking the model to actually execute.
 */
export namespace SessionAutosteer {
  /** Consecutive stagnation count at which a nudge is injected. */
  export const STAGNATION_TRIGGER = 2

  /** Jaccard similarity threshold above which two responses are "the same". */
  export const SIMILARITY_THRESHOLD = 0.85

  /** Prefix window used for similarity comparison (first N chars). */
  export const SIMILARITY_PREFIX_CHARS = 500

  /**
   * Lowercase planning phrases. Presence of any indicates "planning-only"
   * intent. Sourced from codex-rs `core/src/codex.rs`.
   */
  export const PLANNING_PHRASES = [
    "i will now",
    "i'll now",
    "let me now",
    "next step is",
    "my plan is",
    "i'm going to",
    "here's my plan",
    "here's the plan",
    "i'll start by",
    "the approach is",
    "i need to",
    "first, i'll",
  ] as const

  /**
   * Markers whose presence indicates concrete action was taken in the reply.
   * Any of these disables the planning-only classification.
   */
  export const ACTION_MARKERS = ["```", "Edited ", "Created ", "Ran "] as const

  /** Canned nudge message appended as a user turn after STAGNATION_TRIGGER hits. */
  export const NUDGE_TEXT =
    "You've been planning/explaining. Please actually execute the next step using tools now."

  export interface State {
    /** Previous assistant response (first SIMILARITY_PREFIX_CHARS chars retained). */
    previousResponse?: string
    /** Number of consecutive stagnant turns detected so far. */
    stagnationCount: number
  }

  export const initialState: State = { stagnationCount: 0 }

  /**
   * Optional overrides for the heuristic. Any field left undefined falls
   * back to the corresponding `SessionAutosteer.*` constant. Plumbed through
   * config (`autosteering.{stagnationTrigger,similarityThreshold,...}`) so
   * users can tune detection without recompiling.
   */
  export interface Thresholds {
    stagnationTrigger?: number
    similarityThreshold?: number
    minResponseLength?: number
    planningPhrases?: ReadonlyArray<string>
    actionMarkers?: ReadonlyArray<string>
  }

  /** True iff `text` contains a planning phrase AND no action marker. */
  export function isPlanningOnly(text: string, thresholds?: Thresholds): boolean {
    if (!text) return false
    const phrases = thresholds?.planningPhrases ?? PLANNING_PHRASES
    if (phrases.length === 0) return false
    const lower = text.toLowerCase()
    const hasPlanning = phrases.some((p) => lower.includes(p.toLowerCase()))
    if (!hasPlanning) return false
    return !hasActionMarkers(text, thresholds)
  }

  /** True iff `text` shows any concrete action marker (code fence, Edited/Created/Ran). */
  export function hasActionMarkers(text: string, thresholds?: Thresholds): boolean {
    if (!text) return false
    const markers = thresholds?.actionMarkers ?? ACTION_MARKERS
    for (const marker of markers) {
      if (text.includes(marker)) return true
    }
    return false
  }

  /**
   * Jaccard similarity between the whitespace-tokenised word sets of `a` and `b`.
   * Returns 1 for two empty strings (they are trivially identical).
   */
  export function jaccardSimilarity(a: string, b: string): number {
    const wa = tokenize(a)
    const wb = tokenize(b)
    if (wa.size === 0 && wb.size === 0) return 1
    if (wa.size === 0 || wb.size === 0) return 0
    let intersection = 0
    for (const w of wa) if (wb.has(w)) intersection++
    const union = wa.size + wb.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  function tokenize(s: string): Set<string> {
    return new Set(
      s
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    )
  }

  /**
   * Reason codes reported by {@link detectStagnationDetailed}. Distinguishing
   * the two paths lets {@link evaluate} weight similarity hits differently:
   * a similarity detection already implies TWO consecutive near-identical
   * replies (current + prior), so counting it as a single-turn increment
   * underweights the signal — the nudge would require a third similar turn
   * before firing. See `test_jaccard_similarity_above_threshold_triggers`
   * (tests-e2e/test_autosteer.py) for the regression this guards.
   */
  export type StagnationReason = "planning" | "similarity" | "none"

  /**
   * Pure-function detector. Given the previous response (via state) and the
   * new `response`, decide whether it is stagnant. Mirrors the Rust planning
   * + similarity logic but leaves counter/injection decisions to `evaluate`.
   *
   * Thresholds are optional — defaults reproduce the Rust behaviour.
   * Plumbed through `evaluate(state, response, thresholds)` and ultimately
   * fed by config (`autosteering.{similarityThreshold,...}`).
   */
  export function detectStagnation(
    previous: string | undefined,
    response: string,
    thresholds?: Thresholds,
  ): boolean {
    return detectStagnationDetailed(previous, response, thresholds) !== "none"
  }

  /**
   * Detailed variant of {@link detectStagnation} — returns which heuristic
   * branch tripped (or `"none"`). Used by {@link evaluate} to give the
   * similarity path a stronger per-hit weight since a similarity match
   * inherently observes TWO consecutive replies.
   */
  export function detectStagnationDetailed(
    previous: string | undefined,
    response: string,
    thresholds?: Thresholds,
  ): StagnationReason {
    if (!response || !response.trim()) return "none"
    const minLen = thresholds?.minResponseLength ?? 0
    if (minLen > 0 && response.length < minLen) return "none"
    // Action markers (```, Edited, Created, Ran) indicate concrete work —
    // the reply is not stagnant regardless of planning phrases or surface
    // similarity to the prior turn. This guard must run BEFORE the
    // similarity check to honour `test_action_markers_skip_nudge`: two
    // replies that both contain the same fenced code block are lexically
    // similar but operationally progressing.
    if (hasActionMarkers(response, thresholds)) return "none"
    if (isPlanningOnly(response, thresholds)) return "planning"
    if (previous && previous.trim()) {
      const a = response.slice(0, SIMILARITY_PREFIX_CHARS)
      const b = previous.slice(0, SIMILARITY_PREFIX_CHARS)
      const threshold = thresholds?.similarityThreshold ?? SIMILARITY_THRESHOLD
      if (jaccardSimilarity(a, b) > threshold) return "similarity"
    }
    return "none"
  }

  export interface Evaluation {
    /** True iff the caller should inject the canned nudge this turn. */
    nudge: boolean
    /** Next state to persist for this session. */
    nextState: State
    /** True iff this turn was classified as stagnant (informational). */
    stagnant: boolean
  }

  /**
   * Evaluate a fresh assistant response against prior state.
   *
   * Logic mirrors `check_core_autosteering` with one refinement: a
   * similarity-path detection bumps the stagnation counter by 2 instead
   * of 1 because a similarity hit inherently involves TWO consecutive
   * near-identical replies (current + prior). Planning detections still
   * increment by 1 per turn since each turn is independently assessed.
   *
   *   - skip empty/whitespace messages (returns previous state unchanged,
   *     stagnant=false, nudge=false)
   *   - planning-only turn → counter += 1
   *   - similarity-above-threshold turn → counter += 2 (fires nudge on
   *     the SECOND similar reply — aligned with the test expectation
   *     that two verbatim echoes trigger the canned nudge)
   *   - if not stagnant, reset the counter to 0
   *   - always remember the last response for next time
   */
  export function evaluate(state: State, response: string, thresholds?: Thresholds): Evaluation {
    if (!response || !response.trim()) {
      return { nudge: false, nextState: state, stagnant: false }
    }
    const prev = state.previousResponse
    const reason = detectStagnationDetailed(prev, response, thresholds)
    const nextPrev = response.slice(0, SIMILARITY_PREFIX_CHARS)
    if (reason !== "none") {
      // Similarity detections imply two observed replies; count as 2.
      const weight = reason === "similarity" ? 2 : 1
      const nextCount = state.stagnationCount + weight
      const trigger = thresholds?.stagnationTrigger ?? STAGNATION_TRIGGER
      const nudge = nextCount >= trigger
      return {
        nudge,
        stagnant: true,
        nextState: {
          previousResponse: nextPrev,
          // After emitting a nudge, reset so a third consecutive stagnant
          // reply doesn't fire again immediately — matches Rust's implicit
          // "only one nudge per streak" behavior (counter is tested `>= 2`
          // but the injected user turn typically breaks the pattern).
          stagnationCount: nudge ? 0 : nextCount,
        },
      }
    }
    return {
      nudge: false,
      stagnant: false,
      nextState: { previousResponse: nextPrev, stagnationCount: 0 },
    }
  }
}
