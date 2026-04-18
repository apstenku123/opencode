/**
 * Stage-2 LLM cross-encoder rerank for memory retrieval.
 *
 * Port of the rerank pipeline in `codex-rs/core/src/memories/retrieval.rs`.
 * The retrieval flow is:
 *
 *   1. Stage-1 cosine ranking (already implemented in
 *      `packages/opencode/src/memory/retrieval.ts`).
 *   2. Stage-2 LLM cross-encoder rerank (this module): take the top-N
 *      stage-1 candidates and ask an LLM to score each one 0-10 against
 *      the query. Batched to at most `RERANK_BATCH_LIMIT` items per call.
 *   3. Score merge: `final = STAGE1_WEIGHT * cosine + STAGE2_WEIGHT * rerank/10`.
 *      Drop everything below `minScore` (default 0.4).
 *
 * The LLM bridge is injected by the caller (same pattern as `query-synth`
 * / `phase1` / `refining`) so this module stays free of provider deps.
 *
 * Pure helpers (`buildRerankPrompt`, `parseRerankResponse`, `mergeScores`,
 * `truncateForPrompt`) are kept synchronous for unit tests.
 */

import { Effect, Option } from "effect"

import type { ScoredSextuple } from "./retrieval"

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Maximum candidates we send to the rerank LLM per batched call. */
export const RERANK_BATCH_LIMIT = 20
/** Pool multiplier on the stage-1 top-N before reranking (matches Rust `STAGE1_POOL_MULTIPLIER`). */
export const STAGE1_POOL_MULTIPLIER = 4
/** Score-merge weights — must sum to 1.0. */
export const STAGE1_WEIGHT = 0.3
export const STAGE2_WEIGHT = 0.7
/** Default `minScore` filter (matches Rust `memories_retrieval_min_score`). */
export const DEFAULT_MIN_SCORE = 0.4
/** Per-call timeout for the rerank LLM (ms). */
export const RERANK_TIMEOUT_MS = 60_000

/**
 * Verbatim copy of `core/templates/memories/rerank_prompt.md`.
 */
export const RERANK_PROMPT_TEMPLATE = `You are a relevance scorer for a defect-memory retrieval system.

Given a search query and a list of candidate memories (each a
problem + solution description), score each candidate 0-10 for
how likely it is to help solve the query.

- 10 = same root cause, solution directly applies
- 7-9 = very similar symptom/domain, solution partially applies
- 4-6 = related area but different root cause
- 1-3 = weakly related via keywords only
- 0 = unrelated

Output ONLY a JSON object:
{"scores": [score_1, score_2, ..., score_n]}

— one integer per candidate, in the same order as listed below.

## Query

{query}

## Candidates

{candidates_numbered}

## Output`

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

/** Truncate `s` to at most `maxChars` UTF-16 code units, appending "…". */
export function truncateForPrompt(s: string, maxChars = 280): string {
  // For prompt budgeting we count characters (UTF-16 units) not bytes; this
  // matches the Rust `s.chars().take(max_chars)` behavior closely enough
  // for the rerank prompt's purpose (everything inside latin / cyrillic /
  // CJK ranges falls in 1-2 BMP units which is what the stored sextuples
  // overwhelmingly use).
  const trimmed = s.trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, Math.max(0, maxChars - 1)) + "…"
}

/** Build the rerank prompt, substituting `{query}` and `{candidates_numbered}`. */
export function buildRerankPrompt(query: string, candidates: ReadonlyArray<ScoredSextuple>): string {
  const numbered = candidates
    .map((c, i) => {
      const sx = c.record
      return `${i + 1}. Problem: ${truncateForPrompt(sx.problem)}\n   Root cause: ${truncateForPrompt(sx.rootCause)}\n   Solution: ${truncateForPrompt(sx.solution)}`
    })
    .join("\n\n")
  return RERANK_PROMPT_TEMPLATE.replace("{query}", query).replace(
    "{candidates_numbered}",
    numbered,
  )
}

function locateBalancedObject(s: string): string | undefined {
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
 * Parse the rerank LLM response into a list of integer scores in [0, 10].
 * Tolerates code-fence wrappers, surrounding chatter, and floats (clamped
 * + rounded). Returns `null` when the response is unparseable or the
 * length doesn't match `expectedLen`.
 */
export function parseRerankResponse(raw: string, expectedLen: number): number[] | null {
  let body = raw.trim()
  if (body.startsWith("```json")) body = body.slice(7)
  else if (body.startsWith("```")) body = body.slice(3)
  if (body.endsWith("```")) body = body.slice(0, -3)
  body = body.trim()
  const objText = locateBalancedObject(body) ?? body
  let parsed: unknown
  try {
    parsed = JSON.parse(objText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const scoresRaw = (parsed as Record<string, unknown>)["scores"]
  if (!Array.isArray(scoresRaw)) return null
  if (scoresRaw.length !== expectedLen) return null
  const out: number[] = []
  for (const v of scoresRaw) {
    const n = typeof v === "number" ? v : Number(v)
    if (!Number.isFinite(n)) return null
    out.push(Math.round(Math.max(0, Math.min(10, n))))
  }
  return out
}

/**
 * Merge stage-1 cosine scores with stage-2 rerank scores using the
 * `0.3 / 0.7` weighting. When `rerankScores` is `null` (parse failed),
 * the result preserves stage-1 ordering and uses the raw cosine so
 * downstream filtering remains usable.
 */
export function mergeScores(
  stage1: ReadonlyArray<ScoredSextuple>,
  rerankScores: ReadonlyArray<number> | null,
): ScoredSextuple[] {
  if (rerankScores && rerankScores.length === stage1.length) {
    return stage1.map((c, i) => ({
      record: c.record,
      score: STAGE1_WEIGHT * c.score + STAGE2_WEIGHT * (rerankScores[i]! / 10),
    }))
  }
  return stage1.map((c) => ({ record: c.record, score: c.score }))
}

/** Apply a `minScore` floor + sort descending (stable on `hashId` ties). */
export function filterAndSort(
  scored: ReadonlyArray<ScoredSextuple>,
  minScore: number,
  topK: number,
): ScoredSextuple[] {
  const passing = scored.filter((s) => s.score >= minScore).slice()
  passing.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.record.hashId.localeCompare(b.record.hashId)
  })
  if (topK > 0 && passing.length > topK) passing.length = topK
  return passing
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

export type RerankModel = (prompt: string) => Effect.Effect<string | null, unknown>

export interface RerankInput {
  readonly query: string
  readonly stage1: ReadonlyArray<ScoredSextuple>
  /** Optional LLM bridge — when omitted, stage-1 scores pass through unchanged. */
  readonly model?: RerankModel
  /** Override per-call timeout (ms). */
  readonly timeoutMs?: number
  /** Override the cosine→merged minScore floor (default `DEFAULT_MIN_SCORE`). */
  readonly minScore?: number
  /** Final cap on the returned list. */
  readonly topK?: number
}

export interface RerankResult {
  readonly hits: ScoredSextuple[]
  readonly reason: "no-model" | "no-candidates" | "llm-error" | "parse-error" | "ok"
}

/**
 * Stage-2 rerank entry point. Batches up to `RERANK_BATCH_LIMIT` candidates
 * per LLM call, merges stage-1+stage-2 scores per the weighted formula,
 * applies the `minScore` floor, and returns the top-K.
 */
export function rerank(input: RerankInput): Effect.Effect<RerankResult> {
  return Effect.gen(function* () {
    const { query, stage1 } = input
    const minScore = input.minScore ?? DEFAULT_MIN_SCORE
    const topK = input.topK ?? Math.max(1, Math.floor(stage1.length / STAGE1_POOL_MULTIPLIER))

    if (stage1.length === 0) {
      return { hits: [], reason: "no-candidates" as const }
    }
    if (!input.model) {
      return {
        hits: filterAndSort(stage1, minScore, topK),
        reason: "no-model" as const,
      }
    }

    // Process in batches; each batch produces a `number[]` aligned to its candidates.
    const merged: ScoredSextuple[] = []
    let sawError = false
    let sawParseError = false
    for (let i = 0; i < stage1.length; i += RERANK_BATCH_LIMIT) {
      const batch = stage1.slice(i, i + RERANK_BATCH_LIMIT)
      const prompt = buildRerankPrompt(query, batch)
      const raw: string | null = yield* input
        .model(prompt)
        .pipe(
          Effect.timeoutOption(input.timeoutMs ?? RERANK_TIMEOUT_MS),
          Effect.catchCause(() => Effect.succeed(Option.none<string | null>())),
          Effect.map((opt) => Option.match(opt, { onNone: () => null, onSome: (v) => v ?? null })),
        )
      if (!raw) {
        sawError = true
        merged.push(...mergeScores(batch, null))
        continue
      }
      const scores = parseRerankResponse(raw, batch.length)
      if (!scores) {
        sawParseError = true
        merged.push(...mergeScores(batch, null))
        continue
      }
      merged.push(...mergeScores(batch, scores))
    }
    const hits = filterAndSort(merged, minScore, topK)
    const reason = sawError ? "llm-error" : sawParseError ? "parse-error" : "ok"
    return { hits, reason }
  })
}

