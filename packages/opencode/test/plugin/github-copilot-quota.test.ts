import { afterEach, describe, expect, mock, test } from "bun:test"
import { classifyPlan, fetchQuota, formatQuotaBar, parse, premium } from "@/plugin/github-copilot/quota"

const orig = globalThis.fetch

afterEach(() => {
  globalThis.fetch = orig
})

describe("github-copilot quota", () => {
  test("premium parses premium_interactions snapshot (object keyed, not array)", () => {
    // Mirrors Rust `QuotaSnapshots { premium_interactions: QuotaSnapshot {...} }`
    expect(
      premium({
        quota_snapshots: {
          premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40, unlimited: false },
        },
      }),
    ).toEqual({ used: 180, total: 300, remaining: 120, percent: 0.4, unlimited: false })
  })

  test("premium recognises unlimited free plans", () => {
    expect(
      premium({
        quota_snapshots: {
          premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
        },
      }),
    ).toMatchObject({ unlimited: true })
  })

  test("parse extracts login, plan, sku, api base and quota_reset_date", () => {
    expect(
      parse({
        login: "octo",
        copilot_plan: "copilot_pro",
        access_type_sku: "copilot_edu",
        endpoints: { api: "https://api.individual.githubcopilot.com" },
        quota_reset_date: "2026-05-01",
        quota_snapshots: {
          premium_interactions: { entitlement: 100, remaining: 25, percent_remaining: 25, unlimited: false },
        },
      }),
    ).toEqual({
      login: "octo",
      plan: "copilot_pro",
      sku: "copilot_edu",
      api: "https://api.individual.githubcopilot.com",
      premium: { used: 75, total: 100, remaining: 25, percent: 0.25, unlimited: false },
      resetDate: "2026-05-01",
    })
  })

  test("parse accepts legacy user_login field as fallback", () => {
    expect(parse({ user_login: "octo" })).toMatchObject({ login: "octo" })
  })

  test("formatQuotaBar renders compact quota bar", () => {
    expect(formatQuotaBar({ used: 80, total: 100, remaining: 20, percent: 0.2, unlimited: false }, "2026-05-01")).toContain("20/100 20%")
  })

  test("fetchQuota reads /copilot_internal/user", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            login: "octo",
            copilot_plan: "free",
            access_type_sku: "copilot_free",
            quota_snapshots: {
              premium_interactions: { entitlement: 50, remaining: 50, percent_remaining: 100, unlimited: true },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const out = await fetchQuota("tok")
    expect(out.login).toBe("octo")
    expect(out.sku).toBe("copilot_free")
    expect(out.plan).toBe("free")
    expect(out.premium?.unlimited).toBe(true)
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

describe("fetchQuota dynamic endpoint + SKU (step 1 of discovery chain)", () => {
  test("parses endpoints.api and access_type_sku for downstream /models routing", async () => {
    const prev = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            login: "corp",
            copilot_plan: "enterprise",
            access_type_sku: "enterprise",
            endpoints: { api: "https://api.enterprise.githubcopilot.com" },
            quota_snapshots: {
              premium_interactions: { entitlement: 1500, remaining: 900, percent_remaining: 60, unlimited: false },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    try {
      const out = await fetchQuota("tok")
      // Downstream discovery uses quota.api as the dynamic /models base
      // and quota.sku as the `retain_for_plan` filter.
      expect(out.api).toBe("https://api.enterprise.githubcopilot.com")
      expect(out.sku).toBe("enterprise")
      expect(out.plan).toBe("enterprise")
      expect(out.premium?.total).toBe(1500)
    } finally {
      globalThis.fetch = prev
    }
  })

  test("omits api/sku when the server doesn't return them", async () => {
    const prev = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ user_login: "octo" }), { status: 200 })),
    ) as unknown as typeof fetch
    try {
      const out = await fetchQuota("tok")
      expect(out.api).toBeUndefined()
      expect(out.sku).toBeUndefined()
    } finally {
      globalThis.fetch = prev
    }
  })
})
