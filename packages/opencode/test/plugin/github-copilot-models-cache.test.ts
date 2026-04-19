import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import type { Model } from "@opencode-ai/sdk/v2"
import { ModelsCache } from "@/plugin/github-copilot/models-cache"

const sampleModel = (id: string): Model => ({
  id,
  providerID: "github-copilot",
  api: { id, url: "https://api.githubcopilot.com", npm: "@ai-sdk/github-copilot" },
  name: id,
  family: "gpt",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, input: 800, output: 200 },
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
  status: "active",
})

const tempCachePath = () =>
  path.join(os.tmpdir(), `oc-models-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

async function rmIfExists(p: string) {
  await fs.unlink(p).catch(() => undefined)
}

let toCleanup: string[] = []
afterEach(async () => {
  for (const p of toCleanup) await rmIfExists(p)
  toCleanup = []
})

function makeManager(overrides: {
  ttlMs?: number
  swrMs?: number
  fetcher: (input: ModelsCache.FetchArgs) => Promise<Record<string, Model>>
  persistPath?: string
  enabled?: boolean
}): ModelsCache.Manager {
  const persistPath = overrides.persistPath ?? tempCachePath()
  if (!overrides.persistPath) toCleanup.push(persistPath)
  return new ModelsCache.Manager({
    persistPath,
    fetcher: overrides.fetcher,
    options: {
      enabled: overrides.enabled ?? true,
      ttlMs: overrides.ttlMs ?? 5000,
      staleWhileRevalidateMs: overrides.swrMs ?? 2000,
    },
  })
}

describe("ModelsCache", () => {
  test("fresh get populates the cache and counts as a miss", async () => {
    let calls = 0
    const mgr = makeManager({
      fetcher: async () => {
        calls++
        return { "gpt-5.4": sampleModel("gpt-5.4") }
      },
    })
    const out = await mgr.get("github-copilot", {
      apiBase: "https://api.githubcopilot.com",
      headers: {},
      existing: {},
    })
    expect(Object.keys(out)).toEqual(["gpt-5.4"])
    expect(calls).toBe(1)
    expect(mgr.misses).toBe(1)
    expect(mgr.hits).toBe(0)
    expect(mgr.peek("github-copilot")?.apiBase).toBe("https://api.githubcopilot.com")
  })

  test("cache hit returns cached entry without fetching", async () => {
    let calls = 0
    const mgr = makeManager({
      ttlMs: 60_000,
      swrMs: 0, // disable SWR
      fetcher: async () => {
        calls++
        return { foo: sampleModel("foo") }
      },
    })
    const args = { apiBase: "https://api.githubcopilot.com", headers: {}, existing: {} }
    await mgr.get("k", args)
    await mgr.get("k", args)
    await mgr.get("k", args)
    expect(calls).toBe(1)
    expect(mgr.hits).toBe(2)
    expect(mgr.misses).toBe(1)
  })

  test("stale entry past TTL triggers a fresh fetch", async () => {
    let calls = 0
    const mgr = makeManager({
      ttlMs: 20,
      fetcher: async () => {
        calls++
        return { x: sampleModel(`v${calls}`) }
      },
    })
    const args = { apiBase: "b", headers: {}, existing: {} }
    await mgr.get("k", args)
    await new Promise((r) => setTimeout(r, 40))
    await mgr.get("k", args)
    expect(calls).toBe(2)
  })

  test("concurrent gets collapse onto a single in-flight fetch (refresh race)", async () => {
    let calls = 0
    let resolve!: () => void
    const gate = new Promise<void>((r) => (resolve = r))
    const mgr = makeManager({
      fetcher: async () => {
        calls++
        await gate
        return { x: sampleModel("x") }
      },
    })
    const args = { apiBase: "b", headers: {}, existing: {} }
    const p1 = mgr.get("k", args)
    const p2 = mgr.get("k", args)
    const p3 = mgr.get("k", args)
    // Release the single fetch
    resolve()
    await Promise.all([p1, p2, p3])
    expect(calls).toBe(1)
  })

  test("stale-while-revalidate returns cached and fires background refresh", async () => {
    let calls = 0
    const mgr = makeManager({
      ttlMs: 1000,
      swrMs: 5, // SWR kicks in almost immediately
      fetcher: async () => {
        calls++
        return { a: sampleModel(`v${calls}`) }
      },
    })
    const args = { apiBase: "b", headers: {}, existing: {} }
    await mgr.get("k", args) // miss → calls=1
    await new Promise((r) => setTimeout(r, 20))
    const hit = await mgr.get("k", args) // hit, but age>swrMs so refresh in bg
    expect(mgr.hits).toBe(1)
    expect(mgr.swrRefreshes).toBe(1)
    expect(Object.keys(hit)).toEqual(["a"])
    // Give the background refresh time to land, then verify it ran.
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(2)
  })

  test("refresh() always forces a live fetch even with a warm cache", async () => {
    let calls = 0
    const mgr = makeManager({
      ttlMs: 60_000,
      fetcher: async () => {
        calls++
        return { x: sampleModel("x") }
      },
    })
    const args = { apiBase: "b", headers: {}, existing: {} }
    await mgr.get("k", args)
    await mgr.refresh("k", args)
    expect(calls).toBe(2)
    expect(mgr.refreshes).toBe(1)
  })

  test("clear() invalidates and forces next get to fetch", async () => {
    let calls = 0
    const mgr = makeManager({
      fetcher: async () => {
        calls++
        return { x: sampleModel("x") }
      },
    })
    await mgr.get("k", { apiBase: "b", headers: {}, existing: {} })
    await mgr.clear("k")
    await mgr.get("k", { apiBase: "b", headers: {}, existing: {} })
    expect(calls).toBe(2)
    expect(mgr.list().length).toBe(1) // new entry written
  })

  test("disabled option bypasses the cache entirely", async () => {
    let calls = 0
    const mgr = makeManager({
      enabled: false,
      fetcher: async () => {
        calls++
        return { x: sampleModel("x") }
      },
    })
    for (let i = 0; i < 3; i++) {
      await mgr.get("k", { apiBase: "b", headers: {}, existing: {} })
    }
    expect(calls).toBe(3)
    expect(mgr.list().length).toBe(0)
  })

  test("persists to disk and reloads in a new Manager instance", async () => {
    const persistPath = tempCachePath()
    toCleanup.push(persistPath)
    const mgrA = makeManager({
      persistPath,
      fetcher: async () => ({ foo: sampleModel("foo") }),
    })
    await mgrA.get("acct", { apiBase: "b", headers: {}, existing: {} })

    // Give the async persist a tick to flush.
    await new Promise((r) => setTimeout(r, 5))

    let secondCalls = 0
    const mgrB = makeManager({
      persistPath,
      ttlMs: 60_000,
      fetcher: async () => {
        secondCalls++
        return { foo: sampleModel("foo") }
      },
    })
    // Fresh manager should satisfy from disk without fetching.
    const out = await mgrB.get("acct", { apiBase: "b", headers: {}, existing: {} })
    expect(Object.keys(out)).toEqual(["foo"])
    expect(secondCalls).toBe(0)
    expect(mgrB.hits).toBe(1)
  })

  test("optionsFromConfig: env vars override config which overrides defaults", () => {
    const prev = {
      enabled: process.env.OPENCODE_COPILOT_MODELS_CACHE_ENABLED,
      ttl: process.env.OPENCODE_COPILOT_MODELS_CACHE_TTL_MS,
      swr: process.env.OPENCODE_COPILOT_MODELS_CACHE_SWR_MS,
    }
    try {
      process.env.OPENCODE_COPILOT_MODELS_CACHE_TTL_MS = "1234"
      const opts = ModelsCache.optionsFromConfig({
        copilot: { modelsCache: { enabled: false, ttlMs: 9999, staleWhileRevalidateMs: 42 } },
      })
      // env ttl wins over config ttl.
      expect(opts.ttlMs).toBe(1234)
      // config `enabled: false` wins over default.
      expect(opts.enabled).toBe(false)
      // config SWR sticks because no env override.
      expect(opts.staleWhileRevalidateMs).toBe(42)
    } finally {
      if (prev.enabled === undefined) delete process.env.OPENCODE_COPILOT_MODELS_CACHE_ENABLED
      else process.env.OPENCODE_COPILOT_MODELS_CACHE_ENABLED = prev.enabled
      if (prev.ttl === undefined) delete process.env.OPENCODE_COPILOT_MODELS_CACHE_TTL_MS
      else process.env.OPENCODE_COPILOT_MODELS_CACHE_TTL_MS = prev.ttl
      if (prev.swr === undefined) delete process.env.OPENCODE_COPILOT_MODELS_CACHE_SWR_MS
      else process.env.OPENCODE_COPILOT_MODELS_CACHE_SWR_MS = prev.swr
    }
  })

  test("optionsFromConfig defaults to enabled=true, ttl=5min, swr=ttl/2", () => {
    const opts = ModelsCache.optionsFromConfig()
    expect(opts.enabled).toBe(true)
    expect(opts.ttlMs).toBe(ModelsCache.DEFAULT_TTL_MS)
    expect(opts.staleWhileRevalidateMs).toBe(Math.floor(ModelsCache.DEFAULT_TTL_MS / 2))
  })

  test("benchmark: 10 sequential gets hit the cache 9 times after warmup", async () => {
    let calls = 0
    const mgr = makeManager({
      ttlMs: 60_000,
      swrMs: 0,
      fetcher: async () => {
        calls++
        return { x: sampleModel("x") }
      },
    })
    const args = { apiBase: "b", headers: {}, existing: {} }
    for (let i = 0; i < 10; i++) await mgr.get("k", args)
    expect(calls).toBe(1) // one miss, nine hits
    expect(mgr.hits).toBe(9)
    expect(mgr.misses).toBe(1)
    const hitRatio = mgr.hits / (mgr.hits + mgr.misses)
    expect(hitRatio).toBeCloseTo(0.9, 2)
  })

  test("list() snapshots all cached entries", async () => {
    const mgr = makeManager({
      ttlMs: 60_000,
      fetcher: async () => ({ x: sampleModel("x") }),
    })
    await mgr.get("a", { apiBase: "b1", headers: {}, existing: {}, plan: "free" })
    await mgr.get("b", { apiBase: "b2", headers: {}, existing: {}, plan: "enterprise" })
    const rows = mgr.list().sort((x, y) => x.accountKey.localeCompare(y.accountKey))
    expect(rows.map((r) => r.accountKey)).toEqual(["a", "b"])
    expect(rows.map((r) => r.plan)).toEqual(["free", "enterprise"])
  })

  test("clear() with no key wipes everything", async () => {
    const mgr = makeManager({
      fetcher: async () => ({ x: sampleModel("x") }),
    })
    await mgr.get("a", { apiBase: "b", headers: {}, existing: {} })
    await mgr.get("b", { apiBase: "b", headers: {}, existing: {} })
    expect(mgr.list().length).toBe(2)
    await mgr.clear()
    expect(mgr.list().length).toBe(0)
  })
})
