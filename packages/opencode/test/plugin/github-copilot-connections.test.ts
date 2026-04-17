import { describe, expect, test } from "bun:test"
import {
  allowTestAccounts,
  clear,
  clearDeactivated,
  clearDiscovery,
  clearStaleExhaustion,
  discover,
  discovered,
  empty,
  filterTestAccounts,
  hasModel,
  isDeactivated,
  isTestAccountKey,
  machine,
  mark,
  markDeactivated,
  next,
  rotate,
  routed,
  sort,
  staleDiscovery,
  upsert,
} from "@/plugin/github-copilot/connections"
import { label, list } from "@/plugin/github-copilot/auth"

describe("github-copilot connections", () => {
  test("label derives primary and suffix labels", () => {
    expect(label("github-copilot")).toBe("Primary")
    expect(label("github-copilot#work")).toBe("work")
  })

  test("list filters copilot oauth accounts and sorts primary first", () => {
    const items = list({
      anthropic: { type: "api", key: "x" },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
    })
    expect(items.map((item) => item.key)).toEqual(["github-copilot", "github-copilot#work"])
  })

  test("sort prefers preferred key then primary", () => {
    const auths = list({
      "github-copilot#b": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#a": { type: "oauth", refresh: "r3", access: "a3", expires: 0 },
    })
    const items = sort(auths, { version: 1, preferred: "github-copilot#a", connections: {} })
    expect(items.map((item) => item.key)).toEqual(["github-copilot#a", "github-copilot", "github-copilot#b"])
  })

  test("next skips exhausted accounts", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
    })
    const state = mark(empty(), "github-copilot", 200)
    expect(next(auths, state, 100)?.key).toBe("github-copilot#work")
    expect(next(auths, state, 300)?.key).toBe("github-copilot")
  })

  test("mark and clear update exhaustion state", () => {
    const a = mark(empty(), "github-copilot", 123)
    expect(a.connections["github-copilot"]?.exhaustedUntil).toBe(123)
    const b = clear(a, "github-copilot")
    expect(b.connections["github-copilot"]?.exhaustedUntil).toBeUndefined()
  })

  test("machine id is stable per account", () => {
    const [a, first] = machine(empty(), "github-copilot")
    const [b, second] = machine(a, "github-copilot")
    expect(first).toBe(second)
    expect(b.connections["github-copilot"]?.machineId).toBe(first)
  })

  test("upsert stores login and preferred flags independently", () => {
    const state = upsert(empty(), "github-copilot#edu", { login: "student", preferred: true })
    expect(state.connections["github-copilot#edu"]).toEqual({ login: "student", preferred: true })
  })
})

test("discover stores normalized discovery snapshot", () => {
  const state = discover(empty(), "github-copilot#edu", {
    at: 123,
    models: ["gpt-5-mini", "gpt-4.1", "gpt-5-mini"],
    api: "https://api.githubcopilot.com",
    plan: "edu",
    login: "student",
    ok: true,
  })
  expect(state.connections["github-copilot#edu"]?.discovery).toEqual({
    at: 123,
    models: ["gpt-4.1", "gpt-5-mini"],
    api: "https://api.githubcopilot.com",
    plan: "edu",
    login: "student",
    ok: true,
    err: undefined,
  })
})

test("discovered reads stored discovery snapshot", () => {
  const state = discover(empty(), "github-copilot", { at: 123, models: ["gpt-4.1"] })
  expect(discovered(state, "github-copilot")).toEqual({
    at: 123,
    models: ["gpt-4.1"],
    api: undefined,
    plan: undefined,
    login: undefined,
    ok: undefined,
    err: undefined,
  })
})

test("hasModel checks discovery membership", () => {
  const state = discover(empty(), "github-copilot", { at: 123, models: ["gpt-4.1"] })
  expect(hasModel(state, "github-copilot", "gpt-4.1")).toBe(true)
  expect(hasModel(state, "github-copilot", "gpt-5-mini")).toBe(false)
})

test("staleDiscovery treats missing and old snapshots as stale", () => {
  const fresh = discover(empty(), "github-copilot", { at: 100, models: ["gpt-4.1"] })
  expect(staleDiscovery(empty(), "github-copilot", 100)).toBe(true)
  expect(staleDiscovery(fresh, "github-copilot", 100 + 31 * 60 * 1000)).toBe(true)
  expect(staleDiscovery(fresh, "github-copilot", 100 + 5 * 60 * 1000)).toBe(false)
})

test("clearDiscovery removes snapshot without touching other fields", () => {
  const state = clearDiscovery(
    discover(upsert(empty(), "github-copilot", { proxyUrl: "https://gcp.example", plan: "free" }), "github-copilot", {
      at: 123,
      models: ["gpt-4.1"],
    }),
    "github-copilot",
  )
  expect(state.connections["github-copilot"]).toEqual({
    proxyUrl: "https://gcp.example",
    plan: "free",
    discovery: undefined,
  })
})

test("rotate prefers least recently routed account", () => {
  const auths = list({
    "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
    "github-copilot#b": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
  })
  const state = {
    version: 1,
    connections: { "github-copilot": { lastRoutedAt: 200 }, "github-copilot#b": { lastRoutedAt: 100 } },
  }
  expect(rotate(state as any, auths as any).map((x: any) => x.key)).toEqual(["github-copilot#b", "github-copilot"])
})

test("routed stores last routed timestamp", () => {
  expect(routed(empty(), "github-copilot", 123).connections["github-copilot"]?.lastRoutedAt).toBe(123)
})

describe("monotonic exhaustion", () => {
  test("mark never shortens an existing cooldown", () => {
    const longCooldown = mark(empty(), "github-copilot", 1_000)
    const shorter = mark(longCooldown, "github-copilot", 500)
    expect(shorter.connections["github-copilot"]?.exhaustedUntil).toBe(1_000)
  })

  test("mark extends an existing cooldown to the later deadline", () => {
    const initial = mark(empty(), "github-copilot", 500)
    const extended = mark(initial, "github-copilot", 1_500)
    expect(extended.connections["github-copilot"]?.exhaustedUntil).toBe(1_500)
  })

  test("mark with equal timestamps is a no-op on value", () => {
    const a = mark(empty(), "github-copilot", 1_000)
    const b = mark(a, "github-copilot", 1_000)
    expect(b.connections["github-copilot"]?.exhaustedUntil).toBe(1_000)
  })
})

describe("stale exhaustion auto-clear", () => {
  test("clearStaleExhaustion drops elapsed deadlines", () => {
    const state = mark(empty(), "github-copilot", 100)
    const cleared = clearStaleExhaustion(state, 200)
    expect(cleared.connections["github-copilot"]?.exhaustedUntil).toBeUndefined()
  })

  test("clearStaleExhaustion preserves future deadlines", () => {
    const state = mark(empty(), "github-copilot", 500)
    const cleared = clearStaleExhaustion(state, 200)
    expect(cleared.connections["github-copilot"]?.exhaustedUntil).toBe(500)
  })

  test("clearStaleExhaustion is a no-op when nothing expired", () => {
    const state = mark(empty(), "github-copilot", 500)
    const cleared = clearStaleExhaustion(state, 200)
    expect(cleared).toBe(state)
  })

  test("clearStaleExhaustion preserves other fields on the connection", () => {
    const state = upsert(mark(empty(), "github-copilot", 100), "github-copilot", { login: "alice", plan: "free" })
    const cleared = clearStaleExhaustion(state, 200)
    expect(cleared.connections["github-copilot"]).toMatchObject({ login: "alice", plan: "free" })
    expect(cleared.connections["github-copilot"]?.exhaustedUntil).toBeUndefined()
  })
})

describe("#edu- test account stripping", () => {
  test("isTestAccountKey recognises #edu- suffixes only", () => {
    expect(isTestAccountKey("github-copilot#edu-alice")).toBe(true)
    expect(isTestAccountKey("github-copilot#edu")).toBe(false)
    expect(isTestAccountKey("github-copilot#work")).toBe(false)
    expect(isTestAccountKey("github-copilot")).toBe(false)
  })

  test("filterTestAccounts drops #edu- keys by default", () => {
    const prev = process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    delete process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    try {
      expect(allowTestAccounts()).toBe(false)
      const items = filterTestAccounts([
        { key: "github-copilot" },
        { key: "github-copilot#edu-e2e" },
        { key: "github-copilot#work" },
      ])
      expect(items.map((i) => i.key)).toEqual(["github-copilot", "github-copilot#work"])
    } finally {
      if (prev !== undefined) process.env.OPENCODE_ALLOW_TEST_ACCOUNTS = prev
    }
  })

  test("filterTestAccounts keeps #edu- keys when OPENCODE_ALLOW_TEST_ACCOUNTS=1", () => {
    const prev = process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    process.env.OPENCODE_ALLOW_TEST_ACCOUNTS = "1"
    try {
      expect(allowTestAccounts()).toBe(true)
      const items = filterTestAccounts([
        { key: "github-copilot" },
        { key: "github-copilot#edu-e2e" },
      ])
      expect(items.map((i) => i.key)).toEqual(["github-copilot", "github-copilot#edu-e2e"])
    } finally {
      if (prev !== undefined) process.env.OPENCODE_ALLOW_TEST_ACCOUNTS = prev
      else delete process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    }
  })

  test("sort strips #edu- accounts in production mode", () => {
    const prev = process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    delete process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    try {
      const auths = list({
        "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
        "github-copilot#edu-alice": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
        "github-copilot#work": { type: "oauth", refresh: "r3", access: "a3", expires: 0 },
      })
      const sorted = sort(auths, empty())
      expect(sorted.map((i) => i.key)).toEqual(["github-copilot", "github-copilot#work"])
    } finally {
      if (prev !== undefined) process.env.OPENCODE_ALLOW_TEST_ACCOUNTS = prev
    }
  })

  test("next falls back to primary but never a #edu- account in prod", () => {
    const prev = process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    delete process.env.OPENCODE_ALLOW_TEST_ACCOUNTS
    try {
      const auths = list({
        "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
        "github-copilot#edu-alice": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
      })
      const state = mark(empty(), "github-copilot", 500)
      // Even though primary is exhausted, the #edu- account must not be picked.
      expect(next(auths, state, 100)?.key).toBe("github-copilot")
    } finally {
      if (prev !== undefined) process.env.OPENCODE_ALLOW_TEST_ACCOUNTS = prev
    }
  })
})

describe("deactivated flag (401/403)", () => {
  test("markDeactivated sets the flag and isDeactivated reads it", () => {
    const state = markDeactivated(empty(), "github-copilot#work")
    expect(isDeactivated(state, "github-copilot#work")).toBe(true)
    expect(isDeactivated(state, "github-copilot")).toBe(false)
  })

  test("clearDeactivated removes the flag", () => {
    const flagged = markDeactivated(empty(), "github-copilot")
    const cleared = clearDeactivated(flagged, "github-copilot")
    expect(isDeactivated(cleared, "github-copilot")).toBe(false)
  })

  test("next skips deactivated accounts even when they are not exhausted", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
    })
    const state = markDeactivated(empty(), "github-copilot")
    expect(next(auths, state)?.key).toBe("github-copilot#work")
  })

  test("next returns a deactivated account only when no active alternative exists", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
    })
    const state = markDeactivated(empty(), "github-copilot")
    // Single account — fall back to it rather than returning undefined.
    expect(next(auths, state)?.key).toBe("github-copilot")
  })

  test("deactivated flag is independent of exhaustedUntil", () => {
    const state = markDeactivated(mark(empty(), "github-copilot", 1_000), "github-copilot")
    expect(state.connections["github-copilot"]?.deactivated).toBe(true)
    expect(state.connections["github-copilot"]?.exhaustedUntil).toBe(1_000)
    const afterClear = clear(state, "github-copilot")
    // Clearing exhaustion must NOT clear deactivation.
    expect(afterClear.connections["github-copilot"]?.deactivated).toBe(true)
    expect(afterClear.connections["github-copilot"]?.exhaustedUntil).toBeUndefined()
  })
})
