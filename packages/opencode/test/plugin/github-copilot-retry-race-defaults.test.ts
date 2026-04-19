/**
 * Regression guard for the opencode-fork retry-race defaults.
 *
 * The fork flips `DEFAULT_HTTP_RETRY_RACE_CONFIG.enabled` from the Rust
 * default of `false` to `true` so real users see p99 latency reduction
 * on stalled Copilot turns out of the box. This file asserts every
 * tuned field so an accidental regression (e.g. `staggerMs: 40_000` or
 * `enabled: false` slipping back in from a merge) surfaces as a unit-
 * test failure at CI rather than a production tail-latency regression.
 *
 * Rationale for the specific values is documented on the
 * `HttpRetryRaceConfig` JSDoc in `retry-race.ts` — in brief:
 *
 *   - `enabled: true`         — fork's headline feature. Operators who
 *     need strict single-account behaviour disable via
 *     `OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED=false` env or
 *     `copilot.httpRetryRace.enabled: false` config.
 *   - `staggerMs: 45_000`     — healthy turns finish inside 30s; waiting
 *     45s before firing the backup keeps quota burn near zero on the
 *     happy path.
 *   - `concurrentLimit: 2`    — 1 original + 1 backup; 2× worst-case
 *     quota burn vs the Rust default's 3×.
 *   - `maxAttempts: 3`        — 1 original + 2 retries, then surface a
 *     `RetryRaceExhaustedError`.
 *   - `totalDeadlineMs: 180_000` — 3 min upper bound; accommodates slow
 *     SGR reasoning turns while still capping pathological hangs.
 *   - `eventBusCapacity: 64`  — matches Rust `broadcast` channel size.
 *
 * If any of these numbers need to change, update this file together with
 * `DEFAULT_HTTP_RETRY_RACE_CONFIG` and the docstrings so they stay in
 * sync. The matching assertion in `github-copilot-retry-race.test.ts`
 * is retained for source-near coverage.
 */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_HTTP_RETRY_RACE_CONFIG,
  httpRetryRaceConfig,
} from "@/plugin/github-copilot/retry-race"

describe("DEFAULT_HTTP_RETRY_RACE_CONFIG", () => {
  test("race is enabled by default (fork opt-in-by-default)", () => {
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.enabled).toBe(true)
  })

  test("stagger = 45s (healthy-turn guard)", () => {
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.staggerMs).toBe(45_000)
  })

  test("concurrent limit = 2 (1 original + 1 backup; ≤2× quota burn)", () => {
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.concurrentLimit).toBe(2)
  })

  test("max attempts = 3 (original + 2 retries)", () => {
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.maxAttempts).toBe(3)
  })

  test("total deadline = 3 minutes", () => {
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.totalDeadlineMs).toBe(180_000)
  })

  test("event bus capacity = 64 (matches Rust broadcast channel)", () => {
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.eventBusCapacity).toBe(64)
  })

  test("all fields are present and typed numerically/boolean", () => {
    // Structural sanity — if a future change removes or renames a field
    // the resolver in `httpRetryRaceConfig()` will quietly fall through
    // to undefined and this test becomes the early-warning signal.
    const cfg = DEFAULT_HTTP_RETRY_RACE_CONFIG
    expect(typeof cfg.enabled).toBe("boolean")
    expect(typeof cfg.staggerMs).toBe("number")
    expect(typeof cfg.concurrentLimit).toBe("number")
    expect(typeof cfg.maxAttempts).toBe("number")
    expect(typeof cfg.totalDeadlineMs).toBe("number")
    expect(typeof cfg.eventBusCapacity).toBe("number")
  })

  test("concurrent limit never exceeds max attempts", () => {
    // Invariant: attempting more parallel requests than the per-race
    // attempt cap would mean we'd abort some attempts the instant they
    // spawn. Keeping this inequality tight ensures the race behaves as
    // documented even if someone tunes only one of the two values.
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.concurrentLimit).toBeLessThanOrEqual(
      DEFAULT_HTTP_RETRY_RACE_CONFIG.maxAttempts,
    )
  })
})

describe("httpRetryRaceConfig resolver honours the new defaults", () => {
  test("empty config returns DEFAULT_HTTP_RETRY_RACE_CONFIG verbatim", () => {
    const cfg = httpRetryRaceConfig({})
    expect(cfg).toEqual(DEFAULT_HTTP_RETRY_RACE_CONFIG)
  })

  test("undefined config returns DEFAULT_HTTP_RETRY_RACE_CONFIG verbatim", () => {
    const cfg = httpRetryRaceConfig(undefined)
    expect(cfg).toEqual(DEFAULT_HTTP_RETRY_RACE_CONFIG)
  })

  test("rollback via config disables the race cleanly", () => {
    const cfg = httpRetryRaceConfig({
      copilot: { httpRetryRace: { enabled: false } },
    })
    expect(cfg.enabled).toBe(false)
    // Other fields still track the new defaults so a user who disables
    // the race and later re-enables it lands on the tuned stagger/limit.
    expect(cfg.staggerMs).toBe(45_000)
    expect(cfg.concurrentLimit).toBe(2)
    expect(cfg.maxAttempts).toBe(3)
    expect(cfg.totalDeadlineMs).toBe(180_000)
  })

  test("rollback via env beats config for enabled=true", () => {
    // Env override takes precedence over config; this is the documented
    // emergency-off switch for operators who can't edit ~/.config/opencode.
    const prev = process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED
    process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED = "false"
    try {
      const cfg = httpRetryRaceConfig({
        copilot: { httpRetryRace: { enabled: true } },
      })
      expect(cfg.enabled).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED
      else process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED = prev
    }
  })

  test("individual fields can be overridden without disabling the race", () => {
    const cfg = httpRetryRaceConfig({
      copilot: { httpRetryRace: { staggerMs: 30_000 } },
    })
    expect(cfg.enabled).toBe(true) // still defaulted to true
    expect(cfg.staggerMs).toBe(30_000)
    expect(cfg.concurrentLimit).toBe(2)
    expect(cfg.maxAttempts).toBe(3)
    expect(cfg.totalDeadlineMs).toBe(180_000)
  })
})
