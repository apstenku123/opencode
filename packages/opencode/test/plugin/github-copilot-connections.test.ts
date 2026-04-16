import { describe, expect, test } from "bun:test"
import {
  clear,
  clearDiscovery,
  discover,
  discovered,
  empty,
  hasModel,
  machine,
  mark,
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
