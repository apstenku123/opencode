import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  CopilotStats,
  Stats,
  fallbackPool,
  parseDuration,
  renderStatsText,
  STATS_SCHEMA_VERSION,
} from "@/plugin/github-copilot/stats"
import { makeRateStoreFromDb } from "@/plugin/github-copilot/account-pool-sqlite"

// Guard: the singleton is shared across tests, make sure we start clean so
// records in this file don't leak into its `aggregate` assertions.
CopilotStats.reset()

describe("parseDuration", () => {
  test("parses common unit suffixes", () => {
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("10m")).toBe(600_000)
    expect(parseDuration("1h")).toBe(3_600_000)
    expect(parseDuration("2d")).toBe(172_800_000)
  })

  test("bare number treated as ms", () => {
    expect(parseDuration("250")).toBe(250)
  })

  test("invalid and empty inputs return undefined", () => {
    expect(parseDuration(undefined)).toBeUndefined()
    expect(parseDuration(null)).toBeUndefined()
    expect(parseDuration("")).toBeUndefined()
    expect(parseDuration("abc")).toBeUndefined()
    expect(parseDuration("-5m")).toBeUndefined()
    expect(parseDuration("10z")).toBeUndefined()
  })
})

describe("fallbackPool", () => {
  test("classifies edu test-account prefix regardless of plan", () => {
    expect(fallbackPool("github-copilot#edu-7")).toBe("edu")
  })

  test("maps plan aliases to pools", () => {
    expect(fallbackPool("github-copilot", "edu")).toBe("edu")
    expect(fallbackPool("github-copilot", "free")).toBe("edu")
    expect(fallbackPool("github-copilot", "individual")).toBe("edu")
    expect(fallbackPool("github-copilot#work", "enterprise")).toBe("prod")
    expect(fallbackPool("github-copilot#work", "business")).toBe("prod")
    expect(fallbackPool("github-copilot#work", "pro")).toBe("prod")
    expect(fallbackPool("github-copilot", "team")).toBe("prod")
  })

  test("returns undefined when plan is missing / unknown", () => {
    expect(fallbackPool("github-copilot")).toBeUndefined()
    expect(fallbackPool("github-copilot", "something")).toBeUndefined()
  })
})

describe("Stats ring buffer", () => {
  test("records dispatch / rate-limit / premium", () => {
    const stats = new Stats(0)
    stats.recordDispatch("a", "gpt-5", 100)
    stats.recordDispatch("a", "claude-opus-4.6", 200)
    stats.recordDispatch("b", "gpt-5", 300)
    stats.recordRateLimit("a", 30_000, 400)
    stats.recordRateLimit("a", undefined, 500)
    stats.recordPremium("a", "gpt-5", 150)

    const snap = stats.snapshot({ now: 1000 })
    const a = snap.find((item) => item.key === "a")!
    const b = snap.find((item) => item.key === "b")!
    expect(a.dispatches).toBe(2)
    expect(a.rateLimits).toBe(2)
    expect(a.premiumUsed).toBe(1)
    // avg only over 429s that had a retry-after header
    expect(a.avgRetryAfterMs).toBe(30_000)
    expect(a.lastRateLimitAgoMs).toBe(500)
    expect(a.lastDispatchAgoMs).toBe(800)
    expect(b.dispatches).toBe(1)
    expect(b.rateLimits).toBe(0)
  })

  test("sinceMs window filters events", () => {
    const stats = new Stats(0)
    stats.recordDispatch("a", "gpt-5", 0)
    stats.recordDispatch("a", "gpt-5", 1_000)
    stats.recordDispatch("a", "gpt-5", 30_000)
    const snap = stats.snapshot({ sinceMs: 5_000, now: 30_000 })
    const a = snap.find((item) => item.key === "a")!
    // only the event at t=30_000 (cutoff = 25_000) is inside the window
    expect(a.dispatches).toBe(1)
  })

  test("topModels ranks by count and limits to N", () => {
    const stats = new Stats(0)
    stats.recordDispatch("a", "gpt-5", 10)
    stats.recordDispatch("a", "gpt-5", 20)
    stats.recordDispatch("a", "claude", 30)
    stats.recordDispatch("b", "gemini", 40)
    stats.recordDispatch("b", "gemini", 50)
    stats.recordDispatch("b", "gemini", 60)
    const top = stats.topModels({ now: 100 })
    expect(top).toEqual([
      { model: "gemini", count: 3 },
      { model: "gpt-5", count: 2 },
      { model: "claude", count: 1 },
    ])
    const two = stats.topModels({ now: 100, limit: 2 })
    expect(two).toHaveLength(2)
  })

  test("aggregate merges persistent rate rows and connections", () => {
    const stats = new Stats(0)
    stats.recordDispatch("github-copilot", "gpt-5", 10)
    stats.recordDispatch("github-copilot", "gpt-5", 20)
    stats.recordDispatch("github-copilot#edu-1", "gpt-4.1", 30)
    stats.recordRateLimit("github-copilot", 45_000, 40)
    stats.recordPremium("github-copilot", "gpt-5", 11)

    const db = new Database(":memory:")
    const store = makeRateStoreFromDb(db, 1)
    // Two rows: one with an active cooldown, one expired.
    store.upsert({ key: "github-copilot", exhaustedUntil: 2_000, headerless429Count: 1, last429At: 40 })
    store.upsert({ key: "github-copilot#edu-1", exhaustedUntil: 10, headerless429Count: 0, last429At: 30 })
    store.flush()

    const agg = stats.aggregate({
      now: 100,
      rateStore: store,
      connections: {
        connections: {
          "github-copilot": { plan: "enterprise" },
          "github-copilot#edu-1": { plan: "edu" },
          "github-copilot#dead": { plan: "free", deactivated: true },
        },
      },
    })

    expect(agg.schemaVersion).toBe(STATS_SCHEMA_VERSION)
    expect(agg.generatedAt).toBe(100)
    expect(agg.windowMs).toBeNull()

    expect(agg.totals).toMatchObject({
      accounts: 3,
      deactivated: 1,
      dispatches: 3,
      rateLimits: 1,
      premium: 1,
    })

    const byKey = Object.fromEntries(agg.accounts.map((a) => [a.key, a]))
    expect(byKey["github-copilot"].pool).toBe("prod")
    expect(byKey["github-copilot"].dispatches).toBe(2)
    expect(byKey["github-copilot"].rateLimits).toBe(1)
    expect(byKey["github-copilot"].avgRetryAfterMs).toBe(45_000)
    expect(byKey["github-copilot"].exhaustedUntil).toBe(2_000)
    expect(byKey["github-copilot"].headerless429Count).toBe(1)
    expect(byKey["github-copilot"].persistentLast429At).toBe(40)
    expect(byKey["github-copilot#edu-1"].pool).toBe("edu")
    expect(byKey["github-copilot#dead"].deactivated).toBe(true)
    expect(byKey["github-copilot#dead"].pool).toBe("edu") // free → edu

    expect(agg.topModels[0]).toEqual({ model: "gpt-5", count: 2 })

    const pools = Object.fromEntries(agg.pools.map((p) => [p.pool, p]))
    expect(pools.prod.accounts).toBe(1)
    expect(pools.prod.inCooldown).toBe(1) // github-copilot exhaustedUntil=2000 > now=100
    expect(pools.edu.accounts).toBe(2)
    expect(pools.edu.deactivated).toBe(1)
    // `github-copilot#edu-1` has exhaustedUntil=10 which is already
    // expired (< now=100) so it should NOT count as in-cooldown.
    expect(pools.edu.inCooldown).toBe(0)

    store.close()
  })

  test("aggregate without any bucket data still returns pool buckets from connections", () => {
    const stats = new Stats(0)
    const agg = stats.aggregate({
      now: 100,
      connections: {
        connections: {
          "github-copilot#solo": { plan: "enterprise" },
        },
      },
    })
    expect(agg.accounts).toHaveLength(1)
    expect(agg.accounts[0]).toMatchObject({
      key: "github-copilot#solo",
      dispatches: 0,
      rateLimits: 0,
      premiumUsed: 0,
      pool: "prod",
    })
    expect(agg.totals).toMatchObject({ accounts: 1, deactivated: 0 })
  })

  test("aggregate windowMs reflects sinceMs when provided", () => {
    const stats = new Stats(0)
    const agg = stats.aggregate({ sinceMs: 60_000, now: 100 })
    expect(agg.windowMs).toBe(60_000)
  })

  test("renderStatsText emits header + rows + top models", () => {
    const stats = new Stats(0)
    stats.recordDispatch("github-copilot", "gpt-5", 10)
    stats.recordRateLimit("github-copilot", 30_000, 20)
    const agg = stats.aggregate({
      now: 100,
      connections: { connections: { "github-copilot": { plan: "enterprise" } } },
    })
    const lines = renderStatsText(agg)
    expect(lines[0]).toContain("since boot")
    expect(lines.some((l) => l.includes("github-copilot"))).toBe(true)
    expect(lines.some((l) => l.includes("Top models:"))).toBe(true)
    expect(lines.some((l) => l.includes("gpt-5"))).toBe(true)
    expect(lines.some((l) => l.includes("Pools:"))).toBe(true)
  })

  test("ring buffer cap prevents unbounded growth", () => {
    const stats = new Stats(0)
    // Cap is 4096 — pushing well past it should not bloat memory.
    for (let i = 0; i < 5000; i += 1) stats.recordDispatch("a", "gpt-5", i)
    // Running total still reflects every push (independent of ring window).
    const snap = stats.snapshot({ now: 6000 })
    expect(snap[0].dispatches).toBe(5000)
    // The ring buffer itself is capped.
    expect(stats.events("a").length).toBe(4096)
  })
})

describe("CopilotStats singleton", () => {
  test("reset clears state and retains booted time", () => {
    CopilotStats.recordDispatch("github-copilot", "gpt-5")
    expect(CopilotStats.keys().length).toBeGreaterThan(0)
    CopilotStats.reset()
    expect(CopilotStats.keys().length).toBe(0)
    expect(typeof CopilotStats.bootedAt).toBe("number")
  })
})
