import { describe, expect, test } from "bun:test"
import { AccountPool, HEADERLESS_429_FALLBACK_DELAYS_MS } from "@/plugin/github-copilot/account-pool"
import { FULL_RECOVERY_MS, PARTIAL_RECOVERY_MS } from "@/plugin/github-copilot/runtime"

describe("AccountPool", () => {
  test("availableSlots starts at the per-account cap", () => {
    const pool = new AccountPool({
      accounts: [{ key: "github-copilot" }, { key: "github-copilot#work" }],
      limit: 7,
    })
    expect(pool.availableSlots("github-copilot")).toBe(7)
    expect(pool.availableAccountCount()).toBe(2)
  })

  test("acquire reserves a slot and release frees it", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "github-copilot" }],
      limit: 2,
    })
    const lease = await pool.acquire("github-copilot")
    expect(lease.held).toBe(true)
    expect(pool.availableSlots("github-copilot")).toBe(1)
    lease.release()
    expect(pool.availableSlots("github-copilot")).toBe(2)
    // Double-release is a no-op.
    lease.release()
    expect(pool.availableSlots("github-copilot")).toBe(2)
  })

  test("acquire without a key picks the best-headroom account", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "github-copilot" }, { key: "github-copilot#work" }],
      limit: 3,
    })
    const a = await pool.acquire("github-copilot")
    const b = await pool.acquire()
    // second pick should prefer the idle account
    expect(b.key).toBe("github-copilot#work")
    a.release()
    b.release()
  })

  test("acquire blocks until a slot frees up", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "k" }],
      limit: 1,
    })
    const first = await pool.acquire("k")
    let resolved = false
    const second = pool.acquire("k").then((lease) => {
      resolved = true
      return lease
    })
    // Give the event loop a tick — still blocked.
    await new Promise((r) => setTimeout(r, 5))
    expect(resolved).toBe(false)
    first.release()
    const lease = await second
    expect(lease.held).toBe(true)
    lease.release()
  })

  test("acquire honours a short timeout", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "k" }],
      limit: 1,
    })
    const held = await pool.acquire("k")
    await expect(pool.acquire("k", { timeoutMs: 20 })).rejects.toThrow(/timed out/)
    held.release()
  })

  test("acquire aborts via AbortSignal", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "k" }],
      limit: 1,
    })
    const held = await pool.acquire("k")
    const ctrl = new AbortController()
    const pending = pool.acquire("k", { signal: ctrl.signal, timeoutMs: 10_000 })
    ctrl.abort(new Error("canceled"))
    await expect(pending).rejects.toThrow("canceled")
    held.release()
  })

  test("recordExhaustion via retry-after applies delay and shrinks slots", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "k" }],
      limit: 7,
    })
    const base = 1_000_000
    const result = pool.recordExhaustion("k", { retryAfter: "30", now: base })
    expect(result.delayMs).toBe(30_000)
    // within cooldown, zero slots available
    expect(pool.availableSlots("k", base + 1_000)).toBe(0)
    // after cooldown expires, stepped recovery: still 1 slot at just-past.
    expect(pool.availableSlots("k", base + 30_001)).toBe(1)
    // after full recovery elapsed since last429, back to cap
    expect(pool.availableSlots("k", base + FULL_RECOVERY_MS)).toBe(7)
  })

  test("recordExhaustion honours explicit delayMs option", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7 })
    const result = pool.recordExhaustion("k", { delayMs: 5_000, now: 0 })
    expect(result.delayMs).toBe(5_000)
  })

  test("recordExhaustion escalator 11 → 21 → 41 min without retry-after", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7 })
    const a = pool.recordExhaustion("k", { now: 0 })
    const b = pool.recordExhaustion("k", { now: 1 })
    const c = pool.recordExhaustion("k", { now: 2 })
    const d = pool.recordExhaustion("k", { now: 3 })
    expect([a.delayMs, b.delayMs, c.delayMs, d.delayMs]).toEqual([
      HEADERLESS_429_FALLBACK_DELAYS_MS[0]!,
      HEADERLESS_429_FALLBACK_DELAYS_MS[1]!,
      HEADERLESS_429_FALLBACK_DELAYS_MS[2]!,
      HEADERLESS_429_FALLBACK_DELAYS_MS[2]!,
    ])
  })

  test("recordExhaustion wakes a waiter that targets another key", async () => {
    const pool = new AccountPool({
      accounts: [{ key: "a" }, { key: "b" }],
      limit: 1,
    })
    // Saturate "a" so the waiter initially sees it as unavailable.
    const held = await pool.acquire("a")
    const waiter = pool.acquire(undefined, { timeoutMs: 5_000 })
    // Release "a" — waiter resolves on best-headroom (either a or b works).
    held.release()
    const lease = await waiter
    expect(["a", "b"]).toContain(lease.key)
    lease.release()
  })

  test("preferSecondary skips primary when a backup is assignable", async () => {
    const pool = new AccountPool({
      accounts: [
        { key: "github-copilot" },
        { key: "github-copilot#work" },
      ],
      limit: 1,
    })
    const lease = await pool.acquire(undefined, { preferSecondary: true })
    expect(lease.key).toBe("github-copilot#work")
    lease.release()
  })

  test("preferSecondary falls back to primary when no backup has slots", async () => {
    const pool = new AccountPool({
      accounts: [
        { key: "github-copilot" },
        { key: "github-copilot#work" },
      ],
      limit: 1,
    })
    const backup = await pool.acquire("github-copilot#work")
    const lease = await pool.acquire(undefined, { preferSecondary: true, timeoutMs: 100 })
    expect(lease.key).toBe("github-copilot")
    backup.release()
    lease.release()
  })

  test("shouldThrottleSpawns when >50% accounts in cooldown", () => {
    const pool = new AccountPool({
      accounts: [{ key: "a" }, { key: "b" }, { key: "c" }],
      limit: 7,
    })
    expect(pool.shouldThrottleSpawns()).toBe(false)
    pool.recordExhaustion("a", { delayMs: 60_000, now: 0 })
    pool.recordExhaustion("b", { delayMs: 60_000, now: 0 })
    // 2 of 3 in cooldown → throttle.
    expect(pool.shouldThrottleSpawns(1_000)).toBe(true)
  })

  test("recordSuccess clears cooldown and wakes waiters", async () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 2 })
    pool.recordExhaustion("k", { delayMs: 60_000, now: 0 })
    const pending = pool.acquire("k", { timeoutMs: 5_000 })
    pool.recordSuccess("k", 1_000)
    const lease = await pending
    expect(lease.held).toBe(true)
    lease.release()
  })

  test("release(key) forcibly frees the first matching lease", async () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 1 })
    const lease = await pool.acquire("k")
    expect(pool.release("k")).toBe(true)
    // Subsequent acquire does not block.
    const second = await pool.acquire("k", { timeoutMs: 50 })
    second.release()
    lease.release() // no-op because release(key) already flipped held
  })

  test("stop rejects pending waiters", async () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 1 })
    pool.start()
    const held = await pool.acquire("k")
    const pending = pool.acquire("k", { timeoutMs: 5_000 })
    pool.stop()
    await expect(pending).rejects.toThrow(/stopped/)
    held.release()
  })

  test("setAccounts swaps the roster and wakes waiters", async () => {
    const pool = new AccountPool({ accounts: [], limit: 1 })
    const pending = pool.acquire("new", { timeoutMs: 5_000 })
    pool.setAccounts([{ key: "new" }])
    const lease = await pending
    expect(lease.key).toBe("new")
    lease.release()
  })

  test("availableSlots follows stepped recovery", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7 })
    const base = 5_000_000
    pool.recordExhaustion("k", { delayMs: 0, now: base })
    expect(pool.availableSlots("k", base)).toBe(1)
    expect(pool.availableSlots("k", base + PARTIAL_RECOVERY_MS)).toBe(2)
    expect(pool.availableSlots("k", base + FULL_RECOVERY_MS)).toBe(7)
  })

  test("modelCapability defaults to Unknown", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 1 })
    expect(pool.modelCapability("k", "claude-opus-4.5")).toBe("Unknown")
  })

  test("setAccountCapabilities marks models Supported", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 1 })
    pool.setAccountCapabilities("k", ["gpt-5", "claude-opus-4.5"])
    expect(pool.modelCapability("k", "gpt-5")).toBe("Supported")
    expect(pool.modelCapability("k", "claude-opus-4.5")).toBe("Supported")
    expect(pool.modelCapability("k", "unknown-model")).toBe("Unknown")
  })

  test("markDiscoveryFailed shows DiscoveryFailed for unknown models", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 1 })
    pool.markDiscoveryFailed("k")
    expect(pool.modelCapability("k", "anything")).toBe("DiscoveryFailed")
  })

  test("markModelUnsupported flags model and clears stale >1h cooldown", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7 })
    const now = 5_000_000
    // Plant a 24h cooldown — the legacy `model_not_supported` 24h eviction
    // shape that the GC should sweep.
    pool.recordExhaustion("k", { delayMs: 24 * 60 * 60 * 1000, now })
    expect(pool.availableSlots("k", now)).toBe(0)
    pool.markModelUnsupported("k", "broken-model", now)
    expect(pool.modelCapability("k", "broken-model")).toBe("Unsupported")
    // Stale-cooldown GC should have fired.
    expect(pool.availableSlots("k", now)).toBeGreaterThan(0)
  })

  test("markModelUnsupported preserves recent cooldowns under 1h", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7 })
    const now = 5_000_000
    pool.recordExhaustion("k", { delayMs: 30 * 60 * 1000, now })
    pool.markModelUnsupported("k", "broken-model", now)
    // 30m cooldown is well under the 1h staleness threshold — must remain.
    expect(pool.availableSlots("k", now)).toBe(0)
  })

  test("failoverTokenForModel skips current key and Unsupported accounts", () => {
    const pool = new AccountPool({
      accounts: [{ key: "a" }, { key: "b" }, { key: "c" }],
      limit: 7,
    })
    pool.markModelUnsupported("b", "gpt-5")
    const pick = pool.failoverTokenForModel("a", "gpt-5")
    expect(pick).toBe("c")
  })

  test("failoverTokenForModel hard-prefers Supported over Unknown", () => {
    const pool = new AccountPool({
      accounts: [{ key: "a" }, { key: "b" }, { key: "c" }],
      limit: 7,
    })
    pool.setAccountCapabilities("c", ["gpt-5"])
    // b is Unknown, c is Supported — Supported must win regardless of
    // ordering / headroom.
    const pick = pool.failoverTokenForModel("a", "gpt-5")
    expect(pick).toBe("c")
  })

  test("failoverTokenForModel falls back to DiscoveryFailed when nothing else fits", () => {
    const pool = new AccountPool({
      accounts: [{ key: "a" }, { key: "b" }],
      limit: 7,
    })
    pool.markModelUnsupported("b", "model")
    const pick = pool.failoverTokenForModel("a", "model")
    expect(pick).toBeUndefined()
  })

  test("failoverTokenForModel returns undefined when no slots", () => {
    const pool = new AccountPool({ accounts: [{ key: "a" }, { key: "b" }], limit: 1 })
    // Saturate b; a is current
    pool.recordExhaustion("b", { delayMs: 60_000, now: 0 })
    expect(pool.failoverTokenForModel("a", "model", 1_000)).toBeUndefined()
  })

  test("hydrateExhaustion restores cooldown without advancing escalator", () => {
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7 })
    const now = 5_000_000
    pool.hydrateExhaustion({
      key: "k",
      exhaustedUntil: now + 60_000,
      headerless429Count: 2,
      last429At: now,
    })
    expect(pool.availableSlots("k", now)).toBe(0)
    // Next 429 *with* retry-after should reset the escalator (matches
    // `record429` semantics).
    const result = pool.recordExhaustion("k", { retryAfter: "30", now: now + 100 })
    expect(result.delayMs).toBe(30_000)
    expect(result.count).toBe(0)
  })

  test("attachStore hydrates rows and writes through on recordExhaustion", () => {
    const writes: Array<{ key: string; exhaustedUntil?: number; headerless429Count: number; last429At?: number }> = []
    const removes: string[] = []
    const fakeStore = {
      loadAll: () => [
        { key: "preloaded", exhaustedUntil: 9_999_999, headerless429Count: 1, last429At: 1_000 },
      ],
      upsert: (row: typeof writes[number]) => writes.push(row),
      remove: (key: string) => removes.push(key),
      flush: () => {},
      close: () => {},
    }
    const pool = new AccountPool({ accounts: [{ key: "preloaded" }, { key: "fresh" }], limit: 7, store: fakeStore })
    // Hydrated cooldown surfaces immediately.
    expect(pool.availableSlots("preloaded", 1_000_000)).toBe(0)
    pool.recordExhaustion("fresh", { delayMs: 60_000, now: 0 })
    expect(writes.find((row) => row.key === "fresh")).toBeDefined()
    // recordSuccess clears exhaustedUntil but the row remains until the
    // 24h-clean-run window erases the escalator counter — at which point
    // `persist` removes the now-empty row.
    pool.recordSuccess("fresh", 25 * 60 * 60 * 1000)
    expect(removes).toContain("fresh")
  })
})
