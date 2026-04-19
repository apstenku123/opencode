import { afterEach, describe, expect, mock, test } from "bun:test"
import { clear, empty, mark, proxy, type State } from "@/plugin/github-copilot/connections"
import {
  aliases,
  dispatch,
  model,
  policyPlan,
  preferAccount,
  discoveryRank,
  recent429,
  recentDiscoveryError,
  preferDiscovery,
  preferPlan,
  preferPolicy,
  premiumRollback,
  premiumState,
  protocol,
  proxyConfig,
  proxyHeaders,
  refreshAccount,
  routeAccount,
  routeDebug,
  score,
  routeAlias,
  routeProvider,
  copilotRuntimeConfig,
  runtimeScore,
  autobestBatch,
  CopilotRuntimeState,
  routedFetch,
  routeUrl,
  selectAccount,
  syncAccount,
} from "@/plugin/github-copilot/copilot"
import { io, legacy, migrate, readMigration, summarizeMigration } from "@/plugin/github-copilot/auth"
import type { CopilotAuth } from "@/plugin/github-copilot/auth"
import { owner } from "@/plugin/github-copilot/runtime"
import { Auth } from "@/auth"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect, Layer } from "effect"
import { tmpdir } from "node:os"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"

const origFetch = globalThis.fetch
const origAll = globalThis.crypto

afterEach(() => {
  globalThis.fetch = origFetch
})

describe("github-copilot auth helpers", () => {
  test("selectAccount skips exhausted primary and picks next account", () => {
    const auths: CopilotAuth[] = [
      { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
      { key: "github-copilot#work", label: "work", refresh: "b", access: "b", expires: 0 },
    ]
    const fallback = auths[0]
    const state = mark(empty(), "github-copilot", 200)
    expect(selectAccount({ auths, state, fallback, now: 100 }).key).toBe("github-copilot#work")
  })

  test("premiumRollback makes first request premium again after rollback", () => {
    const state = new Map<string, Set<string>>()
    expect(premiumState(state, "github-copilot", "gpt-5-mini")).toBe(true)
    expect(premiumState(state, "github-copilot", "gpt-5-mini")).toBe(false)
    premiumRollback(state, "github-copilot", "gpt-5-mini")
    expect(premiumState(state, "github-copilot", "gpt-5-mini")).toBe(true)
  })

  test("protocol carries machine id and premium headers", () => {
    const headers = protocol({
      token: "tok",
      machineId: "mid",
      sessionId: "sid",
      premium: true,
      vision: false,
      agent: false,
    })
    expect(headers["X-Client-Machine-Id"]).toBe("mid")
    expect(headers["X-Client-Session-Id"]).toBe("sid")
    expect(headers["x-initiator"]).toBe("user")
    expect(headers["X-Interaction-Type"]).toBe("conversation-user")
  })

  test("dispatch retries via pool.reassign on 429 when a failover account is available", async () => {
    // Two accounts; first dispatch hits 429 on the primary, reassign must
    // atomically swap the lease to the backup and retry once. Mirrors Rust
    // `core/src/account_pool.rs:1038-1142` + `:1390-1430`.
    const { AccountPool } = await import("@/plugin/github-copilot/account-pool")
    let state = empty()
    // `refreshAccount` inside dispatch calls fetchQuota() against
    // `api.github.com/copilot_internal/user` — swallow that route separately
    // so we only count the actual chat/completions dispatches.
    const dispatches: { url: string; token?: string }[] = []
    globalThis.fetch = mock((url: RequestInfo | URL, init?: RequestInit) => {
      const href = url instanceof URL ? url.href : url.toString()
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      if (href.includes("/copilot_internal/user")) {
        // Pretend quota lookup fails cheaply — dispatch falls through the
        // catch path without mutating exhaustion state.
        return Promise.resolve(new Response("nope", { status: 500 }))
      }
      dispatches.push({ url: href, token: auth })
      if (dispatches.length === 1) return Promise.resolve(new Response("rate", { status: 429 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch

    const runtime = owner()
    const pool = new AccountPool({
      accounts: [{ key: "github-copilot" }, { key: "github-copilot#work" }],
      runtime,
      limit: 2,
    })
    // Mark model supported on the failover account so
    // `failoverTokenForModel` prefers it.
    pool.setAccountCapabilities("github-copilot#work", ["gpt-5-mini"])

    const auths: CopilotAuth[] = [
      { key: "github-copilot", label: "Primary", refresh: "root", access: "root", expires: 0 },
      { key: "github-copilot#work", label: "Work", refresh: "work-token", access: "work-token", expires: 0 },
    ]

    const res = await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths,
      read: async () => state,
      write: async (next: State) => {
        state = next
      },
      premium: new Map(),
      runtime,
      pool,
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })

    expect(dispatches.length).toBe(2)
    expect(res.status).toBe(200)
    // Two dispatches, second one on the failover token.
    expect(dispatches[0]?.token).toBe("Bearer root")
    expect(dispatches[1]?.token).toBe("Bearer work-token")
    // Primary was marked exhausted; work key is not.
    expect(state.connections["github-copilot"]?.exhaustedUntil).toBeGreaterThan(Date.now() - 1000)
    // Lease fully released after successful retry — no leaked reservations on
    // either slot (raw runtime pool count, not effective slots: primary is
    // in cooldown so `availableSlots` would be 0).
    expect(runtime.pool["github-copilot"] ?? 0).toBe(0)
    expect(runtime.pool["github-copilot#work"] ?? 0).toBe(0)
  })

  test("dispatch does not retry on 429 when no failover candidate exists", async () => {
    // Single-account pool — failoverTokenForModel returns undefined, so the
    // original 429 response is surfaced to the caller.
    const { AccountPool } = await import("@/plugin/github-copilot/account-pool")
    let state = empty()
    const dispatches: string[] = []
    globalThis.fetch = mock((url: RequestInfo | URL) => {
      const href = url instanceof URL ? url.href : url.toString()
      if (href.includes("/copilot_internal/user")) {
        return Promise.resolve(new Response("nope", { status: 500 }))
      }
      dispatches.push(href)
      return Promise.resolve(new Response("rate", { status: 429 }))
    }) as unknown as typeof fetch

    const runtime = owner()
    const pool = new AccountPool({
      accounts: [{ key: "github-copilot" }],
      runtime,
      limit: 2,
    })

    const res = await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot", label: "Primary", refresh: "root", access: "root", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
      },
      premium: new Map(),
      runtime,
      pool,
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })

    expect(dispatches.length).toBe(1)
    expect(res.status).toBe(429)
    // After 429 record the account is in cooldown → effective slots drop to 0.
    // What matters for lease accounting is that the runtime pool count is 0
    // (no leaked reservation after release).
    expect(runtime.pool["github-copilot"] ?? 0).toBe(0)
  })

  test("dispatch persists machine id and marks 429 exhaustion", async () => {
    const writes: State[] = []
    let state = empty()
    globalThis.fetch = mock(() => Promise.resolve(new Response("rate", { status: 429 }))) as unknown as typeof fetch

    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot", label: "Primary", refresh: "root", access: "root", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
        writes.push(next)
      },
      premium: new Map(),
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })

    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(writes[0].connections["github-copilot"]?.machineId).toBeTruthy()
    expect(writes[writes.length - 1].connections["github-copilot"]?.exhaustedUntil).toBeGreaterThan(Date.now() - 1000)
  })

  test("dispatch clears exhaustion on ok", async () => {
    const writes: State[] = []
    let state = mark(empty(), "github-copilot", Date.now() + 10000)
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 }))) as unknown as typeof fetch

    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot", label: "Primary", refresh: "root", access: "root", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
        writes.push(next)
      },
      premium: new Map(),
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })

    expect(writes[writes.length - 1].connections["github-copilot"]?.exhaustedUntil).toBeUndefined()
    expect(writes[0].connections["github-copilot"]?.machineId).toBeTruthy()
  })

  test("selectAccount falls back when no accounts are available", () => {
    const fallback: CopilotAuth = { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 }
    expect(selectAccount({ auths: [], state: empty(), fallback }).key).toBe("github-copilot")
  })

  test("model extracts only string model ids", () => {
    expect(model(undefined)).toBe("")
    expect(model({})).toBe("")
    expect(model({ model: 1 })).toBe("")
    expect(model({ model: "gpt-4.1" })).toBe("gpt-4.1")
  })

  test("protocol marks agent and vision requests", () => {
    const headers = protocol({
      init: { headers: { authorization: "old", "x-api-key": "x", foo: "bar" } },
      token: "tok",
      machineId: "mid",
      sessionId: "sid",
      premium: false,
      vision: true,
      agent: true,
    })
    expect(headers.foo).toBe("bar")
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["X-Interaction-Type"]).toBe("conversation-subagent")
    expect(headers["Copilot-Vision-Request"]).toBe("true")
    expect(headers.authorization).toBeUndefined()
    expect(headers["x-api-key"]).toBeUndefined()
  })

  test("dispatch rolls premium back on 401", async () => {
    const prem = new Map<string, Set<string>>()
    const writes: State[] = []
    let state = empty()
    globalThis.fetch = mock(() => Promise.resolve(new Response("no", { status: 401 }))) as unknown as typeof fetch

    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot", label: "Primary", refresh: "root", access: "root", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
        writes.push(next)
      },
      premium: prem,
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })

    expect(premiumState(prem, "github-copilot", "gpt-5-mini")).toBe(true)
  })

  test("dispatch bypasses pool for non-oauth auth", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 }))) as unknown as typeof fetch
    const res = await dispatch({
      getAuth: async () => ({ type: "api", key: "x" }) as any,
      auths: [],
      read: async () => empty(),
      write: async () => {},
      premium: new Map(),
      runtime: owner(),
      request: "https://example.com",
      init: { headers: { a: "b" } },
      isVision: false,
      isAgent: false,
      modelId: "",
    })
    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

test("syncAccount mirrors auth labels into state", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#edu", label: "edu", refresh: "b", access: "b", expires: 0 },
  ]
  const state = syncAccount(empty(), auths)
  expect(state.connections["github-copilot"]?.label).toBe("Primary")
  expect(state.connections["github-copilot#edu"]?.label).toBe("edu")
})

test("preferPlan narrows edu/free account pools when matching plans exist", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#edu", label: "edu", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#edu": { plan: "edu" },
    },
  }
  expect(preferPlan(state, auths, "gpt-4.1-edu").map((x) => x.key)).toEqual(["github-copilot#edu"])
  expect(preferPlan(state, auths, "gpt-4.1-free").map((x) => x.key)).toEqual(["github-copilot"])
  expect(preferPlan(state, auths, "gpt-5-mini").map((x) => x.key)).toEqual(["github-copilot", "github-copilot#edu"])
})

test("refreshAccount stores login and classified plan", async () => {
  const prev = globalThis.fetch
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ user_login: "alice", copilot_plan: "enterprise", access_type_sku: "enterprise" }), {
        status: 200,
      }),
    ),
  ) as unknown as typeof fetch
  try {
    const state = await refreshAccount({ state: empty(), key: "github-copilot", token: "tok" })
    expect(state.connections["github-copilot"]?.login).toBe("alice")
    expect(state.connections["github-copilot"]?.plan).toBe("enterprise")
    expect(state.connections["github-copilot"]?.lastTestedAt).toBeTruthy()
  } finally {
    globalThis.fetch = prev
  }
})

test("dispatch syncs label and refreshed account metadata before machine persistence", async () => {
  const writes: State[] = []
  let state = empty()
  const prev = globalThis.fetch
  globalThis.fetch = mock((url) => {
    const text = String(url)
    if (text.includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "alice", access_type_sku: "edu" }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch

  try {
    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot#edu", label: "edu", refresh: "root", access: "root", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
        writes.push(next)
      },
      premium: new Map(),
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-4.1-edu",
    })
    expect(writes[0].connections["github-copilot#edu"]?.login).toBe("alice")
    expect(writes[0].connections["github-copilot#edu"]?.plan).toBe("edu")
    expect(writes[0].connections["github-copilot#edu"]?.label).toBe("edu")
    expect(writes[0].connections["github-copilot#edu"]?.machineId).toBeTruthy()
  } finally {
    globalThis.fetch = prev
  }
})

test("policyPlan derives enterprise business team personal aliases", () => {
  expect(policyPlan("gpt-5-enterprise")).toBe("enterprise")
  expect(policyPlan("gpt-5-business")).toBe("business")
  expect(policyPlan("gpt-5-team")).toBe("team")
  expect(policyPlan("gpt-4.1-personal")).toBe("free")
  expect(policyPlan("gpt-5-mini")).toBeUndefined()
})

test("preferAccount promotes preferred key before fallback order", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#team", label: "team", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = { version: 1, preferred: "github-copilot#team", connections: {} }
  expect(preferAccount(state, auths).map((x) => x.key)).toEqual(["github-copilot#team", "github-copilot"])
})

test("preferPolicy combines preferred plan and exhaustion explicitly", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise", label: "enterprise", refresh: "b", access: "b", expires: 0 },
    { key: "github-copilot#business", label: "business", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    preferred: "github-copilot#enterprise",
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#enterprise": { plan: "enterprise", exhaustedUntil: 500 },
      "github-copilot#business": { plan: "business" },
    },
  }
  expect(preferPolicy(state, auths, "gpt-5-enterprise", 100)[0]?.key).toBe("github-copilot")
  expect(preferPolicy(state, auths, "gpt-5-business", 100)[0]?.key).toBe("github-copilot#business")
  expect(preferPolicy(state, auths, "gpt-5-enterprise", 600)[0]?.key).toBe("github-copilot#enterprise")
})

test("aliases expose edu enterprise and personal/free route ids", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#edu", label: "edu", refresh: "b", access: "b", expires: 0 },
    { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#edu": { plan: "edu" },
      "github-copilot#enterprise-real": { plan: "enterprise" },
    },
  }
  expect(aliases(auths, state)).toEqual({
    "github-copilot#edu": "github-copilot#edu",
    "github-copilot#enterprise": "github-copilot#enterprise-real",
    "github-copilot#personal": "github-copilot",
    "github-copilot#free": "github-copilot",
  })
})

test("routeAlias resolves alias ids to concrete account keys", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#enterprise-real": { plan: "enterprise" },
    },
  }
  expect(routeAlias(auths, state, "github-copilot#enterprise")).toBe("github-copilot#enterprise-real")
  expect(routeAlias(auths, state, "github-copilot#free")).toBe("github-copilot")
})

test("routeProvider resolves only github-copilot alias providers", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#edu-real", label: "edu-real", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: { "github-copilot": { plan: "free" }, "github-copilot#edu-real": { plan: "edu" } },
  }
  expect(routeProvider("github-copilot#edu", auths, state)).toBe("github-copilot#edu-real")
  expect(routeProvider("openai", auths, state)).toBeUndefined()
})

test("routeAccount prefers explicit alias route over generic policy pool", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#enterprise-real": { plan: "enterprise" },
    },
  }
  const fallback = auths[0]
  expect(
    routeAccount({ auths, state, modelId: "gpt-5-mini", providerID: "github-copilot#enterprise", fallback }).key,
  ).toBe("github-copilot#enterprise-real")
})

test("dispatch honors explicit alias provider route", async () => {
  const writes: State[] = []
  let state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#enterprise-real": { plan: "enterprise" },
    },
  }
  const calls: Array<RequestInit | undefined> = []
  const prev = globalThis.fetch
  globalThis.fetch = mock((url, init) => {
    calls.push(init)
    if (String(url).includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "corp", access_type_sku: "enterprise" }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [
        { key: "github-copilot", label: "Primary", refresh: "free", access: "free", expires: 0 },
        { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "ent", access: "ent", expires: 0 },
      ],
      read: async () => state,
      write: async (next: State) => {
        state = next
        writes.push(next)
      },
      premium: new Map(),
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      providerID: "github-copilot#enterprise",
      modelId: "gpt-5-mini",
    })
    expect((calls.at(-1)?.headers as Record<string, string>).Authorization).toBe("Bearer ent")
    expect(writes[0].connections["github-copilot#enterprise-real"]?.login).toBe("corp")
  } finally {
    globalThis.fetch = prev
  }
})

test("proxy helper returns per-account proxy config", () => {
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { proxyUrl: "https://gcp-proxy.example", proxyToken: "tok" },
    },
  }
  expect(proxy(state, "github-copilot")).toEqual({
    url: "https://gcp-proxy.example",
    token: "tok",
    envelope: undefined,
  })
  expect(proxyConfig(state, "github-copilot")).toEqual({
    url: "https://gcp-proxy.example",
    token: "tok",
    envelope: undefined,
  })
})

test("proxy headers inject per-account proxy token", () => {
  expect(proxyHeaders()).toEqual({})
  expect(proxyHeaders("tok")).toEqual({ "x-copilot-proxy-token": "tok" })
})

test("routeUrl keeps direct path without proxy and rewrites through proxy base", () => {
  expect(routeUrl("https://api.githubcopilot.com/chat/completions", undefined)).toBe(
    "https://api.githubcopilot.com/chat/completions",
  )
  expect(routeUrl("/chat/completions", { url: "https://gcp-proxy.example" })).toBe(
    "https://gcp-proxy.example/chat/completions",
  )
})

test("routedFetch injects proxy header and falls back when proxy missing", async () => {
  const prev = globalThis.fetch
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = mock((url, init) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await routedFetch("/chat/completions", { headers: { a: "b" } }, { url: "https://gcp-proxy.example", token: "tok" })
    await routedFetch("https://api.githubcopilot.com/chat/completions", { headers: { a: "b" } }, undefined)
    expect(calls[0]).toEqual({
      url: "https://gcp-proxy.example/chat/completions",
      headers: { a: "b", "x-copilot-proxy-token": "tok" },
    })
    expect(calls[1]).toEqual({
      url: "https://api.githubcopilot.com/chat/completions",
      headers: { a: "b" },
    })
  } finally {
    globalThis.fetch = prev
  }
})

test("dispatch routes through per-account proxy and injects proxy token header", async () => {
  const writes: State[] = []
  let state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-real": {
        plan: "enterprise",
        proxyUrl: "https://gcp-proxy.example",
        proxyToken: "ptok",
      },
    },
  }
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const prev = globalThis.fetch
  globalThis.fetch = mock((url, init) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
    if (String(url).includes("/copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "corp", access_type_sku: "enterprise" }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [
        { key: "github-copilot", label: "Primary", refresh: "free", access: "free", expires: 0 },
        { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "ent", access: "ent", expires: 0 },
      ],
      read: async () => state,
      write: async (next: State) => {
        state = next
        writes.push(next)
      },
      premium: new Map(),
      runtime: owner(),
      request: "/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      providerID: "github-copilot#enterprise",
      modelId: "gpt-5-mini",
    })
    expect(calls.at(-1)?.url).toBe("https://gcp-proxy.example/chat/completions")
    expect(calls.at(-1)?.headers["x-copilot-proxy-token"]).toBe("ptok")
    expect(writes[0].connections["github-copilot#enterprise-real"]?.login).toBe("corp")
  } finally {
    globalThis.fetch = prev
  }
})

test("dispatch falls back to direct fetch when account has no proxy", async () => {
  let state = empty()
  const calls: string[] = []
  const prev = globalThis.fetch
  globalThis.fetch = mock((url) => {
    calls.push(String(url))
    if (String(url).includes("/copilot_internal/user"))
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "free", access_type_sku: "free" }), { status: 200 }),
      )
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot", label: "Primary", refresh: "free", access: "free", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
      },
      premium: new Map(),
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })
    expect(calls.at(-1)).toBe("https://api.githubcopilot.com/chat/completions")
  } finally {
    globalThis.fetch = prev
  }
})

test("preferDiscovery narrows to accounts with discovered model support", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#enterprise-real": { plan: "enterprise", discovery: { at: Date.now(), models: ["gpt-5-mini"] } },
    },
  }
  expect(preferDiscovery(state, auths, "gpt-5-mini").map((x) => x.key)).toEqual(["github-copilot#enterprise-real"])
})

test("preferDiscovery falls back when no account has discovered model", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-real", label: "enterprise-real", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = { version: 1, connections: {} }
  expect(preferDiscovery(state, auths, "gpt-5-mini").map((x) => x.key)).toEqual([
    "github-copilot",
    "github-copilot#enterprise-real",
  ])
})

test("discoveryRank prefers fresh ok over stale and error snapshots", () => {
  const now = Date.now()
  const state: State = {
    version: 1,
    connections: {
      fresh: { discovery: { at: now, models: ["gpt-5-mini"], ok: true } },
      stale: { discovery: { at: now - 31 * 60 * 1000, models: ["gpt-5-mini"], ok: true } },
      bad: { discovery: { at: now, models: ["gpt-5-mini"], ok: false, err: "boom" } },
      none: {},
    },
  }
  expect(discoveryRank(state, "fresh", "gpt-5-mini")).toBe(3)
  expect(discoveryRank(state, "stale", "gpt-5-mini")).toBe(2)
  expect(discoveryRank(state, "bad", "gpt-5-mini")).toBe(1)
  expect(discoveryRank(state, "none", "gpt-5-mini")).toBe(0)
})

test("preferDiscovery prefers fresh ok snapshots over stale and error", () => {
  const now = Date.now()
  const auths: CopilotAuth[] = [
    { key: "bad", label: "bad", refresh: "a", access: "a", expires: 0 },
    { key: "stale", label: "stale", refresh: "b", access: "b", expires: 0 },
    { key: "fresh", label: "fresh", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      bad: { discovery: { at: now, models: ["gpt-5-mini"], ok: false, err: "boom" } },
      stale: { discovery: { at: now - 31 * 60 * 1000, models: ["gpt-5-mini"], ok: true } },
      fresh: { discovery: { at: now, models: ["gpt-5-mini"], ok: true } },
    },
  }
  expect(preferDiscovery(state, auths, "gpt-5-mini").map((x) => x.key)).toEqual(["fresh"])
})

test("preferDiscovery prefers stale over discovery error when no fresh snapshot exists", () => {
  const now = Date.now()
  const auths: CopilotAuth[] = [
    { key: "bad", label: "bad", refresh: "a", access: "a", expires: 0 },
    { key: "stale", label: "stale", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      bad: { discovery: { at: now, models: ["gpt-5-mini"], ok: false, err: "boom" } },
      stale: { discovery: { at: now - 31 * 60 * 1000, models: ["gpt-5-mini"], ok: true } },
    },
  }
  expect(preferDiscovery(state, auths, "gpt-5-mini").map((x) => x.key)).toEqual(["stale"])
})

test("recent penalty helpers detect recent 429 and discovery errors", () => {
  const now = 10_000
  const state: State = {
    version: 1,
    connections: {
      a: { exhaustedUntil: now + 100 },
      b: { lastDiscoveryErrorAt: now - 100 },
      c: { exhaustedUntil: now - 16 * 60 * 1000, lastDiscoveryErrorAt: now - 31 * 60 * 1000 },
    },
  }
  expect(recent429(state, "a", now)).toBe(true)
  expect(recent429(state, "c", now)).toBe(false)
  expect(recentDiscoveryError(state, "b", now)).toBe(true)
  expect(recentDiscoveryError(state, "c", now)).toBe(false)
})

test("preferDiscovery applies penalty inside same discovery rank", () => {
  const now = Date.now()
  const auths: CopilotAuth[] = [
    { key: "penalized", label: "penalized", refresh: "a", access: "a", expires: 0 },
    { key: "clean", label: "clean", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      penalized: {
        exhaustedUntil: now + 60_000,
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
      clean: {
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
    },
  }
  expect(preferDiscovery(state, auths, "gpt-5-enterprise", now).map((x) => x.key)).toEqual(["clean"])
})

test("routeAccount prefers cleaner discovery candidate inside plan lane", () => {
  const now = Date.now()
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
    { key: "github-copilot#free", label: "free", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": {
        plan: "enterprise",
        exhaustedUntil: now + 60_000,
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
      "github-copilot#enterprise-b": {
        plan: "enterprise",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
      "github-copilot#free": {
        plan: "free",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
    },
  }
  expect(routeAccount({ auths, state, modelId: "gpt-5-enterprise", fallback: auths[0], now }).key).toBe(
    "github-copilot#enterprise-b",
  )
})

test("score exposes discovery and penalty components", () => {
  const now = Date.now()
  const state: State = {
    version: 1,
    connections: {
      a: {
        exhaustedUntil: now + 60_000,
        lastDiscoveryErrorAt: now - 100,
        discovery: { at: now, models: ["gpt-5-mini"], ok: true },
      },
    },
  }
  expect(score(state, "a", "gpt-5-mini", now)).toEqual({
    discovery: 3,
    penalty: 2,
    recent429: true,
    recentDiscoveryError: true,
  })
})

test("routeDebug explains lane discovery and penalties", () => {
  const now = Date.now()
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise", label: "enterprise", refresh: "a", access: "a", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise": {
        plan: "enterprise",
        lastDiscoveryErrorAt: now - 100,
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
    },
  }
  expect(routeDebug({ auths, state, modelId: "gpt-5-enterprise", now })[0]).toEqual({
    key: "github-copilot#enterprise",
    alias: undefined,
    lane: "enterprise",
    discovery: 3,
    recent429: false,
    recentDiscoveryError: true,
    penalty: 1,
    load: 0,
    cooldown: false,
    routeReason: ["lane:enterprise", "discovery:3", "penalty:recentDiscoveryError"],
    selectedReason: ["lane:enterprise", "discovery:3", "penalty:recentDiscoveryError"],
    rejectedReason: [],
    selected: true,
  })
})

test("routeDebug marks rejected reasons for lower ranked candidates", () => {
  const now = Date.now()
  const auths: CopilotAuth[] = [
    { key: "a", label: "a", refresh: "a", access: "a", expires: 0 },
    { key: "b", label: "b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      a: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
      b: { plan: "enterprise", discovery: { at: now - 31 * 60 * 1000, models: ["gpt-5-enterprise"], ok: true } },
    },
  }
  const data = routeDebug({ auths, state, modelId: "gpt-5-enterprise", now })
  expect(data.find((x) => x.key === "b")?.rejectedReason).toContain("lowerDiscoveryRank")
})
test("routeAccount prefers discovery-supported account inside policy pool", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": { plan: "enterprise" },
      "github-copilot#enterprise-b": {
        plan: "enterprise",
        discovery: { at: Date.now(), models: ["gpt-5-enterprise"] },
      },
    },
  }
  expect(routeAccount({ auths, state, modelId: "gpt-5-enterprise", fallback: auths[0] }).key).toBe(
    "github-copilot#enterprise-b",
  )
})

test("routeAccount keeps explicit alias precedence over discovery", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": { plan: "enterprise" },
      "github-copilot#enterprise-b": {
        plan: "enterprise",
        discovery: { at: Date.now(), models: ["gpt-5-enterprise"] },
      },
    },
  }
  expect(
    routeAccount({
      auths,
      state,
      modelId: "gpt-5-enterprise",
      providerID: "github-copilot#enterprise-a",
      fallback: auths[0],
    }).key,
  ).toBe("github-copilot#enterprise-a")
})

test("routeAccount keeps plan policy ahead of wrong-lane discovery", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#edu", label: "edu", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free", discovery: { at: Date.now(), models: ["gpt-4.1-edu"] } },
      "github-copilot#edu": { plan: "edu" },
    },
  }
  expect(routeAccount({ auths, state, modelId: "gpt-4.1-edu", fallback: auths[0] }).key).toBe("github-copilot#edu")
})

test("preferPolicy rotates accounts by least recently routed within pool", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": { plan: "enterprise", lastRoutedAt: 200 },
      "github-copilot#enterprise-b": { plan: "enterprise", lastRoutedAt: 100 },
    },
  }
  expect(preferPolicy(state, auths, "gpt-5-enterprise")[0]?.key).toBe("github-copilot#enterprise-b")
})

test("dispatch records last routed timestamp for selected account", async () => {
  let state: State = empty()
  const prev = globalThis.fetch
  globalThis.fetch = mock((url) => {
    if (String(url).includes("/copilot_internal/user"))
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "free", access_type_sku: "free" }), { status: 200 }),
      )
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths: [{ key: "github-copilot", label: "Primary", refresh: "free", access: "free", expires: 0 }],
      read: async () => state,
      write: async (next: State) => {
        state = next
      },
      premium: new Map(),
      runtime: owner(),
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-mini",
    })
    expect(state.connections["github-copilot"]?.lastRoutedAt).toBeTruthy()
  } finally {
    globalThis.fetch = prev
  }
})

test("routeAccount skips busy account when another candidate is idle", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": { plan: "enterprise", lastRoutedAt: 100 },
      "github-copilot#enterprise-b": { plan: "enterprise", lastRoutedAt: 200 },
    },
  }
  const runtime = owner()
  runtime.pool = { "github-copilot#enterprise-a": 1 }
  expect(routeAccount({ auths, state, modelId: "gpt-5-enterprise", fallback: auths[0], runtime }).key).toBe(
    "github-copilot#enterprise-b",
  )
})

test("routeAccount falls back to ranked pool when all candidates are busy", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": { plan: "enterprise", lastRoutedAt: 100 },
      "github-copilot#enterprise-b": { plan: "enterprise", lastRoutedAt: 200 },
    },
  }
  const runtime = owner()
  runtime.pool = { "github-copilot#enterprise-a": 1, "github-copilot#enterprise-b": 1 }
  expect(routeAccount({ auths, state, modelId: "gpt-5-enterprise", fallback: auths[0], runtime }).key).toBe(
    "github-copilot#enterprise-a",
  )
})

test("dispatch releases runtime slot on success and applies cooldown-aware reuse", async () => {
  let state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": { plan: "enterprise", lastRoutedAt: 100 },
      "github-copilot#enterprise-b": { plan: "enterprise", lastRoutedAt: 200 },
    },
  }
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "tok-a", access: "tok-a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "tok-b", access: "tok-b", expires: 0 },
  ]
  const runtime = owner()
  const prev = globalThis.fetch
  globalThis.fetch = mock((url, init) => {
    const text = String(url)
    if (text.includes("/copilot_internal/user")) {
      const auth = String((init?.headers as Record<string, string>)?.authorization || "")
      const key = auth.includes("tok-a") ? "github-copilot#enterprise-a" : "github-copilot#enterprise-b"
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: key, access_type_sku: "enterprise" }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths,
      read: async () => state,
      write: async (next: State) => {
        state = next
      },
      premium: new Map(),
      runtime,
      request: "https://api.githubcopilot.com/chat/completions",
      init: { headers: {} },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-enterprise",
    })
    expect(runtime.pool).toEqual({})
    expect(routeAccount({ auths, state, modelId: "gpt-5-enterprise", fallback: auths[0], runtime }).key).toBe(
      "github-copilot#enterprise-b",
    )
  } finally {
    globalThis.fetch = prev
  }
})

test("dispatch releases runtime slot on 401 and 429", async () => {
  for (const status of [401, 429]) {
    let state: State = empty()
    const runtime = owner()
    const prev = globalThis.fetch
    globalThis.fetch = mock(() => Promise.resolve(new Response(String(status), { status }))) as unknown as typeof fetch
    try {
      await dispatch({
        getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
        auths: [{ key: "github-copilot", label: "Primary", refresh: "root", access: "root", expires: 0 }],
        read: async () => state,
        write: async (next: State) => {
          state = next
        },
        premium: new Map(),
        runtime,
        request: "https://api.githubcopilot.com/chat/completions",
        init: { headers: {} },
        isVision: false,
        isAgent: false,
        modelId: "gpt-5-mini",
      })
      expect(runtime.pool).toEqual({})
    } finally {
      globalThis.fetch = prev
    }
  }
})

test("copilotRuntimeConfig reads provider options by default", () => {
  const prevLimit = process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
  const prevInterval = process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
  delete process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
  delete process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
  try {
    expect(
      copilotRuntimeConfig({
        provider: {
          "github-copilot": {
            options: {
              runtimeLimit: 3,
              runtimeMinIntervalMs: 250,
            },
          },
        },
      }),
    ).toEqual({ limit: 3, minIntervalMs: 250 })
  } finally {
    if (prevLimit === undefined) delete process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
    else process.env.OPENCODE_COPILOT_RUNTIME_LIMIT = prevLimit
    if (prevInterval === undefined) delete process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
    else process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS = prevInterval
  }
})

test("copilotRuntimeConfig prefers env overrides over config", () => {
  const prevLimit = process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
  const prevInterval = process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
  process.env.OPENCODE_COPILOT_RUNTIME_LIMIT = "5"
  process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS = "900"
  try {
    expect(
      copilotRuntimeConfig({
        provider: {
          "github-copilot": {
            options: {
              runtimeLimit: 3,
              runtimeMinIntervalMs: 250,
            },
          },
        },
      }),
    ).toEqual({ limit: 5, minIntervalMs: 900 })
  } finally {
    if (prevLimit === undefined) delete process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
    else process.env.OPENCODE_COPILOT_RUNTIME_LIMIT = prevLimit
    if (prevInterval === undefined) delete process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
    else process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS = prevInterval
  }
})

test("copilotRuntimeConfig normalizes invalid values", () => {
  const prevLimit = process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
  const prevInterval = process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
  process.env.OPENCODE_COPILOT_RUNTIME_LIMIT = "0"
  process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS = "-1"
  try {
    expect(copilotRuntimeConfig()).toEqual({ limit: 1, minIntervalMs: 0 })
  } finally {
    if (prevLimit === undefined) delete process.env.OPENCODE_COPILOT_RUNTIME_LIMIT
    else process.env.OPENCODE_COPILOT_RUNTIME_LIMIT = prevLimit
    if (prevInterval === undefined) delete process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS
    else process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS = prevInterval
  }
})

test("routeAccount runtime scoring prefers non-cooled account inside lane", () => {
  const now = 1_000
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": {
        plan: "enterprise",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
      "github-copilot#enterprise-b": {
        plan: "enterprise",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
    },
  }
  const runtime = owner(1, 500)
  runtime.last["github-copilot#enterprise-a"] = 800
  expect(routeAccount({ auths, state, modelId: "gpt-5-enterprise", fallback: auths[0], runtime, now }).key).toBe(
    "github-copilot#enterprise-b",
  )
})

test("runtime scoring prefers fresh discovery over stale discovery inside lane", () => {
  const now = Date.now()
  const state: State = {
    version: 1,
    connections: {
      a: { plan: "enterprise", discovery: { at: now - 31 * 60 * 1000, models: ["gpt-5-enterprise"], ok: true } },
      b: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
    },
  }
  expect(runtimeScore({ state, runtime: owner(), key: "a", modelId: "gpt-5-enterprise", now }).discovery).toBe(2)
  expect(runtimeScore({ state, runtime: owner(), key: "b", modelId: "gpt-5-enterprise", now }).discovery).toBe(3)
})

test("routeAccount runtime scoring prefers lower penalty inside lane", () => {
  const now = 1_000
  const auths: CopilotAuth[] = [
    { key: "github-copilot#enterprise-a", label: "enterprise-a", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#enterprise-b", label: "enterprise-b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot#enterprise-a": {
        plan: "enterprise",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
        exhaustedUntil: now - 5 * 60 * 1000,
      },
      "github-copilot#enterprise-b": {
        plan: "enterprise",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
      },
    },
  }
  const dirty = {
    ...state,
    connections: {
      ...state.connections,
      "github-copilot#enterprise-a": { ...state.connections["github-copilot#enterprise-a"], lastDiscoveryErrorAt: now },
    },
  }
  expect(
    routeAccount({ auths, state: dirty, modelId: "gpt-5-enterprise", fallback: auths[0], runtime: owner(), now }).key,
  ).toBe("github-copilot#enterprise-b")
})

test("runtimeScore exposes cooldown load discovery and penalty together", () => {
  const now = 1_000
  const state: State = {
    version: 1,
    connections: {
      a: {
        plan: "enterprise",
        discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
        lastDiscoveryErrorAt: now,
      },
    },
  }
  const runtime = owner(2, 500)
  runtime.pool = { a: 1 }
  runtime.last.a = 800
  expect(runtimeScore({ state, runtime, key: "a", modelId: "gpt-5-enterprise", now })).toEqual({
    discovery: 2,
    penalty: 1,
    recent429: false,
    recentDiscoveryError: true,
    load: 1,
    cooldown: true,
  })
})

test("routeDebug exposes runtime cooldown/load surface", () => {
  const now = 1_000
  const auths: CopilotAuth[] = [
    { key: "a", label: "a", refresh: "a", access: "a", expires: 0 },
    { key: "b", label: "b", refresh: "b", access: "b", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      a: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
      b: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
    },
  }
  const runtime = owner(2, 500)
  runtime.pool = { a: 1 }
  runtime.last.a = 900
  const item = routeDebug({ auths, state, modelId: "gpt-5-enterprise", runtime, now }).find((x) => x.key === "a")
  expect(item?.load).toBe(1)
  expect(item?.cooldown).toBe(true)
  expect(item?.routeReason).toContain("lane:enterprise")
  expect(item?.selected).toBe(true)
  expect(item?.rejectedReason).toEqual([])
})

test("autobestBatch simulates projected load across parallel picks", () => {
  const now = 1_000
  const auths: CopilotAuth[] = [
    { key: "a", label: "a", refresh: "a", access: "a", expires: 0 },
    { key: "b", label: "b", refresh: "b", access: "b", expires: 0 },
    { key: "c", label: "c", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      a: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
      b: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
      c: { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
    },
  }
  expect(autobestBatch({ auths, state, modelId: "gpt-5-enterprise", runtime: owner(2, 0), count: 4, now })).toEqual([
    "a",
    "b",
    "c",
    "a",
  ])
})

test("autobestBatch preserves lane and discovery priority before projected load", () => {
  const now = 1_000
  const auths: CopilotAuth[] = [
    { key: "free", label: "free", refresh: "a", access: "a", expires: 0 },
    { key: "ent-a", label: "ent-a", refresh: "b", access: "b", expires: 0 },
    { key: "ent-b", label: "ent-b", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      free: { plan: "free", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
      "ent-a": { plan: "enterprise", discovery: { at: now - 31 * 60 * 1000, models: ["gpt-5-enterprise"], ok: true } },
      "ent-b": { plan: "enterprise", discovery: { at: now, models: ["gpt-5-enterprise"], ok: true } },
    },
  }
  expect(autobestBatch({ auths, state, modelId: "gpt-5-enterprise", runtime: owner(2, 0), count: 3, now })).toEqual([
    "ent-a",
    "ent-b",
    "ent-a",
  ])
})

test("dispatch uses autobest batch reservation path before request dispatch", async () => {
  const runtime = owner(1, 0)
  let state: State = {
    version: 1,
    connections: {
      a: { plan: "enterprise", discovery: { at: 1_000, models: ["gpt-5-enterprise"], ok: true } },
      b: { plan: "enterprise", discovery: { at: 1_000, models: ["gpt-5-enterprise"], ok: true } },
    },
  }
  const auths: CopilotAuth[] = [
    { key: "a", label: "a", refresh: "ra", access: "ra", expires: 0 },
    { key: "b", label: "b", refresh: "rb", access: "rb", expires: 0 },
  ]
  let gate!: () => void
  let sync!: () => void
  const wait = new Promise<void>((resolve) => {
    gate = resolve
  })
  const ready = new Promise<void>((resolve) => {
    sync = resolve
  })
  const prev = globalThis.fetch
  globalThis.fetch = mock((url, init) => {
    if (String(url).includes("/copilot_internal/user")) {
      return Promise.resolve(new Response(JSON.stringify({ user_login: "a", access_type_sku: "enterprise" }), { status: 200 }))
    }
    sync()
    return wait.then(() => new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  try {
    const run = dispatch({
      getAuth: async () => ({ type: "oauth", refresh: "root", access: "root", expires: 0 }),
      auths,
      read: async () => state,
      write: async (next: State) => {
        state = next
      },
      premium: new Map(),
      runtime,
      request: "https://api.githubcopilot.com/chat/completions",
      init: { method: "POST", headers: {}, body: JSON.stringify({ model: "gpt-5-enterprise" }) },
      isVision: false,
      isAgent: false,
      modelId: "gpt-5-enterprise",
    })
    await ready
    expect(runtime.pool).toEqual({ a: 1 })
    gate()
    await run
    expect(runtime.pool).toEqual({})
  } finally {
    globalThis.fetch = prev
  }
})

test("CopilotRuntimeState exposes shared runtime usage", () => {
  const runtime = owner(2, 0)
  runtime.pool = { "github-copilot": 2, "github-copilot#enterprise": 1 }
  runtime.last = { "github-copilot": 100 }
  CopilotRuntimeState.current = runtime
  expect(CopilotRuntimeState.usage()).toEqual([
    { key: "github-copilot", load: 2, last: 100 },
    { key: "github-copilot#enterprise", load: 1, last: null },
  ])
  expect(CopilotRuntimeState.feed()).toEqual([])
})


test("legacy credential parser maps github copilot credential json", () => {
  expect(
    legacy({
      "github.com": { token: "tok-main", user: "alice" },
      enterprise: { token: "tok-ent", plan: "enterprise", enterprise_uri: "https://ghe.example.com" },
      edu: { access_token: "tok-edu", refresh_token: "tok-edu", plan: "edu", login: "student" },
    }).map((item) => ({ key: item.key, label: item.label, enterpriseUrl: item.enterpriseUrl })),
  ).toEqual([
    { key: "github-copilot", label: "alice", enterpriseUrl: undefined },
    { key: "github-copilot#enterprise", label: "enterprise", enterpriseUrl: "https://ghe.example.com" },
    { key: "github-copilot#edu", label: "student", enterpriseUrl: undefined },
  ])
})


test("migration marker state roundtrips with empty default", async () => {
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const mark = yield* readMigration()
      return mark
    }).pipe(Effect.provide(Auth.defaultLayer), Effect.provide(AppFileSystem.defaultLayer)),
  )
  expect(out).toEqual({ version: 1, keys: [] })
})

test("migration e2e migrates legacy credentials into empty auth store with injected io", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-copilot-migrate-"))
  const legacyPath = `${dir}/legacy-credential.json`
  const markerPath = `${dir}/marker.json`
  await Bun.write(legacyPath, JSON.stringify({
    "github.com": { token: "tok-main", user: "alice" },
    enterprise: { token: "tok-ent", plan: "enterprise", enterprise_uri: "https://ghe.example.com" },
  }))
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const src = {
        legacy: legacyPath,
        apps: legacyPath + ".apps",
        oauth: legacyPath + ".oauth",
        forge: legacyPath + ".forge",
        codedash: legacyPath + ".codedash",
        macOSAppSupport: legacyPath + ".macOSAppSupport",
        marker: markerPath,
        read(path: string) {
          return fs.readJson(path)
        },
        write(path: string, value: unknown) {
          return fs.writeJson(path, value, 0o600)
        },
      }
      const state = yield* migrate(src)
      const auth = yield* Auth.Service
      const all = yield* auth.all()
      const mark = yield* readMigration(src)
      return { state, all, mark }
    }).pipe(Effect.provide(Auth.defaultLayer), Effect.provide(AppFileSystem.defaultLayer)),
  )
  expect(Object.keys(out.all).filter((key) => key.startsWith("github-copilot"))).toEqual([
    "github-copilot",
    "github-copilot#enterprise",
  ])
  expect(out.state.keys).toEqual(["github-copilot", "github-copilot#enterprise"])
  expect(out.mark.keys).toEqual(["github-copilot", "github-copilot#enterprise"])
  expect(out.mark.source).toBe(legacyPath)
  expect(typeof out.mark.migratedAt).toBe("number")
})


test("summarizeMigration formats migrated and skipped outcomes", () => {
  expect(summarizeMigration({ version: 1, keys: ["github-copilot", "github-copilot#enterprise"], source: "/tmp/credential.json", migratedAt: 123 })).toEqual({
    migrated: 2,
    skipped: false,
    source: "/tmp/credential.json",
    migratedAt: 123,
    text: "migrated 2 legacy Copilot accounts",
  })
  expect(summarizeMigration({ version: 1, keys: [], skipped: true })).toEqual({
    migrated: 0,
    skipped: true,
    source: undefined,
    migratedAt: undefined,
    text: "skipped migration, new auth already existed",
  })
})
