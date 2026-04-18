import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  checkAccountStatus,
  checkAccountStatuses,
  classifyHealthError,
  type AccountStatusInfo,
} from "@/plugin/github-copilot/health"
import { empty, mark, markDeactivated, upsert, type State } from "@/plugin/github-copilot/connections"
import type { CopilotAuth } from "@/plugin/github-copilot/auth"

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

const auth = (key: string, refresh = "tok"): CopilotAuth => ({
  key,
  label: key,
  refresh,
  access: refresh,
  expires: 0,
})

describe("classifyHealthError", () => {
  test("401 / 403 → deactivated", () => {
    expect(classifyHealthError(new Error("Failed to fetch quota: 401")).health).toBe("deactivated")
    expect(classifyHealthError(new Error("Failed to fetch quota: 403")).health).toBe("deactivated")
  })
  test("429 → rateLimited", () => {
    expect(classifyHealthError(new Error("Failed to fetch quota: 429")).health).toBe("rateLimited")
  })
  test("5xx → networkError", () => {
    expect(classifyHealthError(new Error("Failed to fetch quota: 503")).health).toBe("networkError")
  })
  test("non-status string error → networkError", () => {
    expect(classifyHealthError(new Error("ENOTFOUND github.com")).health).toBe("networkError")
  })
  test("non-Error value → networkError fallback reason", () => {
    const got = classifyHealthError(null)
    expect(got.health).toBe("networkError")
    expect(got.reason).toContain("network error")
  })
})

describe("checkAccountStatus single account", () => {
  test("healthy when quota returns premium > 0", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            user_login: "alice",
            copilot_plan: "enterprise",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 100,
                remaining: 50,
                percent_remaining: 50,
              },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state: empty() })
    expect(got.health).toBe("healthy")
    expect(got.login).toBe("alice")
    expect(got.premium?.remaining).toBe(50)
  })

  test("rateLimited when premium remaining is 0", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            user_login: "bob",
            copilot_plan: "enterprise",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 100,
                remaining: 0,
                percent_remaining: 0,
              },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state: empty() })
    expect(got.health).toBe("rateLimited")
    expect(got.reason).toContain("0 premium")
  })

  test("uses cooldown without making a network call when exhaustedUntil > now", async () => {
    let called = false
    globalThis.fetch = mock(() => {
      called = true
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch
    const state = mark(empty(), "github-copilot", Date.now() + 10_000)
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state })
    expect(got.health).toBe("rateLimited")
    expect(got.reason).toBe("in cooldown")
    expect(called).toBe(false)
  })

  test("respects persisted deactivated flag without making a network call", async () => {
    let called = false
    globalThis.fetch = mock(() => {
      called = true
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch
    const state = markDeactivated(empty(), "github-copilot")
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state })
    expect(got.health).toBe("deactivated")
    expect(called).toBe(false)
  })

  test("classifies 401 from quota endpoint as deactivated", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state: empty() })
    expect(got.health).toBe("deactivated")
  })

  test("classifies 429 from quota endpoint as rateLimited", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("nope", { status: 429 }))) as unknown as typeof fetch
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state: empty() })
    expect(got.health).toBe("rateLimited")
  })

  test("classifies 5xx as networkError without poisoning the account", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("oops", { status: 503 }))) as unknown as typeof fetch
    const got = await checkAccountStatus({ auth: auth("github-copilot"), state: empty() })
    expect(got.health).toBe("networkError")
  })
})

describe("checkAccountStatuses multi-account", () => {
  test("returns one status per account in input order", async () => {
    let n = 0
    globalThis.fetch = mock(() => {
      n += 1
      // First account: 200 OK with quota; second: 401.
      if (n === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user_login: "primary",
              entitlements: { premium_requests: 50 },
              quota_snapshots: [{ quota_id: "premium_requests", remaining: 25, percent_remaining: 50 }],
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("nope", { status: 401 }))
    }) as unknown as typeof fetch
    const got: AccountStatusInfo[] = await checkAccountStatuses({
      auths: [auth("github-copilot"), auth("github-copilot#stale", "deadtok")],
      state: empty(),
    })
    expect(got).toHaveLength(2)
    expect(got[0].health).toBe("healthy")
    expect(got[0].login).toBe("primary")
    expect(got[1].health).toBe("deactivated")
  })

  test("uses persisted login when probe returns no user_login field", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            entitlements: { premium_requests: 100 },
            quota_snapshots: [{ quota_id: "premium_requests", remaining: 100, percent_remaining: 100 }],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    const state = upsert(empty(), "github-copilot#x", { login: "cached-login" })
    const got = await checkAccountStatuses({ auths: [auth("github-copilot#x")], state })
    expect(got[0].login).toBe("cached-login")
    expect(got[0].health).toBe("healthy")
  })
})

describe("checkAccountStatus uses per-account proxy when configured", () => {
  test("forwards proxy URL + token to fetchQuota", async () => {
    const calls: string[] = []
    globalThis.fetch = mock((url: any, init: any) => {
      calls.push(String(url))
      // Proxy header should be present
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers["x-copilot-proxy-token"]).toBe("ptok")
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "via-proxy" }), { status: 200 }),
      )
    }) as unknown as typeof fetch
    const state = upsert(empty(), "github-copilot#proxied", {
      proxyUrl: "https://gcp-proxy.example",
      proxyToken: "ptok",
    })
    const got = await checkAccountStatus({ auth: auth("github-copilot#proxied"), state })
    expect(calls[0]).toBe("https://gcp-proxy.example/copilot_internal/user")
    expect(got.health).toBe("healthy")
    expect(got.login).toBe("via-proxy")
  })
})
