import { describe, expect, test } from "bun:test"
import { list } from "@/plugin/github-copilot/auth"
import {
  acquire,
  available,
  cooldown,
  effectiveLimit,
  eligible,
  emptyPool,
  feed,
  FULL_RECOVERY_MS,
  HEADERLESS_429_FALLBACK_DELAYS_MS,
  HEADERLESS_429_RESET_MS,
  HEALTHY_REQUEST_INTERVAL_MS,
  hydrateExhaustion,
  INITIAL_REQUEST_INTERVAL_MS,
  load,
  minIntervalFor,
  owner,
  parseRetryAfter,
  PARTIAL_RECOVERY_MS,
  PARTIAL_REQUEST_INTERVAL_MS,
  record429,
  recordSuccess,
  release,
  reserve,
  reserveBatch,
  runtime,
  SECOND_RECOVERY_MS,
  SECOND_REQUEST_INTERVAL_MS,
  touch,
} from "@/plugin/github-copilot/runtime"

describe("github-copilot runtime", () => {
  test("emptyPool starts empty", () => {
    expect(emptyPool()).toEqual({})
  })

  test("runtime defaults missing account usage to zero", () => {
    expect(runtime(emptyPool(), "github-copilot")).toBe(0)
  })

  test("owner defaults to limit=1 and empty pool", () => {
    expect(owner()).toEqual({ pool: {}, limit: 1, minIntervalMs: 0, last: {}, feed: [], rate: {} })
  })

  test("available respects per-account limit", () => {
    const state = { pool: acquire(emptyPool(), "github-copilot"), limit: 2, minIntervalMs: 0, last: {}, feed: [], rate: {} }
    expect(available(state, "github-copilot")).toBe(true)
    expect(available({ pool: acquire(state.pool, "github-copilot"), limit: 2, minIntervalMs: 0, last: {}, feed: [], rate: {} }, "github-copilot")).toBe(false)
  })

  test("acquire increments usage per account", () => {
    const pool = acquire(acquire(emptyPool(), "github-copilot"), "github-copilot")
    expect(runtime(pool, "github-copilot")).toBe(2)
  })

  test("release decrements usage and removes zero entries", () => {
    const a = acquire(acquire(emptyPool(), "github-copilot"), "github-copilot")
    const b = release(a, "github-copilot")
    expect(runtime(b, "github-copilot")).toBe(1)
    const c = release(b, "github-copilot")
    expect(c).toEqual({})
    expect(runtime(c, "github-copilot")).toBe(0)
  })

  test("release on missing account is a no-op", () => {
    expect(release(emptyPool(), "github-copilot")).toEqual({})
  })

  test("eligible prefers idle accounts", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
    })
    const state = owner()
    state.pool = acquire(state.pool, "github-copilot")
    expect(eligible(state, auths).map((item) => item.key)).toEqual(["github-copilot#work"])
  })

  test("eligible falls back to full pool when all accounts are busy", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
    })
    const state = owner()
    state.pool = acquire(acquire(state.pool, "github-copilot"), "github-copilot#work")
    expect(eligible(state, auths).map((item) => item.key)).toEqual(["github-copilot", "github-copilot#work"])
  })
})

test("cooldown and touch respect min interval", () => {
  const state = owner(1, 500)
  touch(state, "github-copilot", 1000)
  expect(cooldown(state, "github-copilot", 1200)).toBe(true)
  expect(cooldown(state, "github-copilot", 1600)).toBe(false)
})

test("load reflects current pool usage", () => {
  const state = owner()
  state.pool = acquire(acquire(state.pool, "github-copilot"), "github-copilot")
  expect(load(state, "github-copilot")).toBe(2)
})


test("reserveBatch holds projected picks on shared runtime owner", () => {
  const state = owner(2, 0)
  const held = reserveBatch(state, ["a", "b", "a"])
  expect(state.pool).toEqual({ a: 2, b: 1 })
  held.release("b")
  expect(state.pool).toEqual({ a: 2 })
  held.releaseAll()
  expect(state.pool).toEqual({})
})

test("reserve acquires and releases a single slot", () => {
  const state = owner()
  const slot = reserve(state, "github-copilot")
  expect(state.pool).toEqual({ "github-copilot": 1 })
  slot.release()
  expect(state.pool).toEqual({})
})


test("runtime feed records reserve release and touch events", () => {
  const state = owner()
  const slot = reserve(state, "github-copilot")
  touch(state, "github-copilot", 123)
  slot.release()
  expect(feed(state).map((item) => [item.type, item.key, item.load])).toEqual([
    ["release", "github-copilot", 0],
    ["touch", "github-copilot", 1],
    ["reserve", "github-copilot", 1],
  ])
})

describe("github-copilot runtime 429 escalator", () => {
  test("record429 without retry-after escalates through 11/21/41 min", () => {
    const state = owner(7, 0)
    const base = 1_000_000
    const first = record429(state, "k", { now: base })
    expect(first.delayMs).toBe(HEADERLESS_429_FALLBACK_DELAYS_MS[0])
    const second = record429(state, "k", { now: base + 1000 })
    expect(second.delayMs).toBe(HEADERLESS_429_FALLBACK_DELAYS_MS[1])
    const third = record429(state, "k", { now: base + 2000 })
    expect(third.delayMs).toBe(HEADERLESS_429_FALLBACK_DELAYS_MS[2])
    const fourth = record429(state, "k", { now: base + 3000 })
    // Caps at the last bucket.
    expect(fourth.delayMs).toBe(HEADERLESS_429_FALLBACK_DELAYS_MS[2])
  })

  test("record429 honours retry-after and resets headerless counter", () => {
    const state = owner(7, 0)
    record429(state, "k", { now: 0 })
    record429(state, "k", { now: 1 })
    const withHeader = record429(state, "k", { retryAfterMs: 5_000, now: 2 })
    expect(withHeader.delayMs).toBe(5_000)
    expect(state.rate.k.headerless429Count).toBe(0)
    // Next headerless 429 starts again at bucket 0.
    const next = record429(state, "k", { now: 3 })
    expect(next.delayMs).toBe(HEADERLESS_429_FALLBACK_DELAYS_MS[0])
  })

  test("record429 is monotonic — shorter cooldown cannot shorten a longer one", () => {
    const state = owner(7, 0)
    const long = record429(state, "k", { retryAfterMs: 60 * 60 * 1000, now: 0 })
    const short = record429(state, "k", { retryAfterMs: 1_000, now: 10 })
    expect(short.until).toBe(long.until)
  })

  test("parseRetryAfter handles seconds and HTTP-date", () => {
    expect(parseRetryAfter("30")).toBe(30_000)
    expect(parseRetryAfter("0.5")).toBe(500)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter("")).toBeUndefined()
    expect(parseRetryAfter("not-a-date")).toBeUndefined()
    const future = new Date(Date.now() + 10_000).toUTCString()
    const parsed = parseRetryAfter(future, Date.now())
    expect(parsed).toBeGreaterThan(0)
    expect(parsed).toBeLessThanOrEqual(10_000)
  })

  test("recordSuccess clears cooldown and resets count after 24h clean run", () => {
    const state = owner(7, 0)
    record429(state, "k", { now: 0 })
    record429(state, "k", { now: 1_000 })
    recordSuccess(state, "k", 2_000)
    expect(state.rate.k.exhaustedUntil).toBeUndefined()
    // Still retains headerless counter within the 24h window.
    expect(state.rate.k.headerless429Count).toBe(2)
    record429(state, "k", { now: 3_000 })
    // After 24h of no 429 since last429At, counter resets on next success.
    recordSuccess(state, "k", 3_000 + HEADERLESS_429_RESET_MS)
    expect(state.rate.k.headerless429Count).toBe(0)
    expect(state.rate.k.last429At).toBeUndefined()
  })

  test("effectiveLimit follows stepped recovery 1 → 2 → 4 → full", () => {
    const state = owner(7, 0)
    const at = 10_000_000
    record429(state, "k", { retryAfterMs: 0, now: at })
    expect(effectiveLimit(state, "k", at)).toBe(1)
    expect(effectiveLimit(state, "k", at + PARTIAL_RECOVERY_MS)).toBe(2)
    expect(effectiveLimit(state, "k", at + SECOND_RECOVERY_MS)).toBe(4)
    expect(effectiveLimit(state, "k", at + FULL_RECOVERY_MS)).toBe(7)
  })

  test("effectiveLimit returns 0 while within an active cooldown", () => {
    const state = owner(7, 0)
    record429(state, "k", { retryAfterMs: 60_000, now: 0 })
    expect(effectiveLimit(state, "k", 1_000)).toBe(0)
    expect(effectiveLimit(state, "k", 60_001)).toBe(1)
  })

  test("minIntervalFor buckets 30s / 20s / 12s / 7.5s", () => {
    const state = owner(7, 0)
    const at = 10_000_000
    record429(state, "k", { retryAfterMs: 0, now: at })
    expect(minIntervalFor(state, "k", at)).toBe(INITIAL_REQUEST_INTERVAL_MS)
    expect(minIntervalFor(state, "k", at + PARTIAL_RECOVERY_MS)).toBe(PARTIAL_REQUEST_INTERVAL_MS)
    expect(minIntervalFor(state, "k", at + SECOND_RECOVERY_MS)).toBe(SECOND_REQUEST_INTERVAL_MS)
    expect(minIntervalFor(state, "k", at + FULL_RECOVERY_MS)).toBe(HEALTHY_REQUEST_INTERVAL_MS)
  })

  test("minIntervalFor stays at configured base when no 429 has been seen", () => {
    const state = owner(7, 500)
    expect(minIntervalFor(state, "k")).toBe(500)
  })

  test("hydrateExhaustion seeds cooldown without advancing escalator", () => {
    const state = owner(7, 0)
    hydrateExhaustion(state, "k", 123_456)
    expect(state.rate.k.exhaustedUntil).toBe(123_456)
    expect(state.rate.k.headerless429Count).toBe(0)
  })
})
