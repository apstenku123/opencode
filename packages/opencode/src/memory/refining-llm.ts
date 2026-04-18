/**
 * LLM polish layer for `DefectSextuple` candidates.
 *
 * Port of the polish path in `codex-rs/core/src/memories/refining.rs`.
 * Round 6 (Stream H) factored this path out of `refining.ts` into a
 * dedicated module so call-sites can reach for it explicitly when they
 * already have a `SuccessScore` in hand (e.g. the batched rolled-up
 * extractor) without re-running the 4-signal scorer.
 *
 * # Contract
 *
 *   - Input: an already-scored candidate + its score + a polisher model
 *     bridge.
 *   - Output: either the polished candidate (on successful LLM parse), or
 *     the original candidate unchanged (on timeout / parse failure / model
 *     outage). We never fabricate content — if the model can't produce a
 *     valid JSON polish, we pass the original through verbatim. This
 *     mirrors Rust's "no fabrication" rule.
 *
 * # Why split from `refining.ts`?
 *
 * `refining.ts::refineSextuple` combines the gate + polish into a single
 * Effect so round-1 callers (turn-hooks) had one entry point. Downstream
 * call-sites (commit crawler, foreign ingest) only need the polish stage
 * — they already have a score and just want to upgrade the text. This
 * module exposes the polish stage alone so those call-sites don't
 * re-execute the 4-signal scorer on every run.
 *
 * When the caller doesn't have a pre-computed score, it should use
 * `refining.ts::refineSextuple` which handles the full gate + polish
 * pipeline. This module is intentionally narrower.
 */

import { Effect, Option } from "effect"

import {
  buildRefiningPrompt,
  parseRefiningResponse,
  POLISH_TIMEOUT_MS,
  type RefiningCandidate,
  type RefiningModel,
  type SuccessScore,
} from "./refining"

export interface PolishOptions {
  readonly model: RefiningModel
  /** Override per-call timeout (ms). Defaults to `POLISH_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

export interface PolishOutput {
  /** Polished candidate on success; the original `candidate` on any fallback. */
  readonly candidate: RefiningCandidate
  /** Which path produced the output — helpful for telemetry. */
  readonly path: "polished" | "kept-verbatim"
  /** Short human-readable reason, suitable for structured logs. */
  readonly reason: string
}

/**
 * Polish a candidate using the supplied LLM bridge. Never throws; on any
 * failure returns `{ candidate: input.candidate, path: "kept-verbatim" }`.
 *
 * The caller is responsible for:
 *   - Deciding whether the score is high enough to bother polishing
 *     (typically `score.total >= SCORE_KEEP_THRESHOLD`; see
 *     `refining.ts::refineSextuple` for the full gate).
 *   - Persisting the polished candidate via `Memory.add`.
 */
export function polishCandidate(input: {
  readonly candidate: RefiningCandidate
  readonly score: SuccessScore
  readonly options: PolishOptions
}): Effect.Effect<PolishOutput> {
  return Effect.gen(function* () {
    const prompt = buildRefiningPrompt(input.candidate, input.score)
    const raw: string | null = yield* input.options
      .model(prompt)
      .pipe(
        Effect.timeoutOption(input.options.timeoutMs ?? POLISH_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(Option.none<string | null>())),
        Effect.map((opt) => Option.match(opt, { onNone: () => null, onSome: (v) => v ?? null })),
      )
    if (!raw) {
      return {
        candidate: input.candidate,
        path: "kept-verbatim" as const,
        reason: "polish LLM unavailable — keeping candidate verbatim",
      }
    }
    const polished = parseRefiningResponse(raw)
    if (!polished) {
      return {
        candidate: input.candidate,
        path: "kept-verbatim" as const,
        reason: "polish parse failure — keeping candidate verbatim",
      }
    }
    return {
      candidate: polished,
      path: "polished" as const,
      reason: "polish ok",
    }
  })
}

/**
 * Batch variant: polish N candidates concurrently, preserving order.
 *
 * Concurrency is bounded to `input.concurrency` (default 4) so we don't
 * hammer the polisher model on large post-turn extractions. Each polish
 * call inherits the per-call timeout; there is no aggregate timeout.
 */
export function polishCandidates(input: {
  readonly items: ReadonlyArray<{
    readonly candidate: RefiningCandidate
    readonly score: SuccessScore
  }>
  readonly options: PolishOptions
  readonly concurrency?: number
}): Effect.Effect<PolishOutput[]> {
  const concurrency = Math.max(1, input.concurrency ?? 4)
  return Effect.forEach(
    input.items,
    (row) => polishCandidate({ candidate: row.candidate, score: row.score, options: input.options }),
    { concurrency },
  )
}

export * as RefiningLlm from "./refining-llm"
