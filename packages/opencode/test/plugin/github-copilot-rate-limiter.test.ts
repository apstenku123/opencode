import { describe, expect, test } from "bun:test"
import {
  AcquireTimeoutError,
  CopilotRateLimiter,
  DEFAULT_CLEAN_WINDOW_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MIN_CONCURRENT,
  DEFAULT_SLIDING_WINDOW_MS,
  DEFAULT_THRESHOLD,
  copilotRateLimiterConfig,
} from "@/plugin/github-copilot/rate-limiter"

describe("CopilotRateLimiter", () => {
  test("defaults mirror the Rust constants", () => {
    expect(DEFAULT_SLIDING_WINDOW_MS).toBe(10 * 60 * 1000)
    expect(DEFAULT_CLEAN_WINDOW_MS).toBe(5 * 60 * 1000)
    expect(DEFAULT_THRESHOLD).toBe(0.2)
    expect(DEFAULT_MAX_CONCURRENT).toBe(7)
    expect(DEFAULT_MIN_CONCURRENT).toBe(1)
  })

  test("effective capacity starts at maxConcurrent", () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 4 })
    expect(rl.effectiveCapacity("k")).toBe(4)
    expect(rl.available("k")).toBe(4)
  })

  test("acquire reserves a slot and release frees it", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 2 })
    const a = await rl.acquire("k")
    expect(a.held).toBe(true)
    expect(rl.available("k")).toBe(1)
    a.release()
    expect(rl.available("k")).toBe(2)
    // double-release no-op
    a.release()
    expect(rl.available("k")).toBe(2)
  })

  test("concurrent acquires respect the capacity", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 2 })
    const a = await rl.acquire("k")
    const b = await rl.acquire("k")
    expect(rl.available("k")).toBe(0)
    // Third acquire blocks until a slot frees up.
    let resolved = false
    const c = rl.acquire("k", { timeoutMs: 5_000 }).then((r) => {
      resolved = true
      return r
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(resolved).toBe(false)
    a.release()
    const cHandle = await c
    expect(cHandle.held).toBe(true)
    expect(rl.available("k")).toBe(0)
    b.release()
    cHandle.release()
    expect(rl.available("k")).toBe(2)
  })

  test("acquire rejects after timeout", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 1 })
    const held = await rl.acquire("k")
    await expect(rl.acquire("k", { timeoutMs: 20 })).rejects.toBeInstanceOf(AcquireTimeoutError)
    held.release()
  })

  test("acquire aborts via AbortSignal", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 1 })
    const held = await rl.acquire("k")
    const ctrl = new AbortController()
    const pending = rl.acquire("k", { signal: ctrl.signal, timeoutMs: 10_000 })
    ctrl.abort(new Error("canceled"))
    await expect(pending).rejects.toThrow("canceled")
    held.release()
  })

  test("429 burst shrinks capacity down toward minConcurrent", () => {
    // Threshold 0.2 with a 10min window ⇒ >2 events in window triggers a
    // halving on every subsequent eval until we hit `minConcurrent`.
    const rl = new CopilotRateLimiter({ maxConcurrent: 8, minConcurrent: 1 })
    const limiter = rl.for("k")
    expect(limiter.effectiveCapacity(0)).toBe(8)
    // 3rd `record429` tips density over threshold (rate 0.3 > 0.2) → first
    // halve 8 → 4.
    limiter.record429(0)
    limiter.record429(100)
    limiter.record429(200)
    // `effectiveCapacity` also evaluates → halves again 4 → 2.
    // Each re-evaluation under sustained density keeps halving.
    limiter.record429(400)
    limiter.record429(600)
    limiter.record429(800)
    // By now many evaluations have been run — capacity is bottomed out at
    // `minConcurrent`.
    expect(limiter.effectiveCapacity(900)).toBe(1)
  })

  test("each evaluation under sustained burst halves capacity once", () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 8, minConcurrent: 1 })
    const limiter = rl.for("k")
    // Prime enough events that the rate stays above threshold for all
    // subsequent evaluations.
    for (let i = 0; i < 5; i++) limiter.record429(i)
    // After priming, capacity has halved a few times already. Grab a
    // snapshot and then walk down step-by-step.
    let cap = limiter.effectiveCapacity(10)
    while (cap > 1) {
      const next = limiter.effectiveCapacity(10)
      expect(next).toBe(Math.max(1, Math.floor(cap / 2)))
      cap = next
    }
    expect(cap).toBe(1)
  })

  test("clean window grows capacity back toward maxConcurrent", () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 8, minConcurrent: 1 })
    const limiter = rl.for("k")
    // Force shrink to 1.
    for (let i = 0; i < 10; i++) limiter.record429(i)
    expect(limiter.effectiveCapacity(10)).toBe(1)
    // Wait past the sliding window so events age out, plus the clean
    // window — capacity should double on each evaluation.
    const past = DEFAULT_SLIDING_WINDOW_MS + 20 + DEFAULT_CLEAN_WINDOW_MS
    expect(limiter.effectiveCapacity(past)).toBe(2)
    expect(limiter.effectiveCapacity(past + DEFAULT_CLEAN_WINDOW_MS)).toBe(4)
    expect(limiter.effectiveCapacity(past + 2 * DEFAULT_CLEAN_WINDOW_MS)).toBe(8)
    // Saturated at maxConcurrent.
    expect(limiter.effectiveCapacity(past + 3 * DEFAULT_CLEAN_WINDOW_MS)).toBe(8)
  })

  test("per-key isolation: 429 on one key doesn't shrink another", () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 4, minConcurrent: 1 })
    const a = rl.for("a")
    const b = rl.for("b")
    for (let i = 0; i < 5; i++) a.record429(i)
    expect(a.effectiveCapacity(10)).toBeLessThan(4)
    expect(b.effectiveCapacity(10)).toBe(4)
  })

  test("events outside the sliding window are ignored", () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 4 })
    const limiter = rl.for("k")
    // Many stale events — all should fall out of the window.
    for (let i = 0; i < 100; i++) limiter.record429(i)
    const future = DEFAULT_SLIDING_WINDOW_MS + 1000
    expect(limiter.recentCount(future)).toBe(0)
  })

  test("disabled limiter is a no-op acquire", async () => {
    const rl = new CopilotRateLimiter({ enabled: false, maxConcurrent: 1 })
    const a = await rl.acquire("k")
    // Even though capacity is 1, a disabled limiter never blocks.
    const b = await rl.acquire("k")
    expect(a.held).toBe(true)
    expect(b.held).toBe(true)
    a.release()
    b.release()
  })

  test("drain rejects all pending waiters", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 1 })
    const held = await rl.acquire("k")
    const pending = rl.acquire("k", { timeoutMs: 10_000 })
    rl.drain(new Error("shutdown"))
    await expect(pending).rejects.toThrow("shutdown")
    held.release()
  })

  test("capacity shrinks but in-flight leases remain valid", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 4, minConcurrent: 1 })
    // `now` for initial acquires is pinned to a recent wall-clock so
    // 429 events we push below stay inside the 10-min sliding window
    // when the release-flush `now` fires later.
    const base = Date.now()
    const a = await rl.acquire("k", { now: base })
    const b = await rl.acquire("k", { now: base })
    // Shrink capacity to `minConcurrent` by flooding the window.
    const limiter = rl.for("k")
    for (let i = 0; i < 10; i++) limiter.record429(base + i)
    // Many halvings later (4→2→1) capacity bottoms out.
    expect(limiter.effectiveCapacity(base + 10)).toBe(1)
    // Existing leases are still valid — release walks them back.
    a.release()
    b.release()
    // New acquire now respects the shrunk cap.
    const c = await rl.acquire("k", { now: base + 10 })
    await expect(
      rl.acquire("k", { timeoutMs: 20, now: base + 10 }),
    ).rejects.toBeInstanceOf(AcquireTimeoutError)
    c.release()
  })

  test("Symbol.dispose releases the slot", async () => {
    const rl = new CopilotRateLimiter({ maxConcurrent: 1 })
    {
      const lease = await rl.acquire("k")
      expect(typeof (lease as any)[Symbol.dispose]).toBe("function")
      ;(lease as any)[Symbol.dispose]()
    }
    // Slot should be freed.
    const next = await rl.acquire("k", { timeoutMs: 100 })
    expect(next.held).toBe(true)
    next.release()
  })
})

describe("copilotRateLimiterConfig", () => {
  test("returns defaults when nothing is configured", () => {
    const opts = copilotRateLimiterConfig({})
    expect(opts.enabled).toBe(true)
    expect(opts.slidingWindowMs).toBe(DEFAULT_SLIDING_WINDOW_MS)
    expect(opts.cleanWindowMs).toBe(DEFAULT_CLEAN_WINDOW_MS)
    expect(opts.threshold).toBe(DEFAULT_THRESHOLD)
    expect(opts.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT)
    expect(opts.minConcurrent).toBe(DEFAULT_MIN_CONCURRENT)
  })

  test("copilot.rateLimiter overrides defaults", () => {
    const opts = copilotRateLimiterConfig({
      copilot: {
        rateLimiter: {
          enabled: false,
          threshold: 0.5,
          maxConcurrent: 3,
          minConcurrent: 1,
        },
      },
    })
    expect(opts.enabled).toBe(false)
    expect(opts.threshold).toBe(0.5)
    expect(opts.maxConcurrent).toBe(3)
  })

  test("env var overrides take precedence over config", () => {
    const prev = process.env.OPENCODE_COPILOT_RATE_LIMITER_MAX
    process.env.OPENCODE_COPILOT_RATE_LIMITER_MAX = "2"
    try {
      const opts = copilotRateLimiterConfig({ copilot: { rateLimiter: { maxConcurrent: 5 } } })
      expect(opts.maxConcurrent).toBe(2)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_COPILOT_RATE_LIMITER_MAX
      else process.env.OPENCODE_COPILOT_RATE_LIMITER_MAX = prev
    }
  })
})
