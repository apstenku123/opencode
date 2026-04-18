import { setTimeout as sleep } from "node:timers/promises"
import { HttpErrors } from "./errors"

/**
 * Exponential backoff with decorrelated jitter + `Retry-After` override.
 *
 * Mirrors Rust `codex-client::retry::RetryPolicy` — the Rust side layers
 *   1. `Retry-After` (seconds / HTTP-date) — authoritative when present
 *   2. exponential growth with jitter (AWS-style full jitter)
 *   3. hard cap
 *
 * We keep the same knobs so the TS retry loop behaves identically when a
 * caller shares a policy instance across attempts.
 */
export namespace HttpRetry {
  export interface Policy {
    /** Maximum attempts including the initial call (>= 1). */
    maxAttempts: number
    /** First backoff after the initial attempt, in ms. */
    baseMs: number
    /** Upper bound on a single backoff, in ms. */
    maxMs: number
    /** Growth multiplier applied to `baseMs` each attempt. */
    factor: number
    /** Fraction of jitter to add ([0, 1]). 0 = deterministic, 0.5 = ±50 %. */
    jitter: number
  }

  export const DEFAULT: Policy = {
    maxAttempts: 4,
    baseMs: 500,
    maxMs: 30_000,
    factor: 2,
    jitter: 0.5,
  }

  export interface AttemptInput {
    attempt: number // 1-indexed retry number (first retry = 1)
    retryAfterMs?: number
    rng?: () => number // defaults to Math.random
  }

  /**
   * Compute the wait duration for retry `attempt`. `Retry-After` always wins
   * (capped by `maxMs`). Otherwise: `min(maxMs, baseMs * factor^(attempt-1))`
   * with `±jitter` full-jitter noise.
   */
  export function nextDelay(policy: Policy, input: AttemptInput): number {
    if (input.retryAfterMs !== undefined && input.retryAfterMs >= 0) {
      return Math.min(input.retryAfterMs, policy.maxMs)
    }
    const attempt = Math.max(1, input.attempt)
    const grown = policy.baseMs * Math.pow(policy.factor, attempt - 1)
    const capped = Math.min(grown, policy.maxMs)
    if (policy.jitter <= 0) return Math.trunc(capped)
    const rng = input.rng ?? Math.random
    const spread = capped * policy.jitter
    // Full jitter: uniform in [capped - spread, capped + spread], clamped.
    const sample = capped + (rng() * 2 - 1) * spread
    return Math.max(0, Math.min(policy.maxMs, Math.trunc(sample)))
  }

  /** Return true when the error is worth retrying under `policy`. */
  export function shouldRetry(err: unknown, attempt: number, policy: Policy): boolean {
    if (attempt >= policy.maxAttempts) return false
    if (err instanceof HttpErrors.HttpError) return err.isRetryable()
    return false
  }

  /**
   * Run `fn` with retries governed by `policy`. Each attempt's failure must
   * be an {@link HttpErrors.HttpError} — other errors propagate immediately
   * so programmer bugs don't get masked behind retries.
   *
   * `sleepFn` is injectable for tests; defaults to node's `setTimeout`.
   */
  export async function run<T>(
    policy: Policy,
    fn: (attempt: number) => Promise<T>,
    opts?: { sleep?: (ms: number) => Promise<void>; rng?: () => number },
  ): Promise<T> {
    const sleepFn = opts?.sleep ?? ((ms: number) => sleep(ms))
    let attempt = 1
    // Bound the outer loop by `maxAttempts` so a policy with maxAttempts=1
    // never retries — matches the Rust invariant.
    while (true) {
      try {
        return await fn(attempt)
      } catch (err) {
        if (!shouldRetry(err, attempt, policy)) throw err
        const retryAfterMs = err instanceof HttpErrors.HttpError ? err.retryAfterMs : undefined
        const wait = nextDelay(policy, { attempt, retryAfterMs, rng: opts?.rng })
        if (wait > 0) await sleepFn(wait)
        attempt += 1
      }
    }
  }
}
