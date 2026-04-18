/**
 * MemCoder §3.2 — Refining gate (4-signal pure scorer + optional LLM polish).
 *
 * Port of `codex-rs/core/src/memories/refining.rs`. Two responsibilities:
 *
 *   1. **Pure 4-signal success scorer** (`scoreCandidate`) — runs without an
 *      LLM and decides whether a candidate `DefectSextuple` is worth
 *      keeping. Combines four cheap dialog-local signals:
 *
 *        - `objective` (weight 0.40): pass/fail markers in the tail summary
 *          ("test passed", "PASS", "all green", "0 errors", or the
 *          opposite — "FAIL", "panic", "error:", etc.).
 *        - `sentiment` (weight 0.30): the most recent user message tone
 *          (English + Russian + emoji vocabulary).
 *        - `circles` (weight 0.15): anti-loop — high Jaccard token overlap
 *          across the last 2-3 user messages drops the score (we're stuck).
 *        - `momentum` (weight 0.15): forward-progress vocabulary in the
 *          last user message ("next we", "moving on", "далее", …).
 *
 *      A candidate passes the gate when `total >= SCORE_KEEP_THRESHOLD`
 *      (default 0.5). Below that the LLM polisher is **never** invoked —
 *      important for cost and for tests that need to assert the
 *      short-circuit path.
 *
 *   2. **Optional LLM polish** (`refineSextuple`) — when the gate passes
 *      and a `model` callback is supplied, we send the candidate JSON +
 *      success-score summary into the polisher prompt. The model is
 *      expected to return a JSON object with `keywords`, `problem`,
 *      `root_cause`, `solution`. On any parse error the candidate is
 *      kept verbatim (mirror of the Rust "no fabrication" rule).
 *
 * Pure helpers (`tokenize`, `objectiveSignal`, `sentimentSignal`,
 * `circlesSignal`, `momentumSignal`, `scoreCandidate`,
 * `buildRefiningPrompt`, `parseRefiningResponse`) are kept synchronous
 * and free of any provider/account resolver dep so unit tests can
 * exercise every branch without spinning up a model client.
 */

import { Effect, Option } from "effect"

import type { DefectSextuple, DefectSextupleInput } from "./schema"
import { cleanKeywords, validateInput } from "./schema"

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Weights for the 4-signal scorer. Must sum to 1.0. */
export const W_OBJECTIVE = 0.4
export const W_SENTIMENT = 0.3
export const W_CIRCLES = 0.15
export const W_MOMENTUM = 0.15

/** Minimum total score required to send the candidate to the LLM polisher. */
export const SCORE_KEEP_THRESHOLD = 0.5

/** Jaccard overlap above this is considered "going in circles". */
export const CIRCLES_HIGH_OVERLAP = 0.6

/** Per-call timeout for the LLM polisher (ms). */
export const POLISH_TIMEOUT_MS = 60_000

/**
 * Verbatim copy of `core/templates/memories/refining_prompt.md`. Inlined
 * for the same reason as `query-synth.ts` (no `*.md` Bun loader). If
 * upstream changes, replace the entire string.
 */
export const REFINING_PROMPT_TEMPLATE = `You are a MemCoder refining sub-agent. Your job is to POLISH a raw
\`DefectSextuple\` candidate — not to invent new facts. The candidate was
produced upstream by phase-1 extraction or the commit crawler; some of its
fields may be vague, noisy, or oddly phrased. You must tighten them without
adding details that are not already supported by the raw evidence embedded
in the candidate itself (\`original_message\` and \`code_changes_summary\`).

STRICT RULES:

* Do NOT fabricate APIs, error messages, stack traces, or file names that do
  not already appear in the candidate's \`original_message\` or
  \`code_changes_summary\`. When in doubt, keep the original phrasing.
* Prefer VERBATIM QUOTES from the original evidence for \`keywords\` and
  \`root_cause\`. If a specific identifier, error string, or symbol appears in
  the original message or diff summary, reuse it exactly.
* \`keywords\` must be 3-8 lowercase tokens. Prefer concrete identifiers
  (function names, error codes, subsystem names) over vague nouns. These
  feed an embedding index, so they should be the words a future agent would
  naturally search for.
* \`problem\` must be one past-tense sentence describing the user-visible
  symptom. At least 20 characters.
* \`root_cause\` must name the concrete mechanical cause in one or two
  sentences, quoting identifiers from the evidence where possible.
* \`solution\` must describe the change that fixed the root cause and briefly
  explain why it works. Reference the changed function or invariant.

If the candidate is too thin to polish safely (empty problem, unknown root
cause, no usable evidence), return the candidate UNCHANGED in the same JSON
shape — do NOT invent content to fill the gaps.

OUTPUT ONLY a single JSON object with exactly these four fields (no markdown,
no code fences, no commentary before or after):

{
  "keywords":   ["..."],
  "problem":    "...",
  "root_cause": "...",
  "solution":   "..."
}

RAW CANDIDATE (as JSON):
{candidate_json}

SUCCESS SCORE FROM UPSTREAM SCORER (for your context — do not echo back):
{score_summary}`

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/**
 * 4-signal MemCoder "success proxy" score. Each component is in [0, 1] and
 * `total` is the weighted sum (see weights above).
 */
export interface SuccessScore {
  readonly objective: number
  readonly sentiment: number
  readonly circles: number
  readonly momentum: number
  readonly total: number
}

export interface RefiningInput {
  /** Raw sextuple (typed as `DefectSextuple` once stored, or input shape pre-store). */
  readonly candidate: RefiningCandidate
  /** Recent user messages (chronological — last entry is most recent). */
  readonly recentUserMessages: ReadonlyArray<string>
  /** Most recent tail summary (one of the tail-compactor outputs). */
  readonly tailSummary?: string
}

/**
 * Subset of `DefectSextuple` fields the refiner cares about. Accepting a
 * structural subset (rather than the full SQL row) lets callers pass either
 * pre-store inputs or already-stored records.
 */
export interface RefiningCandidate {
  readonly keywords: ReadonlyArray<string>
  readonly problem: string
  readonly rootCause: string
  readonly solution: string
}

export interface RefinedOutput {
  /** `null` when the gate rejected the candidate before any LLM call. */
  readonly refined: RefiningCandidate | null
  readonly score: SuccessScore
  readonly reason: string
  /** "gate-rejected" | "kept-verbatim" | "llm-polished" — useful for telemetry. */
  readonly path: "gate-rejected" | "kept-verbatim" | "llm-polished"
}

// --------------------------------------------------------------------------
// 4-signal scorer (pure)
// --------------------------------------------------------------------------

/**
 * Compute the 4-signal success score for a refining input. Pure +
 * synchronous; no LLM, no Session.
 */
export function scoreCandidate(input: RefiningInput): SuccessScore {
  const objective = objectiveSignal(input.tailSummary)
  const sentiment = sentimentSignal(input.recentUserMessages)
  const circles = circlesSignal(input.recentUserMessages)
  const momentum = momentumSignal(input.recentUserMessages)
  const total =
    W_OBJECTIVE * objective + W_SENTIMENT * sentiment + W_CIRCLES * circles + W_MOMENTUM * momentum
  return { objective, sentiment, circles, momentum, total }
}

/**
 * Parse the tail summary for pass/fail markers.
 *
 *   - Strong-positive markers ("test passed", "PASS", "all green", "0 errors",
 *     "successfully built", "successfully installed") → 1.0
 *   - Strong-negative markers ("test failed", "FAIL", "panic", "error:",
 *     "traceback", "compilation error") → 0.0
 *   - Otherwise / no summary → neutral 0.5
 */
export function objectiveSignal(tailSummary?: string): number {
  if (tailSummary === undefined) return 0.5
  const raw = tailSummary
  const lower = raw.toLowerCase()

  const NEGATIVE = [
    "test failed",
    "tests failed",
    "fail:",
    "failed.",
    "failed\n",
    " fail ",
    "panic",
    "traceback",
    "error:",
    "compilation error",
    "segfault",
    "abort",
  ]
  for (const needle of NEGATIVE) if (lower.includes(needle)) return 0.0
  // Standalone "FAIL" token in the original (case-sensitive) string.
  if (raw.split(/[^A-Za-z0-9]/).some((t) => t === "FAIL")) return 0.0

  const POSITIVE = [
    "test passed",
    "tests passed",
    "all green",
    "0 errors",
    "0 warnings",
    "no errors",
    "successfully built",
    "successfully installed",
    "build succeeded",
    "passed.",
    "passed\n",
    " pass ",
    "✅",
  ]
  for (const needle of POSITIVE) if (lower.includes(needle)) return 1.0
  if (raw.split(/[^A-Za-z0-9]/).some((t) => t === "PASS")) return 1.0

  return 0.5
}

export function sentimentSignal(messages: ReadonlyArray<string>): number {
  if (messages.length === 0) return 0.5
  const last = messages[messages.length - 1]!
  const lower = last.toLowerCase()

  const NEGATIVE = [
    "не работает",
    "не работало",
    "не пашет",
    "бесит",
    "бесят",
    "блять",
    "fuck",
    "shit",
    "broken",
    "still broken",
    "doesn't work",
    "doesnt work",
    "does not work",
    "garbage",
    "useless",
    "😡",
    "😤",
    "🤬",
  ]
  for (const needle of NEGATIVE) if (lower.includes(needle)) return 0.0

  const POSITIVE = [
    "perfect",
    "thanks",
    "thank you",
    "awesome",
    "great",
    "works!",
    "it works",
    "works now",
    "nice",
    "наконец",
    "работает",
    "заработало",
    "спасибо",
    "супер",
    "отлично",
    "✅",
    "🎉",
    "👍",
  ]
  for (const needle of POSITIVE) if (lower.includes(needle)) return 1.0

  return 0.5
}

/**
 * Anti-loop signal — Jaccard token overlap between the last 2-3 user
 * messages. High overlap (`> CIRCLES_HIGH_OVERLAP`) → 0.2 (stuck);
 * otherwise 1.0.
 */
export function circlesSignal(messages: ReadonlyArray<string>): number {
  const n = messages.length
  if (n < 2) return 1.0
  const last = messages[n - 1]!
  const prev = messages[n - 2]!
  const j1 = jaccard(last, prev)
  const overlap = n >= 3 ? (j1 + jaccard(prev, messages[n - 3]!)) / 2 : j1
  return overlap > CIRCLES_HIGH_OVERLAP ? 0.2 : 1.0
}

function jaccard(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 && tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

export function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of s.toLowerCase().split(/[^a-zA-Zа-яА-ЯёЁ0-9]+/)) {
    if (t.length >= 3) out.add(t)
  }
  return out
}

export function momentumSignal(messages: ReadonlyArray<string>): number {
  if (messages.length === 0) return 0.5
  const lower = messages[messages.length - 1]!.toLowerCase()
  const NEGATIVE = [
    "still stuck",
    "all over again",
    "same problem",
    "same issue",
    "again and again",
    "opyat'",
    "опять",
    "снова",
    "по кругу",
    "stuck on",
    "no progress",
    "going nowhere",
  ]
  for (const needle of NEGATIVE) if (lower.includes(needle)) return 0.0
  const POSITIVE = [
    "next we",
    "next,",
    "next up",
    "next step",
    "now let's",
    "now lets",
    "moving on",
    "далее",
    "дальше",
    "теперь",
    "let's move",
    "lets move",
    "onward",
    "proceed to",
  ]
  for (const needle of POSITIVE) if (lower.includes(needle)) return 1.0
  return 0.5
}

// --------------------------------------------------------------------------
// Prompt building / response parsing (pure)
// --------------------------------------------------------------------------

export function summarizeScore(score: SuccessScore): string {
  return `objective=${score.objective.toFixed(2)} sentiment=${score.sentiment.toFixed(2)} circles=${score.circles.toFixed(2)} momentum=${score.momentum.toFixed(2)} total=${score.total.toFixed(2)}`
}

export function buildRefiningPrompt(candidate: RefiningCandidate, score: SuccessScore): string {
  const candidateJson = JSON.stringify(
    {
      keywords: candidate.keywords,
      problem: candidate.problem,
      root_cause: candidate.rootCause,
      solution: candidate.solution,
    },
    null,
    2,
  )
  return REFINING_PROMPT_TEMPLATE.replace("{candidate_json}", candidateJson).replace(
    "{score_summary}",
    summarizeScore(score),
  )
}

/**
 * Locate the first balanced `{...}` JSON object in `s`. String-aware so
 * braces inside quoted strings don't confuse depth tracking. Reused from
 * `query-synth` semantics but inlined to keep this module self-contained.
 */
export function locateBalancedObject(s: string): string | undefined {
  let depth = 0
  let inString = false
  let escape = false
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && start !== -1) return s.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Parse a polish-stage LLM response. Tolerates code-fence wrappers and
 * surrounding chatter. Returns `null` on any parse / shape error so the
 * caller can fall back to the original candidate.
 */
export function parseRefiningResponse(raw: string): RefiningCandidate | null {
  const trimmed = raw.trim()
  // Strip code fences first.
  let body = trimmed
  if (body.startsWith("```json")) body = body.slice(7)
  else if (body.startsWith("```")) body = body.slice(3)
  if (body.endsWith("```")) body = body.slice(0, -3)
  body = body.trim()

  const obj = locateBalancedObject(body) ?? body
  let value: unknown
  try {
    value = JSON.parse(obj)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const keywordsRaw = v["keywords"]
  const problem = typeof v["problem"] === "string" ? (v["problem"] as string) : undefined
  const rootCause = typeof v["root_cause"] === "string" ? (v["root_cause"] as string) : undefined
  const solution = typeof v["solution"] === "string" ? (v["solution"] as string) : undefined
  if (!Array.isArray(keywordsRaw) || !problem || rootCause === undefined || !solution) return null
  const keywords = keywordsRaw.filter((x): x is string => typeof x === "string")
  return { keywords, problem, rootCause, solution }
}

// --------------------------------------------------------------------------
// Public entry points
// --------------------------------------------------------------------------

/** Caller-supplied LLM bridge — same shape as in `query-synth.ts`. */
export type RefiningModel = (prompt: string) => Effect.Effect<string | null, unknown>

export interface RefineSextupleOptions {
  /** Optional polisher LLM. When omitted, candidates that pass the gate are kept verbatim. */
  readonly model?: RefiningModel
  /** Override per-call timeout (ms). */
  readonly timeoutMs?: number
}

/**
 * Run the gate (and optionally the LLM polisher) over a candidate. Returns
 * a `RefinedOutput` documenting which path was taken; the caller decides
 * whether to persist `output.refined`.
 */
export function refineSextuple(
  input: RefiningInput,
  options: RefineSextupleOptions = {},
): Effect.Effect<RefinedOutput> {
  return Effect.gen(function* () {
    const score = scoreCandidate(input)
    if (score.total < SCORE_KEEP_THRESHOLD) {
      return {
        refined: null,
        score,
        reason: `score below threshold (${score.total.toFixed(2)} < ${SCORE_KEEP_THRESHOLD.toFixed(2)})`,
        path: "gate-rejected" as const,
      }
    }
    if (!options.model) {
      return {
        refined: input.candidate,
        score,
        reason: "kept verbatim (no model supplied)",
        path: "kept-verbatim" as const,
      }
    }
    const prompt = buildRefiningPrompt(input.candidate, score)
    const raw: string | null = yield* options
      .model(prompt)
      .pipe(
        Effect.timeoutOption(options.timeoutMs ?? POLISH_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(Option.none<string | null>())),
        Effect.map((opt) => Option.match(opt, { onNone: () => null, onSome: (v) => v ?? null })),
      )
    if (!raw) {
      return {
        refined: input.candidate,
        score,
        reason: "polish LLM unavailable — keeping candidate verbatim",
        path: "kept-verbatim" as const,
      }
    }
    const polished = parseRefiningResponse(raw)
    if (!polished) {
      return {
        refined: input.candidate,
        score,
        reason: "polish parse failure — keeping candidate verbatim",
        path: "kept-verbatim" as const,
      }
    }
    return {
      refined: polished,
      score,
      reason: "polish ok",
      path: "llm-polished" as const,
    }
  })
}

/**
 * Convenience: turn a refined candidate into a fully-formed
 * `DefectSextupleInput` ready for `MemoryStorage.store`. Strips empty
 * keywords + runs `validateInput`; returns `null` if the candidate is
 * still unsalvageable after polish.
 */
export function toSextupleInput(
  candidate: RefiningCandidate,
  source: DefectSextupleInput["source"],
  projectID?: string,
): DefectSextupleInput | null {
  const cleaned: DefectSextupleInput = {
    keywords: cleanKeywords(candidate.keywords),
    problem: candidate.problem.trim(),
    rootCause: candidate.rootCause.trim(),
    solution: candidate.solution.trim(),
    source,
    projectID,
  }
  const error = validateInput(cleaned)
  return error === undefined ? cleaned : null
}

// Re-export so consumers can refer to the type without crossing module boundaries.
export type { DefectSextuple }
