import * as prompts from "@clack/prompts"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  accountStatus,
  ACCOUNT_STATUS_SCHEMA_VERSION,
  emptyDiscovery,
  jsonMigration,
  jsonStatus,
  loadAccountHealth,
  ProvidersAccountsCommand,
  ProvidersListCommand,
  ProvidersQuotaCommand,
  ProvidersRouteDebugCommand,
  renderAccountStatus,
  renderBestPerVendor,
  applyProxy,
  copilotAliasLabel,
  copilotAliasName,
  proxyList,
  quotaAccounts,
  saveProxy,
} from "@/cli/cmd/providers"
import { connectionFile } from "@/plugin/github-copilot/paths"
import { Auth } from "@/auth"
import * as providersCmd from "@/cli/cmd/providers"
import { empty } from "@/plugin/github-copilot/connections"
import { readFile, rm } from "node:fs/promises"

// Disable the live `/models` discovery probe in unit tests. Without this,
// the providers command tries to reach `api.githubcopilot.com/models`
// against the mocked fetch, fails, and mutates the asserted state
// (health → discovery_error, penalty → 1, routeReason populated).
process.env.OPENCODE_PROBE_DISCOVERY = "0"

afterEach(async () => {
  await rm(connectionFile, { force: true }).catch(() => undefined)
})

async function seedState(connections: Record<string, object>) {
  await Bun.write(connectionFile, JSON.stringify({ version: 1, connections }))
}

async function withAuth<T>(creds: Record<string, Auth.Info>, run: () => Promise<T>) {
  const spy = spyOn(providersCmd, "allAuth").mockResolvedValue(creds)
  try {
    return await run()
  } finally {
    spy.mockRestore()
  }
}

describe("quotaAccounts", () => {
  test("filters github-copilot oauth accounts", () => {
    expect(
      quotaAccounts({
        anthropic: { type: "api" },
        "github-copilot": { type: "oauth", refresh: "a" },
        "github-copilot#work": { type: "oauth", refresh: "b" },
        "github-copilot#skip": { type: "api" },
      }),
    ).toEqual([
      ["github-copilot", { type: "oauth", refresh: "a" }],
      ["github-copilot#work", { type: "oauth", refresh: "b" }],
    ])
  })
})

test("renders friendly labels for copilot aliases", () => {
  expect(copilotAliasLabel("github-copilot")).toBe("Primary")
  expect(copilotAliasLabel("github-copilot#edu")).toBe("Copilot Edu")
  expect(copilotAliasLabel("github-copilot#enterprise")).toBe("Copilot Enterprise")
  expect(copilotAliasLabel("github-copilot#personal")).toBe("Copilot Personal")
  expect(copilotAliasLabel("github-copilot#free")).toBe("Copilot Free")
})

test("applyProxy stores per-account proxy config", () => {
  expect(
    applyProxy({ version: 1, connections: {} }, "github-copilot#edu", {
      proxyUrl: "https://gcp-proxy.example",
      proxyToken: "tok",
    }),
  ).toEqual({
    version: 1,
    connections: {
      "github-copilot#edu": { proxyUrl: "https://gcp-proxy.example", proxyToken: "tok" },
    },
  })
})

test("saveProxy persists proxy config in copilot connections store", async () => {
  await saveProxy("github-copilot#edu", "https://gcp-proxy.example", "ptok")
  const raw = JSON.parse(await readFile(connectionFile, "utf8"))
  expect(raw.connections["github-copilot#edu"]).toEqual({
    proxyUrl: "https://gcp-proxy.example",
    proxyToken: "ptok",
  })
})

test("saveProxy clears proxy config when values are empty", async () => {
  await saveProxy("github-copilot#edu", "https://gcp-proxy.example", "ptok")
  await saveProxy("github-copilot#edu", undefined, undefined)
  const raw = JSON.parse(await readFile(connectionFile, "utf8"))
  expect(raw.connections["github-copilot#edu"]).toEqual({})
})

test("renders friendly names for alias presentation", () => {
  expect(copilotAliasName("github-copilot", "GitHub Copilot")).toBe("GitHub Copilot")
  expect(copilotAliasName("github-copilot#edu", "GitHub Copilot")).toBe("Copilot Edu")
  expect(copilotAliasName("github-copilot#enterprise", "GitHub Copilot")).toBe("Copilot Enterprise")
})

test("proxyList returns per-account proxy overview", () => {
  expect(
    proxyList(
      {
        version: 1,
        connections: {
          "github-copilot": {},
          "github-copilot#edu": { proxyUrl: "https://gcp.example", proxyToken: "tok" },
        },
      },
      [
        ["github-copilot", { type: "oauth" }],
        ["github-copilot#edu", { type: "oauth" }],
      ],
    ),
  ).toEqual([
    { key: "github-copilot", label: "Primary", url: undefined, token: undefined },
    { key: "github-copilot#edu", label: "Copilot Edu", url: "https://gcp.example", token: "tok" },
  ])
})

test("proxyList reflects persisted proxy after saveProxy", async () => {
  await saveProxy("github-copilot#edu", "https://gcp.example", "ptok")
  const raw = JSON.parse(await readFile(connectionFile, "utf8"))
  const out = proxyList(raw, [["github-copilot#edu", { type: "oauth" }]])
  expect(out[0]).toEqual({
    key: "github-copilot#edu",
    label: "Copilot Edu",
    url: "https://gcp.example",
    token: "ptok",
  })
})

test("builds ok account status from persisted connection data", () => {
  expect(
    accountStatus({
      key: "github-copilot#edu",
      now: 100,
      state: {
        version: 1,
        connections: { "github-copilot#edu": { login: "student", plan: "edu", proxyUrl: "https://gcp.example" } },
      },
    }),
  ).toMatchObject({
    key: "github-copilot#edu",
    label: "Copilot Edu",
    login: "student",
    plan: "edu",
    proxy: true,
    exhausted: false,
    health: "ok",
  })
})

test("marks account exhausted from future cooldown", () => {
  expect(
    accountStatus({
      key: "github-copilot",
      now: 100,
      state: { version: 1, connections: { "github-copilot": { exhaustedUntil: 150 } } },
    }),
  ).toMatchObject({ exhausted: true, exhaustedUntil: 150, health: "exhausted" })
})

test("prefers fetched quota login and classified plan", () => {
  expect(
    accountStatus({
      key: "github-copilot",
      state: { version: 1, connections: { "github-copilot": { login: "old", plan: "free" } } },
      quota: { login: "octo", sku: "copilot_edu" },
    }),
  ).toMatchObject({ login: "octo", plan: "edu", health: "ok" })
})

test("marks quota errors on account status", () => {
  expect(
    accountStatus({
      key: "github-copilot",
      state: { version: 1, connections: { "github-copilot": {} } },
      quotaError: "Failed to fetch quota: 429",
    }),
  ).toMatchObject({ health: "quota_error", error: "Failed to fetch quota: 429" })
})

test("marks discovery errors on account status", () => {
  expect(
    accountStatus({
      key: "github-copilot",
      now: 100,
      state: {
        version: 1,
        connections: {
          "github-copilot": {
            discovery: { at: 100, models: [], ok: false, err: "boom" },
          },
        },
      },
    }),
  ).toMatchObject({ health: "discovery_error", error: "boom", discovery: { ok: false, stale: false, err: "boom" } })
})

test("marks stale discovery on account status", () => {
  expect(
    accountStatus({
      key: "github-copilot",
      now: 100 + 31 * 60 * 1000,
      state: {
        version: 1,
        connections: {
          "github-copilot": {
            discovery: { at: 100, models: ["gpt-4.1"], ok: true },
          },
        },
      },
    }),
  ).toMatchObject({ health: "ok", discovery: { ok: true, stale: true, models: ["gpt-4.1"] } })
})

test("renderAccountStatus formats premium and discovery info", () => {
  expect(
    renderAccountStatus(
      accountStatus({
        key: "github-copilot#edu",
        now: 100,
        state: {
          version: 1,
          connections: {
            "github-copilot#edu": {
              login: "student",
              plan: "edu",
              proxyUrl: "https://gcp.example",
              discovery: { at: 100, models: ["gpt-4.1"], ok: true },
            },
          },
        },
      }),
      { premium: "[##--------] 20/100 20%", enterpriseUrl: "ghe.example.com" },
    ),
  ).toContain("Discovery: ok, 1 picker-enabled model")
})

test("jsonStatus emits stable nullable schema", () => {
  const status = jsonStatus(accountStatus({ key: "github-copilot", state: empty() }))
  expect(status).toEqual({
    key: "github-copilot",
    label: "Primary",
    login: null,
    plan: null,
    pool: null,
    proxy: false,
    proxyUrl: null,
    envelope: null,
    machineId: null,
    allowedProdModels: [],
    allowedTestModels: [],
    premium: null,
    health: "ok",
    exhausted: false,
    exhaustedUntil: null,
    quota: null,
    error: null,
    ghe: null,
    penalties: {
      recent429: false,
      recentDiscoveryError: false,
    },
    route: {
      discovery: 0,
      penalty: 0,
      load: 0,
      cooldown: false,
      routeReason: [],
    },
    discovery: {
      ok: null,
      stale: true,
      at: null,
      models: [],
      api: null,
      plan: null,
      login: null,
      err: null,
    },
  })
  expect(status.discovery).toEqual(emptyDiscovery())
})

test("accountStatus/jsonStatus expose penalties and route debug", () => {
  const now = Date.now()
  const status = jsonStatus(
    accountStatus({
      key: "github-copilot#enterprise",
      modelId: "gpt-5-enterprise",
      now,
      state: {
        version: 1,
        connections: {
          "github-copilot#enterprise": {
            plan: "enterprise",
            lastDiscoveryErrorAt: now - 100,
            discovery: { at: now, models: ["gpt-5-enterprise"], ok: true },
          },
        },
      },
    }),
  )
  expect(status.penalties).toEqual({ recent429: false, recentDiscoveryError: true })
  expect(status.route.load).toBe(0)
  expect(status.route.cooldown).toBe(false)
  expect(status.route).toEqual({
    discovery: 3,
    penalty: 1,
    load: 0,
    cooldown: false,
    routeReason: ["lane:enterprise", "discovery:3", "penalty:recentDiscoveryError"],
  })
})

test("ProvidersRouteDebugCommand emits json candidate list", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      {
        "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
        "github-copilot#free": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({ model: "gpt-5-enterprise", json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(data.schemaVersion).toBe(ACCOUNT_STATUS_SCHEMA_VERSION)
    expect(data.model).toBe("gpt-5-enterprise")
    expect(Array.isArray(data.candidates)).toBe(true)
  } finally {
    process.stdout.write = prevWrite
  }
})

test("ProvidersRouteDebugCommand supports account filter in json mode", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      {
        "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
        "github-copilot#free": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({
          model: "gpt-5-enterprise",
          account: "github-copilot#free",
          json: true,
        } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(data.account).toBe("github-copilot#free")
    expect(data.candidates.every((x: any) => x.key === "github-copilot#free")).toBe(true)
  } finally {
    process.stdout.write = prevWrite
  }
})

test("ProvidersRouteDebugCommand supports all-models in json mode", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      {
        "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({ allModels: true, json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(data.schemaVersion).toBe(ACCOUNT_STATUS_SCHEMA_VERSION)
    expect(Array.isArray(data.models)).toBe(true)
    expect(data.models.length).toBeGreaterThan(1)
  } finally {
    process.stdout.write = prevWrite
  }
})

test("ProvidersRouteDebugCommand supports all-accounts with all-models in json mode", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await seedState({ "github-copilot#enterprise": {}, "github-copilot#free": {} })
    await withAuth(
      {
        "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
        "github-copilot#free": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({ allModels: true, allAccounts: true, json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(Array.isArray(data.models)).toBe(true)
    expect(data.models.every((x: any) => Array.isArray(x.candidates))).toBe(true)
    expect(data.models.length).toBeGreaterThan(1)
  } finally {
    process.stdout.write = prevWrite
  }
})

test("ProvidersRouteDebugCommand all-models json exposes summary and provider path", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      {
        "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
        "github-copilot#free": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({
          provider: "github-copilot#enterprise",
          allModels: true,
          json: true,
        } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(typeof data.summary.selectedCount).toBe("number")
    expect(data.summary.selectedCount).toBeGreaterThanOrEqual(0)
    expect(typeof data.summary.modelCount).toBe("number")
    expect(typeof data.summary.selectedRate).toBe("number")
    expect(typeof data.summary.byAccount).toBe("object")
    expect(typeof data.summary.byProviderAlias).toBe("object")
    expect(["string", "object"]).toContain(typeof data.summary.topWinner)
    expect(typeof data.summary.topWinRate).toBe("number")
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
    expect(typeof data.summary.byProviderAlias).toBe("object")
    expect(["string", "object"]).toContain(typeof data.summary.topWinner)
    expect(typeof data.summary.topWinRate).toBe("number")
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
    expect(typeof data.summary.rejectedByLane).toBe("number")
    expect(typeof data.summary.rejectedByPenalty).toBe("number")
    expect(typeof data.summary.rejectedByDiscovery).toBe("number")
    expect(typeof data.summary.wins).toBe("object")
    expect(typeof data.summary.winRate).toBe("object")
    expect(typeof data.summary.byModel).toBe("object")
    expect(data.models.every((x: any) => x.providerID === "github-copilot#enterprise")).toBe(true)
  } finally {
    process.stdout.write = prevWrite
  }
})

test("ProvidersRouteDebugCommand supports summary-only json mode", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      {
        "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
        "github-copilot#free": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({
          provider: "github-copilot#enterprise",
          allModels: true,
          summaryOnly: true,
          json: true,
        } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(data.schemaVersion).toBe(ACCOUNT_STATUS_SCHEMA_VERSION)
    expect(data.models).toBeUndefined()
    expect(data.summary).toBeTruthy()
    expect(typeof data.summary.modelCount).toBe("number")
    expect(typeof data.summary.selectedRate).toBe("number")
    expect(typeof data.summary.byAccount).toBe("object")
    expect(typeof data.summary.byProviderAlias).toBe("object")
    expect(["string", "object"]).toContain(typeof data.summary.topWinner)
    expect(typeof data.summary.topWinRate).toBe("number")
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
    expect(typeof data.summary.rejectedByPenalty).toBe("number")
    expect(typeof data.summary.rejectedByDiscovery).toBe("number")
    expect(typeof data.summary.byModel).toBe("object")
  } finally {
    process.stdout.write = prevWrite
  }
})

test("route summary exposes selectedRate, winRate and byModel aggregates", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      { "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }) },
      async () => {
        await ProvidersRouteDebugCommand.handler({ allModels: true, summaryOnly: true, json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(typeof data.summary.modelCount).toBe("number")
    expect(typeof data.summary.selectedRate).toBe("number")
    expect(typeof data.summary.winRate).toBe("object")
    expect(typeof data.summary.byAccount).toBe("object")
    expect(typeof data.summary.byProviderAlias).toBe("object")
    expect(["string", "object"]).toContain(typeof data.summary.topWinner)
    expect(typeof data.summary.topWinRate).toBe("number")
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
    expect(typeof data.summary.byModel).toBe("object")
    const keys = Object.keys(data.summary.byModel)
    expect(keys.length).toBeGreaterThan(1)
    expect(data.summary.byModel[keys[0]].selected).not.toBeUndefined()
  } finally {
    process.stdout.write = prevWrite
  }
})

test("route summary exposes byAccount and modelCount", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      { "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }) },
      async () => {
        await ProvidersRouteDebugCommand.handler({ allModels: true, summaryOnly: true, json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(typeof data.summary.modelCount).toBe("number")
    expect(data.summary.modelCount).toBeGreaterThan(1)
    expect(typeof data.summary.byAccount).toBe("object")
  } finally {
    process.stdout.write = prevWrite
  }
})

test("route summary exposes byProviderAlias and top winner fields", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      { "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }) },
      async () => {
        await ProvidersRouteDebugCommand.handler({ allModels: true, summaryOnly: true, json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(typeof data.summary.byProviderAlias).toBe("object")
    expect(["string", "object"]).toContain(typeof data.summary.topWinner)
    expect(typeof data.summary.topWinRate).toBe("number")
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
  } finally {
    process.stdout.write = prevWrite
  }
})

test("route summary exposes topLoser, rejectionRate and winnerReason", async () => {
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await withAuth(
      {
        "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
        "github-copilot#free": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersRouteDebugCommand.handler({ allModels: true, json: true } as never)
      },
    )
    const data = JSON.parse(out.join(""))
    expect(["string", "object"]).toContain(typeof data.summary.topLoser)
    expect(typeof data.summary.rejectionRate).toBe("number")
    const first = Object.keys(data.summary.byModel)[0]
    expect(Array.isArray(data.summary.byModel[first].winnerReason)).toBe(true)
  } finally {
    process.stdout.write = prevWrite
  }
})
test("ProvidersRouteDebugCommand text mode runs without error", async () => {
  await withAuth(
    { "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }) },
    async () => {
      await expect(ProvidersRouteDebugCommand.handler({ model: "gpt-5-mini" } as never)).resolves.toBeUndefined()
    },
  )
})
test("ProvidersQuotaCommand emits json account overview", async () => {
  const prevFetch = globalThis.fetch
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "alice", access_type_sku: "copilot_free" }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  }) as unknown as typeof fetch
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await seedState({ "github-copilot": {} })
    await withAuth(
      {
        "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "tok", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersQuotaCommand.handler({ json: true } as never)
      },
    )
    const raw = out.join("")
    const body = raw.slice(raw.indexOf("{"))
    expect(body).toBeTruthy()
    const data = JSON.parse(body!)
    expect(data.schemaVersion).toBe(ACCOUNT_STATUS_SCHEMA_VERSION)
    expect(data.migration).toEqual({
      migrated: 0,
      skipped: true,
      source: null,
      migratedAt: null,
      text: "skipped migration, new auth already existed",
    })
    expect(data.items).toHaveLength(1)
    expect(data.items[0].schemaVersion).toBe(ACCOUNT_STATUS_SCHEMA_VERSION)
    expect(data.items[0].status).toEqual({
      key: "github-copilot",
      label: "Primary",
      login: "alice",
      plan: "free",
      pool: "edu",
      proxy: false,
      proxyUrl: null,
      envelope: null,
      machineId: null,
      allowedProdModels: ["codex-5.3-xhigh"],
      allowedTestModels: ["gpt-4.1", "gpt-5-mini-xhigh"],
      premium: null,
      health: "ok",
      exhausted: false,
      exhaustedUntil: null,
      quota: {
        login: "alice",
        sku: "copilot_free",
      },
      error: null,
      ghe: null,
      penalties: {
        recent429: false,
        recentDiscoveryError: false,
      },
      route: {
        discovery: 0,
        penalty: 0,
        load: 0,
        cooldown: false,
        routeReason: [],
      },
      discovery: {
        ok: null,
        stale: true,
        at: null,
        models: [],
        api: null,
        plan: null,
        login: null,
        err: null,
      },
    })
  } finally {
    globalThis.fetch = prevFetch
    process.stdout.write = prevWrite
  }
})

test("ProvidersAccountsCommand emits json account overview", async () => {
  const prevFetch = globalThis.fetch
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: "student", access_type_sku: "copilot_edu" }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  }) as unknown as typeof fetch
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await seedState({ "github-copilot#edu": {} })
    await withAuth(
      {
        "github-copilot#edu": new Auth.Oauth({ type: "oauth", refresh: "tok", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersAccountsCommand.handler({ json: true } as never)
      },
    )
    const raw = out.join("")
    const body = raw.slice(raw.indexOf("{"))
    expect(body).toBeTruthy()
    const data = JSON.parse(body!)
    expect(data.schemaVersion).toBe(ACCOUNT_STATUS_SCHEMA_VERSION)
    expect(data.migration).toEqual({
      migrated: 0,
      skipped: true,
      source: null,
      migratedAt: null,
      text: "skipped migration, new auth already existed",
    })
    expect(data.items).toHaveLength(1)
    expect(data.items[0].status).toEqual({
      key: "github-copilot#edu",
      label: "Copilot Edu",
      login: "student",
      plan: "edu",
      pool: "edu",
      proxy: false,
      proxyUrl: null,
      envelope: null,
      machineId: null,
      allowedProdModels: ["codex-5.3-xhigh"],
      allowedTestModels: ["gpt-4.1", "gpt-5-mini-xhigh"],
      premium: null,
      health: "ok",
      exhausted: false,
      exhaustedUntil: null,
      quota: {
        login: "student",
        sku: "copilot_edu",
      },
      error: null,
      ghe: null,
      penalties: {
        recent429: false,
        recentDiscoveryError: false,
      },
      route: {
        discovery: 0,
        penalty: 0,
        load: 0,
        cooldown: false,
        routeReason: [],
      },
      discovery: {
        ok: null,
        stale: true,
        at: null,
        models: [],
        api: null,
        plan: null,
        login: null,
        err: null,
      },
    })
  } finally {
    globalThis.fetch = prevFetch
    process.stdout.write = prevWrite
  }
})


test("jsonMigration emits stable nullable schema", () => {
  expect(jsonMigration({ migrated: 2, skipped: false, source: "/tmp/credential.json", migratedAt: 123, text: "migrated 2 legacy Copilot accounts" })).toEqual({
    migrated: 2,
    skipped: false,
    source: "/tmp/credential.json",
    migratedAt: 123,
    text: "migrated 2 legacy Copilot accounts",
  })
  expect(jsonMigration({ migrated: 0, skipped: true, source: undefined, migratedAt: undefined, text: "skipped migration, new auth already existed" })).toEqual({
    migrated: 0,
    skipped: true,
    source: null,
    migratedAt: null,
    text: "skipped migration, new auth already existed",
  })
})

describe("renderBestPerVendor", () => {
  test("returns one display line per account whose discovery snapshot has models", async () => {
    await seedState({
      "github-copilot": {
        discovery: {
          at: Date.now(),
          models: ["gpt-5.4", "claude-opus-4.6", "gemini-3.1-pro-preview"],
          ok: true,
        },
      },
      "github-copilot#cold": {},
    })
    const state = JSON.parse(await readFile(connectionFile, "utf8"))
    const lines = renderBestPerVendor(state)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("Primary")
    expect(lines[0]).toContain("OpenAI=gpt-5.4")
    expect(lines[0]).toContain("Anthropic=claude-opus-4.6")
    expect(lines[0]).toContain("Google=gemini-3.1-pro-preview")
  })

  test("skips accounts with no discovery models", () => {
    const state = { version: 1 as const, connections: { "github-copilot": {} } }
    expect(renderBestPerVendor(state)).toEqual([])
  })
})

test("loadAccountHealth triages each Copilot account", async () => {
  const prevFetch = globalThis.fetch
  let n = 0
  globalThis.fetch = ((url: string) => {
    n += 1
    if (n === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user_login: "alice",
            entitlements: { premium_requests: 100 },
            quota_snapshots: [{ quota_id: "premium_requests", remaining: 25, percent_remaining: 25 }],
          }),
          { status: 200 },
        ),
      )
    }
    return Promise.resolve(new Response("nope", { status: 401 }))
  }) as unknown as typeof fetch
  try {
    await seedState({})
    await withAuth(
      {
        "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "tok-a", access: "", expires: 0 }),
        "github-copilot#dead": new Auth.Oauth({ type: "oauth", refresh: "tok-b", access: "", expires: 0 }),
      },
      async () => {
        const got = await loadAccountHealth()
        expect(got).toHaveLength(2)
        const byKey = Object.fromEntries(got.map((g) => [g.key, g]))
        expect(byKey["github-copilot"].health).toBe("healthy")
        expect(byKey["github-copilot"].login).toBe("alice")
        expect(byKey["github-copilot#dead"].health).toBe("deactivated")
      },
    )
  } finally {
    globalThis.fetch = prevFetch
  }
})

test("ProvidersAccountsCommand --json includes health triage and bestPerVendor", async () => {
  const prevFetch = globalThis.fetch
  const prevWrite = process.stdout.write
  const out: Array<string | Uint8Array> = []
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("copilot_internal/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user_login: "alice",
            access_type_sku: "copilot_free",
            entitlements: { premium_requests: 100 },
            quota_snapshots: [{ quota_id: "premium_requests", remaining: 50, percent_remaining: 50 }],
          }),
          { status: 200 },
        ),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  }) as unknown as typeof fetch
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as never
  try {
    await seedState({
      "github-copilot": {
        discovery: { at: Date.now(), models: ["gpt-5.4", "claude-opus-4.6"], ok: true },
      },
    })
    await withAuth(
      {
        "github-copilot": new Auth.Oauth({ type: "oauth", refresh: "tok", access: "", expires: 0 }),
      },
      async () => {
        await ProvidersAccountsCommand.handler({ json: true } as never)
      },
    )
    const raw = out.join("")
    const body = raw.slice(raw.indexOf("{"))
    const data = JSON.parse(body)
    expect(Array.isArray(data.health)).toBe(true)
    expect(data.health[0].health).toBe("healthy")
    expect(data.bestPerVendor["github-copilot"]).toEqual([
      { vendor: "OpenAI", modelId: "gpt-5.4" },
      { vendor: "Anthropic", modelId: "claude-opus-4.6" },
    ])
    expect(data.items[0].triage.health).toBe("healthy")
  } finally {
    globalThis.fetch = prevFetch
    process.stdout.write = prevWrite
  }
})

// Integration coverage of ProvidersListCommand requires the AppRuntime
// + Instance services to be active (ModelsDev.get hits a Service.use).
// We exercise the new behaviour via `renderBestPerVendor` above.
void ProvidersListCommand
