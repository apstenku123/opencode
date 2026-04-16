import { afterEach, describe, expect, mock, test } from "bun:test"
import { classifyPlan, fetchQuota, formatQuotaBar, parse, premium } from "@/plugin/github-copilot/quota"

const orig = globalThis.fetch

afterEach(() => {
  globalThis.fetch = orig
})

describe("github-copilot quota", () => {
  test("premium parses premium request snapshot", () => {
    expect(
      premium({
        entitlements: { premium_requests: 300 },
        quota_snapshots: [{ quota_id: "premium_requests", remaining: 120, percent_remaining: 0.4 }],
      }),
    ).toEqual({ used: 180, total: 300, remaining: 120, percent: 0.4 })
  })

  test("parse extracts login, plan, sku and api base", () => {
    expect(
      parse({
        user_login: "octo",
        copilot_plan: "copilot_pro",
        access_type_sku: "copilot_edu",
        endpoints: { api: "https://api.individual.githubcopilot.com" },
        entitlements: { premium_requests: 100 },
        quota_snapshots: [{ quota_id: "premium_requests", remaining: 25, total: 100, reset_date: "2026-05-01" }],
      }),
    ).toEqual({
      login: "octo",
      plan: "copilot_pro",
      sku: "copilot_edu",
      api: "https://api.individual.githubcopilot.com",
      premium: { used: 75, total: 100, remaining: 25, percent: 0.25 },
      resetDate: "2026-05-01",
    })
  })

  test("formatQuotaBar renders compact quota bar", () => {
    expect(formatQuotaBar({ used: 80, total: 100, remaining: 20, percent: 0.2 }, "2026-05-01")).toContain("20/100 20%")
  })

  test("fetchQuota reads /copilot_internal/user", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            user_login: "octo",
            copilot_plan: "free",
            access_type_sku: "copilot_free",
            entitlements: { premium_requests: 50 },
            quota_snapshots: [{ quota_id: "premium_requests", remaining: 50, total: 50 }],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const out = await fetchQuota("tok")
    expect(out.login).toBe("octo")
    expect(out.sku).toBe("copilot_free")
    expect(out.plan).toBe("free")
  })

  test("fetchQuota throws on network status", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("nope", { status: 429 }))) as unknown as typeof fetch
    await expect(fetchQuota("tok")).rejects.toThrow("Failed to fetch quota: 429")
  })
})

test("classifyPlan derives edu enterprise free and unknown", () => {
  expect(classifyPlan({ plan: "edu", sku: undefined })).toBe("edu")
  expect(classifyPlan({ plan: "enterprise", sku: undefined })).toBe("enterprise")
  expect(classifyPlan({ plan: undefined, sku: "free_tier" })).toBe("free")
  expect(classifyPlan({ plan: undefined, sku: undefined })).toBe("unknown")
})

test("fetchQuota routes through proxy and forwards proxy token header", async () => {
  const prev = globalThis.fetch
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = mock((url, init) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
    return Promise.resolve(new Response(JSON.stringify({ user_login: "alice" }), { status: 200 }))
  }) as unknown as typeof fetch
  try {
    await fetchQuota("tok", undefined, { url: "https://gcp-proxy.example", token: "ptok" })
    expect(calls[0]?.url).toBe("https://gcp-proxy.example/copilot_internal/user")
    expect(calls[0]?.headers["x-copilot-proxy-token"]).toBe("ptok")
  } finally {
    globalThis.fetch = prev
  }
})
