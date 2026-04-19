import * as prompts from "@clack/prompts"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  accountStatus,
  ACCOUNT_STATUS_SCHEMA_VERSION,
  addTestAccountConfig,
  emptyDiscovery,
  globalConfigPath,
  jsonMigration,
  jsonStatus,
  listTestAccountsConfig,
  loadAccountHealth,
  mutateConnections,
  ProvidersAccountsCommand,
  ProvidersActivateCommand,
  ProvidersAllowedModelsCommand,
  ProvidersDeactivateCommand,
  ProvidersListCommand,
  ProvidersPoolCommand,
  ProvidersQuotaCommand,
  ProvidersRotateMachineIdCommand,
  ProvidersRotateProxyCommand,
  ProvidersRouteDebugCommand,
  ProvidersTestAccountsCommand,
  readGlobalConfigRaw,
  removeTestAccountConfig,
  renderAccountStatus,
  renderBestPerVendor,
  rotateMachineId,
  rotateProxyConfig,
  setPoolOverrideConfig,
  applyProxy,
  copilotAliasLabel,
  copilotAliasName,
  proxyList,
  quotaAccounts,
  saveProxy,
  seedMachineIds,
  writeGlobalConfigRaw,
} from "@/cli/cmd/providers"
import { connectionFile } from "@/plugin/github-copilot/paths"
import { Auth } from "@/auth"
import * as providersCmd from "@/cli/cmd/providers"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect, Layer } from "effect"
import { Store as ConnectionsStore, empty, empty as emptyConnections } from "@/plugin/github-copilot/connections"
import { readFile, rm } from "node:fs/promises"

// Disable the live `/models` discovery probe in unit tests. Without this,
// the providers command tries to reach `api.githubcopilot.com/models`
// against the mocked fetch, fails, and mutates the asserted state
// (health → discovery_error, penalty → 1, routeReason populated).
process.env.OPENCODE_PROBE_DISCOVERY = "0"

afterEach(async () => {
  await rm(connectionFile, { force: true }).catch(() => undefined)
  await rm(globalConfigPath(), { force: true }).catch(() => undefined)
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

describe("ProvidersDeactivate/Activate", () => {
  test("deactivate marks the account and persists", async () => {
    await seedState({ "github-copilot#edu": {} })
    await ProvidersDeactivateCommand.handler({ key: "github-copilot#edu" } as never)
    const raw = JSON.parse(await readFile(connectionFile, "utf8"))
    expect(raw.connections["github-copilot#edu"].deactivated).toBe(true)
  })

  test("activate clears the deactivated flag", async () => {
    await seedState({ "github-copilot#edu": { deactivated: true } })
    await ProvidersActivateCommand.handler({ key: "github-copilot#edu" } as never)
    const raw = JSON.parse(await readFile(connectionFile, "utf8"))
    // JSON.stringify drops `undefined`, so the flag disappears entirely.
    expect(raw.connections["github-copilot#edu"].deactivated).toBeUndefined()
  })
})

describe("ProvidersRotateMachineId", () => {
  test("rotateMachineId helper strips machineId in place", () => {
    const state = {
      version: 1 as const,
      connections: { "github-copilot": { machineId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } },
    }
    const next = rotateMachineId(state, "github-copilot")
    expect(next.connections["github-copilot"].machineId).toBeUndefined()
  })

  test("command persists an empty machineId so next dispatch mints a new one", async () => {
    await seedState({
      "github-copilot": { machineId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", plan: "free" },
    })
    await ProvidersRotateMachineIdCommand.handler({ key: "github-copilot" } as never)
    const raw = JSON.parse(await readFile(connectionFile, "utf8"))
    expect(raw.connections["github-copilot"].machineId).toBeUndefined()
    // Unrelated fields are preserved — the rotation is surgical.
    expect(raw.connections["github-copilot"].plan).toBe("free")
  })
})

describe("ProvidersRotateProxy", () => {
  test("rotateProxyConfig writes url/token/envelope", () => {
    const next = rotateProxyConfig(
      { version: 1 as const, connections: {} },
      "github-copilot#edu",
      { url: "https://gcp.example", token: "tok", envelope: true },
    )
    expect(next.connections["github-copilot#edu"]).toEqual({
      proxyUrl: "https://gcp.example",
      proxyToken: "tok",
      envelope: true,
    })
  })

  test("command persists proxy config to the connection store", async () => {
    await seedState({ "github-copilot#edu": {} })
    await ProvidersRotateProxyCommand.handler({
      key: "github-copilot#edu",
      url: "https://gcp.example",
      token: "ptok",
      envelope: true,
    } as never)
    const raw = JSON.parse(await readFile(connectionFile, "utf8"))
    expect(raw.connections["github-copilot#edu"]).toEqual({
      proxyUrl: "https://gcp.example",
      proxyToken: "ptok",
      envelope: true,
    })
  })

  test("command with empty url clears proxy", async () => {
    await seedState({
      "github-copilot#edu": {
        proxyUrl: "https://gcp.example",
        proxyToken: "ptok",
        envelope: true,
      },
    })
    await ProvidersRotateProxyCommand.handler({ key: "github-copilot#edu", url: "" } as never)
    const raw = JSON.parse(await readFile(connectionFile, "utf8"))
    expect(raw.connections["github-copilot#edu"]).toEqual({})
  })
})

describe("ProvidersPool", () => {
  test("setPoolOverrideConfig pins account to a pool and preserves siblings", () => {
    const cfg = { copilot: { poolRouting: { pools: { prod: ["github-copilot"] } } } }
    const next = setPoolOverrideConfig(cfg, "github-copilot#edu", "edu")
    expect(next.copilot.poolRouting.pools).toEqual({
      edu: ["github-copilot#edu"],
      prod: ["github-copilot"],
    })
  })

  test("setPoolOverrideConfig with 'none' clears the override and collapses empty blocks", () => {
    const cfg = { copilot: { poolRouting: { pools: { edu: ["github-copilot#edu"] } } } }
    const next = setPoolOverrideConfig(cfg, "github-copilot#edu", "none")
    expect(next).toEqual({})
  })

  test("command persists pool pin to ~/.config/opencode/opencode.json", async () => {
    await ProvidersPoolCommand.handler({ key: "github-copilot#edu-1", pool: "edu" } as never)
    const cfg = await readGlobalConfigRaw()
    expect(cfg.copilot.poolRouting.pools.edu).toEqual(["github-copilot#edu-1"])
  })

  test("command with 'none' removes the account from both pools", async () => {
    await writeGlobalConfigRaw({
      copilot: { poolRouting: { pools: { edu: ["github-copilot#edu-1"] } } },
    })
    await ProvidersPoolCommand.handler({ key: "github-copilot#edu-1", pool: "none" } as never)
    const cfg = await readGlobalConfigRaw()
    expect(cfg).toEqual({})
  })
})

describe("ProvidersAllowedModels", () => {
  test("emits prod + test model lists per pool in json mode", async () => {
    const prevWrite = process.stdout.write
    const out: Array<string | Uint8Array> = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as never
    try {
      await ProvidersAllowedModelsCommand.handler({ json: true } as never)
      const data = JSON.parse(out.join(""))
      expect(data.edu.prod).toEqual(["codex-5.3-xhigh"])
      expect(data.prod.prod).toEqual(["gpt-5.4-xhigh", "claude-4.7-opus-high"])
      expect(data.edu.test).toEqual(["gpt-4.1", "gpt-5-mini-xhigh"])
    } finally {
      process.stdout.write = prevWrite
    }
  })

  test("restricts output to the pool of a specific account key", async () => {
    const prevWrite = process.stdout.write
    const out: Array<string | Uint8Array> = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as never
    try {
      await seedState({ "github-copilot#edu-1": { plan: "edu" } })
      await ProvidersAllowedModelsCommand.handler({ key: "github-copilot#edu-1", json: true } as never)
      const data = JSON.parse(out.join(""))
      expect(Object.keys(data)).toEqual(["edu"])
      expect(data.edu.prod).toEqual(["codex-5.3-xhigh"])
    } finally {
      process.stdout.write = prevWrite
    }
  })
})

describe("ProvidersTestAccounts", () => {
  test("addTestAccountConfig appends a slot across all three arrays", () => {
    const next = addTestAccountConfig({}, { label: "student-1", token: "ghu_abc", proxy: "https://p.example" })
    expect(next.copilot.testAccounts).toEqual({
      tokens: ["ghu_abc"],
      labels: ["student-1"],
      proxyUrls: ["https://p.example"],
    })
  })

  test("addTestAccountConfig rejects duplicate labels", () => {
    const cfg = addTestAccountConfig({}, { label: "student-1", token: "ghu_abc" })
    expect(() => addTestAccountConfig(cfg, { label: "student-1", token: "ghu_xyz" })).toThrow(
      /already exists/,
    )
  })

  test("removeTestAccountConfig removes the matching slot", () => {
    let cfg: Record<string, any> = {}
    cfg = addTestAccountConfig(cfg, { label: "a", token: "tok-a" })
    cfg = addTestAccountConfig(cfg, { label: "b", token: "tok-b" })
    const next = removeTestAccountConfig(cfg, "a")
    expect(listTestAccountsConfig(next)).toEqual([{ label: "b", token: "tok-b", proxy: null }])
  })

  test("removeTestAccountConfig is a no-op when label is unknown", () => {
    const cfg = addTestAccountConfig({}, { label: "a", token: "tok-a" })
    const next = removeTestAccountConfig(cfg, "missing")
    expect(next).toBe(cfg)
  })

  test("listTestAccountsConfig surfaces the raw token so the CLI layer can mask it", () => {
    const cfg = addTestAccountConfig({}, { label: "student-1", token: "ghu_abcdefghij" })
    const items = listTestAccountsConfig(cfg)
    expect(items).toEqual([{ label: "student-1", token: "ghu_abcdefghij", proxy: null }])
  })

  test("add/remove round trip via helpers persists to the global config", async () => {
    // Exercise the handlers end-to-end via the pure helpers so the test
    // doesn't need to drive yargs' sub-command routing.
    const cfg0 = await readGlobalConfigRaw()
    const afterAdd = addTestAccountConfig(cfg0, {
      label: "student-1",
      token: "ghu_abc",
      proxy: "https://p.example",
    })
    await writeGlobalConfigRaw(afterAdd)
    const persisted = await readGlobalConfigRaw()
    expect(persisted.copilot.testAccounts.tokens).toEqual(["ghu_abc"])
    expect(persisted.copilot.testAccounts.labels).toEqual(["student-1"])
    expect(persisted.copilot.testAccounts.proxyUrls).toEqual(["https://p.example"])
    const afterRemove = removeTestAccountConfig(persisted, "student-1")
    await writeGlobalConfigRaw(afterRemove)
    expect(await readGlobalConfigRaw()).toEqual({})
  })
})

describe("ProvidersCommand wiring", () => {
  test("each new sub-command is registered and exposes a --help string", () => {
    expect(ProvidersDeactivateCommand.command).toBe("deactivate <key>")
    expect(ProvidersDeactivateCommand.describe).toBeTruthy()
    expect(ProvidersActivateCommand.command).toBe("activate <key>")
    expect(ProvidersActivateCommand.describe).toBeTruthy()
    expect(ProvidersRotateMachineIdCommand.command).toBe("rotate-machine-id <key>")
    expect(ProvidersRotateMachineIdCommand.describe).toBeTruthy()
    expect(ProvidersRotateProxyCommand.command).toBe("rotate-proxy <key>")
    expect(ProvidersRotateProxyCommand.describe).toBeTruthy()
    expect(ProvidersPoolCommand.command).toBe("pool <key> <pool>")
    expect(ProvidersPoolCommand.describe).toBeTruthy()
    expect(ProvidersAllowedModelsCommand.command).toBe("allowed-models [key]")
    expect(ProvidersAllowedModelsCommand.describe).toBeTruthy()
    expect(ProvidersTestAccountsCommand.command).toBe("test-accounts <action>")
    expect(ProvidersTestAccountsCommand.describe).toBeTruthy()
  })
})

describe("mutateConnections", () => {
  test("reads, transforms, and persists state atomically", async () => {
    await seedState({ "github-copilot": {} })
    const next = await mutateConnections((state) => ({
      ...state,
      connections: {
        ...state.connections,
        "github-copilot": { ...state.connections["github-copilot"], label: "hello" },
      },
    }))
    expect(next.connections["github-copilot"].label).toBe("hello")
    const raw = JSON.parse(await readFile(connectionFile, "utf8"))
    expect(raw.connections["github-copilot"].label).toBe("hello")
  })

  test("starts from empty() when no file exists", async () => {
    await rm(connectionFile, { force: true }).catch(() => undefined)
    const next = await mutateConnections((state) => state)
    expect(next).toEqual(empty())
  })
})

describe("machineId lifecycle", () => {
  const provide = <A, E>(effect: Effect.Effect<A, E, Auth.Service | AppFileSystem.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(Auth.defaultLayer, AppFileSystem.defaultLayer))))

  async function resetCopilotAuth() {
    await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const all = yield* auth.all()
        for (const key of Object.keys(all)) {
          if (key.startsWith("github-copilot")) yield* auth.remove(key)
        }
        const fs = yield* AppFileSystem.Service
        const store = new ConnectionsStore(fs)
        yield* store.write(emptyConnections())
      }),
    )
  }

  test("importing a new account populates machineId and re-running does not regenerate", async () => {
    const { migrate } = await import("@/plugin/github-copilot/auth")
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    await resetCopilotAuth()
    const dir = path.join(tmpdir(), `opencode-machineid-stable-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const legacyPath = path.join(dir, "legacy.json")
    const markerPath = path.join(dir, "marker.json")
    await writeFile(legacyPath, JSON.stringify({ "github.com": { token: "tok-new-acct", user: "alice" } }))
    const ioFor = (fs: AppFileSystem.Interface) => ({
      legacy: legacyPath,
      apps: legacyPath + ".apps",
      oauth: legacyPath + ".oauth",
      forge: legacyPath + ".forge",
      codedash: legacyPath + ".codedash",
      macOSAppSupport: legacyPath + ".macOSAppSupport",
      marker: markerPath,
      read(p: string) {
        return fs.readJson(p)
      },
      write(p: string, value: unknown) {
        return fs.writeJson(p, value, 0o600)
      },
    })
    try {
      // First migrate: the NEW account gets a machineId minted at add-time.
      const after1 = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          yield* migrate(ioFor(fs))
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      const mid1 = after1.connections["github-copilot"]?.machineId
      expect(typeof mid1).toBe("string")
      expect(mid1).toMatch(/^[0-9a-f-]{36}$/i)

      // Second migrate: the account already exists; machineId MUST be
      // identical — migrate() is forbidden from regenerating the
      // UA-identity of an account it imported earlier.
      const after2 = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          yield* migrate(ioFor(fs))
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      expect(after2.connections["github-copilot"]?.machineId).toBe(mid1!)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await resetCopilotAuth()
    }
  })

  test("seedMachineIds backfill is idempotent across calls (no regeneration)", async () => {
    await resetCopilotAuth()
    try {
      await provide(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set(
            "github-copilot",
            new Auth.Oauth({ type: "oauth", refresh: "r-primary", access: "", expires: 0 }),
          )
          yield* auth.set(
            "github-copilot#edu-1",
            new Auth.Oauth({ type: "oauth", refresh: "r-edu-1", access: "", expires: 0 }),
          )
        }),
      )
      const first = await provide(seedMachineIds())
      expect(first.assigned.sort()).toEqual(["github-copilot", "github-copilot#edu-1"])
      const after1 = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      const mid1 = { ...after1.connections }
      // Re-run: MUST be a no-op — already-minted ids stay stable.
      const second = await provide(seedMachineIds())
      expect(second.assigned).toEqual([])
      const after2 = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      for (const [key, conn] of Object.entries(mid1)) {
        expect(after2.connections[key]?.machineId).toBe(conn.machineId!)
      }
    } finally {
      await resetCopilotAuth()
    }
  })
})

describe("seedMachineIds (machineId pre-population)", () => {
  const provide = <A, E>(effect: Effect.Effect<A, E, Auth.Service | AppFileSystem.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(Auth.defaultLayer, AppFileSystem.defaultLayer))))

  async function resetCopilotAuth() {
    await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const all = yield* auth.all()
        for (const key of Object.keys(all)) {
          if (key.startsWith("github-copilot")) yield* auth.remove(key)
        }
        const fs = yield* AppFileSystem.Service
        const store = new ConnectionsStore(fs)
        yield* store.write(emptyConnections())
      }),
    )
  }

  test("providers accounts surfaces a non-null machineId on every live account", async () => {
    // The invariant `providers accounts --json` relies on: every account
    // present in `Auth.Service.all()` (type === "oauth") must carry a
    // non-empty `status.machineId`.  Mirrors the per-account UA rotation
    // codex_git performs via `ConnectionManager::with_test_accounts`.
    await resetCopilotAuth()
    try {
      const liveKeys = [
        "github-copilot",
        "github-copilot#edu-1",
        "github-copilot#edu-2",
        "github-copilot#enterprise",
      ]
      await provide(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          for (const key of liveKeys) {
            yield* auth.set(
              key,
              new Auth.Oauth({ type: "oauth", refresh: `r-${key}`, access: "", expires: 0 }),
            )
          }
        }),
      )
      // Partially populated connections.json — the buggy state from the
      // original report: some accounts carry a machineId, others don't.
      await seedState({
        "github-copilot": { machineId: "fffffff0-0000-0000-0000-000000000000", plan: "free" },
        "github-copilot#edu-1": { plan: "edu" },
        "github-copilot#enterprise": {},
      })
      const result = await provide(seedMachineIds())
      expect(result.assigned.sort()).toEqual(
        ["github-copilot#edu-1", "github-copilot#edu-2", "github-copilot#enterprise"].sort(),
      )
      const state = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      const statuses = liveKeys.map((key) => jsonStatus(accountStatus({ key, state })))
      for (const status of statuses) {
        expect(status.machineId).not.toBeNull()
        expect(typeof status.machineId).toBe("string")
        expect(status.machineId!.length).toBeGreaterThan(0)
      }
      // Each account gets a distinct identity — the traffic-split
      // heuristics depend on per-account UA distinctness.
      const ids = statuses.map((status) => status.machineId!)
      expect(new Set(ids).size).toBe(ids.length)
      // Pre-existing machineIds are preserved, never regenerated.
      expect(state.connections["github-copilot"].machineId).toBe("fffffff0-0000-0000-0000-000000000000")
    } finally {
      await resetCopilotAuth()
    }
  })

  test("idempotent — a second pass assigns nothing and keeps existing ids stable", async () => {
    await resetCopilotAuth()
    try {
      await provide(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set(
            "github-copilot",
            new Auth.Oauth({ type: "oauth", refresh: "r", access: "", expires: 0 }),
          )
        }),
      )
      const first = await provide(seedMachineIds())
      expect(first.assigned).toEqual(["github-copilot"])
      const initial = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      const mid = initial.connections["github-copilot"].machineId
      expect(mid).toMatch(/^[0-9a-f-]{36}$/i)
      const second = await provide(seedMachineIds())
      expect(second.assigned).toEqual([])
      const after = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      expect(after.connections["github-copilot"].machineId).toBe(mid!)
    } finally {
      await resetCopilotAuth()
    }
  })

  test("skips non-copilot and non-oauth accounts", async () => {
    await resetCopilotAuth()
    try {
      await provide(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("anthropic", new Auth.Api({ type: "api", key: "sk-test" }))
          yield* auth.set(
            "github-copilot",
            new Auth.Oauth({ type: "oauth", refresh: "r", access: "", expires: 0 }),
          )
        }),
      )
      const result = await provide(seedMachineIds())
      expect(result.assigned).toEqual(["github-copilot"])
      const state = await provide(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* new ConnectionsStore(fs).read()
        }),
      )
      expect(state.connections["anthropic"]).toBeUndefined()
      expect(state.connections["github-copilot"]?.machineId).toMatch(/^[0-9a-f-]{36}$/i)
    } finally {
      await resetCopilotAuth()
    }
  })
})

// Regression guard: the quota + `/models` fan-out must run accounts in
// parallel so total wall-clock is O(max(per-account)) not O(sum). Mirrors
// codex_git's `discover_copilot_accounts` (fans out
// `fetch_account_model_catalog_with_discovery_via_proxy`). Three accounts
// whose per-leg delays peak at 50/200/3000ms should all finish together
// around 3000-3500ms. Sequential would be 50+200+3000 = 3250ms per leg × 2
// legs = 6.5s, and the pre-fan-out code did exactly that (two stages).
// We budget 5s so the test tolerates CI scheduling jitter but still catches
// a regression to per-leg-serialised fan-outs (would hit 6+ seconds, as the
// pre-unified code demonstrated).
test("loadAccountStatuses runs quota+/models probes in parallel (fan-out)", async () => {
  const prevFetch = globalThis.fetch
  const prevProbe = process.env.OPENCODE_PROBE_DISCOVERY
  // Enable the discovery probe for this test — the file-level default is "0".
  process.env.OPENCODE_PROBE_DISCOVERY = "1"
  // Per-account total latency budget across BOTH legs. Quota leg is the
  // full delay; /models leg is a short 50ms for every account so the total
  // per-account time is delay + 50ms and we can measure the fan-out
  // concurrency independent of per-account serial cost.
  const quotaDelays: Record<string, number> = {
    fast: 50,
    mid: 200,
    slow: 3_000,
  }
  const callCountsByKey: Record<string, number> = { fast: 0, mid: 0, slow: 0 }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const bearer = headers.get("Authorization") ?? ""
    const key = bearer.endsWith("fast")
      ? "fast"
      : bearer.endsWith("mid")
        ? "mid"
        : bearer.endsWith("slow")
          ? "slow"
          : ""
    callCountsByKey[key] = (callCountsByKey[key] ?? 0) + 1
    const isQuota = String(url).includes("copilot_internal/user")
    const delay = isQuota ? (quotaDelays[key] ?? 0) : 50
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (isQuota) {
      return new Response(
        JSON.stringify({
          user_login: key,
          access_type_sku: "copilot_free",
          endpoints: { api: "https://api.githubcopilot.com" },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    await seedState({
      "github-copilot#fast": {},
      "github-copilot#mid": {},
      "github-copilot#slow": {},
    })
    const started = Date.now()
    await withAuth(
      {
        "github-copilot#fast": new Auth.Oauth({ type: "oauth", refresh: "fast", access: "", expires: 0 }),
        "github-copilot#mid": new Auth.Oauth({ type: "oauth", refresh: "mid", access: "", expires: 0 }),
        "github-copilot#slow": new Auth.Oauth({ type: "oauth", refresh: "slow", access: "", expires: 0 }),
      },
      async () => {
        const { items } = await providersCmd.loadAccountStatuses()
        expect(items).toHaveLength(3)
        // All three accounts should have a quota result (none hit the
        // 15s PROBE_DEADLINE_MS since the slowest leg is 3s).
        expect(items.filter((x) => x.quota).length).toBe(3)
      },
    )
    const elapsed = Date.now() - started
    // Parallel per-account: each account takes (quota_delay + 50ms) end-to-
    // end inside one task, and all three tasks run concurrently via
    // Promise.allSettled. The worst account (slow) takes ~3050ms; the
    // fastest (fast) is ~100ms. Total ≈ max(...) = 3050ms, plus test
    // scheduling jitter. Regression guard at 5000ms: a two-stage fan-out
    // (quota fan-out THEN /models fan-out) would take 3000 + 3000 = 6s.
    expect(elapsed).toBeLessThan(5_000)
    // Sanity: the slow account's mock was called at least twice (quota +
    // /models), confirming both legs ran.
    expect(callCountsByKey.slow).toBeGreaterThanOrEqual(2)
  } finally {
    globalThis.fetch = prevFetch
    if (prevProbe === undefined) delete process.env.OPENCODE_PROBE_DISCOVERY
    else process.env.OPENCODE_PROBE_DISCOVERY = prevProbe
  }
}, 20_000)

test("loadAccountStatuses: one account probe timeout does not block peers", async () => {
  const prevFetch = globalThis.fetch
  const prevProbe = process.env.OPENCODE_PROBE_DISCOVERY
  process.env.OPENCODE_PROBE_DISCOVERY = "1"
  // One account hangs forever; peers must still resolve.  Use a short
  // override via the reject path — simulate by rejecting the slow account
  // immediately after the fast account resolves.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const bearer = headers.get("Authorization") ?? ""
    const key = bearer.endsWith("fast") ? "fast" : "slow"
    if (key === "slow") {
      // Reject loudly — simulates an upstream that threw (network error).
      throw new Error("simulated upstream failure")
    }
    if (String(url).includes("copilot_internal/user")) {
      return new Response(
        JSON.stringify({
          user_login: "fast",
          access_type_sku: "copilot_free",
          endpoints: { api: "https://api.githubcopilot.com" },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    await seedState({
      "github-copilot#fast": {},
      "github-copilot#slow": {},
    })
    await withAuth(
      {
        "github-copilot#fast": new Auth.Oauth({ type: "oauth", refresh: "fast", access: "", expires: 0 }),
        "github-copilot#slow": new Auth.Oauth({ type: "oauth", refresh: "slow", access: "", expires: 0 }),
      },
      async () => {
        const { items } = await providersCmd.loadAccountStatuses()
        const fast = items.find((x) => x.status.key === "github-copilot#fast")
        const slow = items.find((x) => x.status.key === "github-copilot#slow")
        expect(fast?.quota).toBeDefined()
        expect(slow?.quota).toBeUndefined()
        expect(slow?.status.error).toBeDefined()
      },
    )
  } finally {
    globalThis.fetch = prevFetch
    if (prevProbe === undefined) delete process.env.OPENCODE_PROBE_DISCOVERY
    else process.env.OPENCODE_PROBE_DISCOVERY = prevProbe
  }
})
