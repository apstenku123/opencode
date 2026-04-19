import { Auth } from "../../auth"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider"
import { classifyPlan, fetchQuota, formatQuotaBar, type Quota } from "../../plugin/github-copilot/quota"
import { migrate, proxyImports, summarizeMigration, testAccountsFromConfig } from "../../plugin/github-copilot/auth"
import { connectionFile } from "../../plugin/github-copilot/paths"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect } from "effect"
import {
  clearDeactivated as clearDeactivatedConn,
  machine,
  markDeactivated as markDeactivatedConn,
  Store,
  upsert,
} from "../../plugin/github-copilot/connections"
import {
  CopilotRuntimeState,
  getPoolRoutingConfig,
  recent429,
  recentDiscoveryError,
  routeDebug,
  score,
  type RouteDebug,
} from "../../plugin/github-copilot/copilot"
import { poolForAccount, type PoolId } from "../../plugin/github-copilot/pool-routing"
import { StateSchema, empty, type State } from "../../plugin/github-copilot/connections"
import { CopilotModels } from "../../plugin/github-copilot/models"
import { ModelsCache } from "../../plugin/github-copilot/models-cache"
import {
  BUNDLE_VERSION,
  exportBundle as exportBundleEffect,
  importBundle as importBundleEffect,
  parseBundle,
} from "../../plugin/github-copilot/transfer"
import { checkAccountStatuses, type AccountStatusInfo } from "../../plugin/github-copilot/health"
import {
  CopilotStats,
  loadPersistedRateRows,
  parseDuration,
  renderStatsText,
  type AggregateStats,
} from "../../plugin/github-copilot/stats"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import type { Hooks } from "@opencode-ai/plugin"
import * as Process from "../../util/process"
import { text } from "node:stream/consumers"
import { AppRuntime } from "@/effect/app-runtime"

type PluginAuth = NonNullable<Hooks["auth"]>

let migrated = false

export async function allAuth() {
  if (!migrated) {
    migrated = true
    await AppRuntime.runPromise(migrate()).catch(() => undefined)
    // Resolve `copilot.testAccounts` from config.toml and inject the
    // resulting credentials into Auth.Service. Keys look like
    // `github-copilot#edu-<N>` so the existing edu-pool filter gates
    // them out of production routing unless
    // `OPENCODE_ALLOW_TEST_ACCOUNTS=1` is set.
    // `getGlobal()` skips the instance-scoped overlay (project-level
    // opencode.json) which isn't set up yet in `providers accounts`, and
    // resolves against the user's global `~/.config/opencode/*` files —
    // that's where `[copilot.testAccounts]` lives.
    const resolvedCfg = await AppRuntime.runPromise(
      Config.Service.use((c) => c.getGlobal()),
    ).catch(() => undefined as unknown)
    const section = (resolvedCfg as { copilot?: { testAccounts?: unknown } } | undefined)?.copilot
      ?.testAccounts as { tokens?: string[]; labels?: string[]; proxyUrls?: string[] } | undefined
    const synthesised = testAccountsFromConfig(section)
    if (synthesised.length > 0) {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const existing = yield* auth.all()
          const fs = yield* AppFileSystem.Service
          const store = new Store(fs)
          let state = yield* store.read()
          let changed = false
          for (const item of synthesised) {
            if (existing[item.key]) continue
            yield* auth.set(item.key, {
              type: "oauth",
              refresh: item.refresh,
              access: item.access,
              expires: item.expires,
              accountId: item.key,
            })
            if (item.proxyUrl) proxyImports.set(item.key, { url: item.proxyUrl })
            // Fresh test account — mint machineId right now at add-time
            // so the UA-identity is stable for the life of the credential.
            const existingConn = state.connections[item.key]
            if (!existingConn?.machineId) {
              state = upsert(state, item.key, { machineId: crypto.randomUUID().toLowerCase() })
              changed = true
            }
          }
          if (changed) yield* store.write(state)
        }),
      ).catch(() => undefined)
    }
    if (proxyImports.size > 0) {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          const store = new Store(fs)
          let state = yield* store.read()
          let changed = false
          for (const [key, item] of proxyImports) {
            const conn = state.connections[key]
            const proxyAlreadyUp =
              conn?.proxyUrl === item.url && conn?.proxyToken === item.token && conn?.envelope === true
            // Mint machineId the FIRST time we upsert this connection
            // (i.e. no prior entry), then leave it alone on subsequent
            // runs. If the entry already exists with a machineId, we
            // only update the proxy triple if something changed.
            const firstTime = !conn
            if (proxyAlreadyUp && !firstTime) continue
            const patch: {
              proxyUrl?: string
              proxyToken?: string
              envelope?: boolean
              machineId?: string
            } = {}
            if (!proxyAlreadyUp) {
              patch.proxyUrl = item.url
              patch.proxyToken = item.token
              patch.envelope = true
            }
            if (firstTime) patch.machineId = crypto.randomUUID().toLowerCase()
            state = upsert(state, key, patch)
            changed = true
          }
          if (changed) yield* store.write(state)
        }),
      ).catch(() => undefined)
    }
    // NOTE: deliberately NO unconditional `seedMachineIds()` call here.
    // machineId is minted exactly once at account-add-time — inside
    // `migrate()` for imported credentials and inside the testAccounts /
    // proxyImports loops above for synthesised + proxy-imported entries.
    // Once persisted, it must stay stable across restarts; iterating every
    // live account on every boot would be a bug.
  }
  return AppRuntime.runPromise(Auth.Service.use((svc) => svc.all()))
}

/**
 * Add-time helper: assign a fresh `crypto.randomUUID()` to every
 * github-copilot oauth account that does NOT yet carry a `machineId`.
 * Idempotent — a second call is a no-op for keys already minted. Under
 * normal operation machineId is seeded inline during `migrate()` /
 * test-account injection / proxy-import drain, so this function is only
 * exported for unit tests + as a defensive backfill for legacy
 * connections.json files written before the per-add seeding existed.
 *
 * Crucially this is NOT called from `allAuth()` on every startup any
 * more — machineId must be stable across restarts, and regenerating
 * "missing" ids unconditionally was a bug. Callers that do invoke this
 * (e.g. a one-shot migration command) must understand it only acts on
 * accounts still missing a machineId.
 */
export const seedMachineIds = () =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const all = yield* auth.all()
    const keys = Object.entries(all)
      .filter(([key, info]) => key.startsWith("github-copilot") && (info as { type?: string }).type === "oauth")
      .map(([key]) => key)
    if (keys.length === 0) return { assigned: [] as string[] }
    const fs = yield* AppFileSystem.Service
    const store = new Store(fs)
    let state = yield* store.read()
    const assigned: string[] = []
    for (const key of keys) {
      if (state.connections[key]?.machineId) continue
      const [nextState] = machine(state, key)
      state = nextState
      assigned.push(key)
    }
    if (assigned.length > 0) yield* store.write(state)
    return { assigned }
  })

async function readConnections(): Promise<State> {
  const raw = await Bun.file(connectionFile)
    .json()
    .catch(() => empty())
  const parsed = StateSchema.zod.safeParse(raw)
  return parsed.success ? (parsed.data as State) : empty()
}

async function handlePluginAuth(plugin: { auth: PluginAuth }, provider: string, methodName?: string): Promise<boolean> {
  let index = 0
  if (methodName) {
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      prompts.log.error(
        `Unknown method "${methodName}" for ${provider}. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
      )
      process.exit(1)
    }
    index = match
  } else if (plugin.auth.methods.length > 1) {
    const method = await prompts.select({
      message: "Login method",
      options: [
        ...plugin.auth.methods.map((x, index) => ({
          label: x.label,
          value: index.toString(),
        })),
      ],
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    index = parseInt(method)
  }
  const method = plugin.auth.methods[index]

  await new Promise((r) => setTimeout(r, 10))
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    const authorize = await method.authorize(inputs)

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      const result = await authorize.callback()
      if (result.type === "failed") {
        spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await AppRuntime.runPromise(
            Auth.Service.use((svc) =>
              svc.set(saveProvider, {
                type: "oauth",
                refresh,
                access,
                expires,
                ...extraFields,
              }),
            ),
          )
        }
        if ("key" in result) {
          await AppRuntime.runPromise(
            Auth.Service.use((svc) =>
              svc.set(saveProvider, {
                type: "api",
                key: result.key,
              }),
            ),
          )
        }
        spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await AppRuntime.runPromise(
            Auth.Service.use((svc) =>
              svc.set(saveProvider, {
                type: "oauth",
                refresh,
                access,
                expires,
                ...extraFields,
              }),
            ),
          )
        }
        if ("key" in result) {
          await AppRuntime.runPromise(
            Auth.Service.use((svc) =>
              svc.set(saveProvider, {
                type: "api",
                key: result.key,
              }),
            ),
          )
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await AppRuntime.runPromise(
          Auth.Service.use((svc) =>
            svc.set(saveProvider, {
              type: "api",
              key: result.key,
            }),
          ),
        )
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  return false
}

export function resolvePluginProviders(input: {
  hooks: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export function quotaAccounts(
  credentials: Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
) {
  return Object.entries(credentials).filter(
    ([key, info]) => key.startsWith("github-copilot") && info.type === "oauth",
  )
}

export function applyProxy(
  state: { version: number; preferred?: string; connections: Record<string, any> },
  key: string,
  input: { proxyUrl?: string; proxyToken?: string },
) {
  return {
    ...state,
    connections: {
      ...state.connections,
      [key]: {
        ...state.connections[key],
        proxyUrl: input.proxyUrl,
        proxyToken: input.proxyToken,
      },
    },
  }
}

export function copilotAliasLabel(key: string) {
  if (key === "github-copilot") return "Primary"
  if (key === "github-copilot#edu") return "Copilot Edu"
  if (key === "github-copilot#enterprise") return "Copilot Enterprise"
  if (key === "github-copilot#personal") return "Copilot Personal"
  if (key === "github-copilot#free") return "Copilot Free"
  if (key.startsWith("github-copilot#")) return key.replace("github-copilot#", "")
  return key
}

export function copilotAliasName(key: string, name?: string) {
  if (key.startsWith("github-copilot#")) return copilotAliasLabel(key)
  return name || key
}

export function proxyList(
  state: State,
  accounts: Array<[string, { type: string; refresh?: string; enterpriseUrl?: string }]>,
) {
  return accounts.map(([key]) => ({
    key,
    label: copilotAliasLabel(key),
    url: state.connections[key]?.proxyUrl,
    token: state.connections[key]?.proxyToken,
  }))
}

export type AccountDiscoveryJSON = {
  ok: boolean | null
  stale: boolean
  at: number | null
  models: string[]
  api: string | null
  plan: string | null
  login: string | null
  err: string | null
}

export const ACCOUNT_STATUS_SCHEMA_VERSION = 1

export type AccountStatusEnvelopeJSON = {
  schemaVersion: typeof ACCOUNT_STATUS_SCHEMA_VERSION
  status: AccountStatusJSON
}

export type RouteDebugJSON = {
  schemaVersion: typeof ACCOUNT_STATUS_SCHEMA_VERSION
  model: string
  providerID: string | null
  account: string | null
  selected: string | null
  candidates: RouteDebug[]
}

export type RouteDebugSummaryJSON = {
  wins: Record<string, number>
  byAccount: Record<string, { wins: number; winRate: number }>
  byProviderAlias: Record<string, { wins: number; winRate: number }>
  topWinner: string | null
  topWinRate: number
  topLoser: string | null
  rejectionRate: number
  modelCount: number
  selectedCount: number
  selectedRate: number
  winRate: Record<string, number>
  rejectedByLane: number
  rejectedByPenalty: number
  rejectedByDiscovery: number
  byModel: Record<
    string,
    {
      selected: string | null
      winnerReason: string[]
      rejectedByLane: number
      rejectedByPenalty: number
      rejectedByDiscovery: number
    }
  >
}

export type RouteDebugExplainJSON =
  | RouteDebugJSON
  | {
      schemaVersion: typeof ACCOUNT_STATUS_SCHEMA_VERSION
      summary: RouteDebugSummaryJSON
      models: RouteDebugJSON[]
    }

export type AccountPenaltyJSON = {
  recent429: boolean
  recentDiscoveryError: boolean
}

export type AccountRouteJSON = {
  discovery: number
  penalty: number
  load: number
  cooldown: boolean
  routeReason: string[]
}

export type MigrationJSON = {
  migrated: number
  skipped: boolean
  source: string | null
  migratedAt: number | null
  text: string
}

export type AccountStatusJSON = {
  key: string
  label: string
  login: string | null
  plan: string | null
  pool: PoolId | null
  proxy: boolean
  proxyUrl: string | null
  envelope: boolean | null
  machineId: string | null
  allowedProdModels: string[]
  allowedTestModels: string[]
  premium: string | null
  health: string
  exhausted: boolean
  exhaustedUntil: number | null
  quota: Quota | null
  error: string | null
  ghe: string | null
  discovery: AccountDiscoveryJSON
  penalties: AccountPenaltyJSON
  route: AccountRouteJSON
}

/**
 * Resolve the display label for an account's pool assignment. Uses
 * the module-level pool-routing config (seeded at plugin boot) so
 * explicit `copilot.poolRouting.pools` overrides win over plan-derived
 * defaults. Returns `undefined` when neither rule classifies the
 * account.
 */
export function accountPoolLabel(key: string, plan?: string | null): PoolId | undefined {
  return poolForAccount({ key, plan: plan ?? undefined, cfg: getPoolRoutingConfig() })
}

export function emptyDiscovery(): AccountDiscoveryJSON {
  return {
    ok: null,
    stale: true,
    at: null,
    models: [],
    api: null,
    plan: null,
    login: null,
    err: null,
  }
}

export function resolveMigrationSummary(hasExistingAccounts: boolean): ReturnType<typeof summarizeMigration> {
  const recorded = CopilotRuntimeState.migrationSummary()
  if (recorded && (recorded.migrated > 0 || recorded.skipped || recorded.source)) return recorded
  if (hasExistingAccounts) return summarizeMigration({ version: 1, keys: [], skipped: true })
  return recorded ?? summarizeMigration({ version: 1, keys: [] })
}

export function jsonMigration(input: ReturnType<typeof summarizeMigration> | undefined | null): MigrationJSON {
  const item = input ?? {
    migrated: 0,
    skipped: false,
    source: undefined,
    migratedAt: undefined,
    text: "no legacy Copilot migration recorded",
  }
  return {
    migrated: item.migrated,
    skipped: item.skipped,
    source: item.source ?? null,
    migratedAt: item.migratedAt ?? null,
    text: item.text,
  }
}

export function jsonStatus(
  input: ReturnType<typeof accountStatus> & { premium?: string; ghe?: string },
): AccountStatusJSON {
  const pool = accountPoolLabel(input.key, input.plan) ?? null
  return {
    key: input.key,
    label: input.label,
    login: input.login ?? null,
    plan: input.plan ?? null,
    pool,
    proxy: input.proxy,
    proxyUrl: input.proxyUrl ?? null,
    envelope: input.envelope ?? null,
    machineId: input.machineId ?? null,
    allowedProdModels: pool ? poolAllowedProdModels(pool) : [],
    allowedTestModels: pool ? poolAllowedTestModels(pool) : [],
    health: input.health,
    exhausted: input.exhausted,
    exhaustedUntil: input.exhaustedUntil ?? null,
    quota: input.quota ?? null,
    error: input.error ?? null,
    discovery: input.discovery
      ? {
          ok: input.discovery.ok,
          stale: input.discovery.stale,
          at: input.discovery.at ?? null,
          models: [...input.discovery.models],
          api: input.discovery.api ?? null,
          plan: input.discovery.plan ?? null,
          login: input.discovery.login ?? null,
          err: input.discovery.err ?? null,
        }
      : emptyDiscovery(),
    penalties: {
      recent429: !!input.penalties?.recent429,
      recentDiscoveryError: !!input.penalties?.recentDiscoveryError,
    },
    premium: input.premium ?? null,
    ghe: input.ghe ?? null,
    route: {
      discovery: input.route?.discovery ?? 0,
      penalty: input.route?.penalty ?? 0,
      load: input.route?.load ?? 0,
      cooldown: !!input.route?.cooldown,
      routeReason: input.route?.routeReason ?? [],
    },
  }
}

export function accountStatus(input: {
  key: string
  modelId?: string
  now?: number
  state: State
  quota?: Quota
  quotaError?: string
}) {
  const item = input.state.connections[input.key]
  const now = input.now ?? Date.now()
  const exhaustedUntil = item?.exhaustedUntil
  const exhausted = !!exhaustedUntil && exhaustedUntil > now
  const plan = input.quota ? classifyPlan(input.quota) : undefined
  const discovery = item?.discovery
  const stale = !discovery ? true : now - discovery.at > 30 * 60 * 1000
  const health = exhausted
    ? "exhausted"
    : input.quotaError
      ? "quota_error"
      : discovery?.ok === false
        ? "discovery_error"
        : "ok"
  const rated = score(input.state, input.key, input.modelId ?? "", now)
  const debug = routeDebug({
    auths: [{ key: input.key, label: input.key, refresh: "", access: "", expires: 0 }],
    state: input.state,
    modelId: input.modelId ?? "",
    now,
  })[0]
  return {
    key: input.key,
    label: copilotAliasLabel(input.key),
    login: input.quota?.login ?? item?.login,
    plan: plan && plan !== "unknown" ? plan : item?.plan,
    proxy: !!item?.proxyUrl,
    proxyUrl: item?.proxyUrl,
    envelope: item?.envelope,
    machineId: item?.machineId,
    exhausted,
    exhaustedUntil,
    quota: input.quota,
    health,
    error: input.quotaError ?? discovery?.err,
    discovery: discovery
      ? {
          ok: discovery.ok ?? true,
          at: discovery.at,
          stale,
          models: [...discovery.models],
          api: discovery.api,
          plan: discovery.plan,
          login: discovery.login,
          err: discovery.err,
        }
      : undefined,
    unsupportedModels: item?.unsupportedModels ? [...item.unsupportedModels] : [],
    penalties: {
      recent429: recent429(input.state, input.key, now),
      recentDiscoveryError: recentDiscoveryError(input.state, input.key, now),
    },
    route: {
      discovery: rated.discovery,
      penalty: rated.penalty,
      load: 0,
      cooldown: false,
      routeReason: debug?.routeReason ?? [],
    },
  }
}

export function renderAccountStatus(
  status: ReturnType<typeof accountStatus>,
  input?: { premium?: string; enterpriseUrl?: string },
) {
  const pool = accountPoolLabel(status.key, status.plan)
  const extra = [
    status.proxy ? "proxy on" : "direct",
    `pool=${pool ?? "<none>"}`,
    status.exhausted ? "cooldown" : undefined,
    input?.enterpriseUrl ? `ghe ${input.enterpriseUrl}` : undefined,
    status.discovery?.stale ? "discovery stale" : status.discovery ? "discovery fresh" : undefined,
  ]
    .filter(Boolean)
    .join(", ")
  const unsupported = status.unsupportedModels ?? []
  const discoveryLine = status.discovery
    ? `${status.discovery.ok ? "ok" : "error"}${
        status.discovery.models?.length
          ? `, ${status.discovery.models.length} picker-enabled model${status.discovery.models.length === 1 ? "" : "s"}`
          : ""
      }${status.discovery.err ? `, ${status.discovery.err}` : ""}`
    : "unknown"
  const unsupportedLine =
    unsupported.length > 0 ? `\n  Unsupported: ${unsupported.join(", ")} (returned model_not_supported in live dispatch)` : ""
  // Proxy / machineId / allowed-models lines anchor the "which physical
  // identity is this" view the user reviews in `providers accounts` — these
  // mirror the codex_git app-server bootstrap (see
  // `codex-rs/app-server/src/copilot_bootstrap.rs` discovery logs).
  const proxyLine = status.proxyUrl
    ? `\n  Proxy: ${status.proxyUrl}${status.envelope === true ? " (envelope)" : ""}`
    : ""
  const machineLine = status.machineId ? `\n  Machine ID: ${status.machineId}` : ""
  const allowedProd = pool ? poolAllowedProdModels(pool) : []
  const allowedTest = pool ? poolAllowedTestModels(pool) : []
  const allowedLine = pool
    ? `\n  Allowed (prod): ${allowedProd.join(", ") || "<none>"}\n  Allowed (test-only): ${allowedTest.join(", ") || "<none>"}`
    : ""
  return `${status.label} ${UI.Style.TEXT_DIM}${extra}
  Login: ${status.login ?? "unknown"}
  Plan: ${status.plan ?? "unknown"}${machineLine}${proxyLine}
  Health: ${status.health}
  Discovery: ${discoveryLine}${unsupportedLine}${allowedLine}${
    input?.premium
      ? `
  Premium: ${input.premium}`
      : ""
  }`
}

/**
 * Production models a pool is permitted to route. Mirrors codex_git model
 * gating in `DEFAULT_POOL_RULES` + xhigh-only constraint. Enterprise (prod
 * pool) defaults to gpt-5.4-xhigh + claude-4.7-opus-high; edu defaults to
 * codex-5.3-xhigh. Expressed here so `providers accounts` shows the user
 * which models will route to each account without needing to read the
 * source.
 */
export function poolAllowedProdModels(pool: PoolId): string[] {
  if (pool === "edu") return ["codex-5.3-xhigh"]
  return ["gpt-5.4-xhigh", "claude-4.7-opus-high"]
}

/**
 * Models permitted when the account is consumed as a test slot (edu pool
 * or CODEX_TEST_COPILOT_TOKENS-style injected slot). Mirrors codex_git
 * `[test_accounts].supported_models`.
 */
export function poolAllowedTestModels(_pool: PoolId): string[] {
  return ["gpt-4.1", "gpt-5-mini-xhigh"]
}

/**
 * Shared budget for the parallel quota + `/models` fan-out.  Mirrors the Rust
 * CLI's `discover_copilot_accounts` + `models_manager::fetch_all_accounts`
 * deadline. With `Promise.allSettled` every account probe runs concurrently,
 * so the total wall-clock time for N accounts is `max(per-account)` rather
 * than `sum(per-account)` — lifting this ceiling from the previous 8s keeps
 * slow upstreams (edu + enterprise pool, 11+ accounts) inside budget while
 * still guarding against a hung single connection blocking the CLI.
 */
export const PROBE_DEADLINE_MS = 15_000

/**
 * Race a probe promise against the shared deadline. On timeout the returned
 * promise resolves with `{ timedOut: true }` — the caller records a probe
 * error for that account rather than hanging on a dangling request.
 */
function withDeadline<T>(run: () => Promise<T>, deadlineMs: number): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, timedOut: true })
    }, deadlineMs)
    run().then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: true, value })
      },
      (_err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Surface the rejection to the caller as a normal Promise rejection
        // (propagated via a rejected inner promise) so the outer try/catch
        // path stays untouched.
        resolve(Promise.reject(_err) as never)
      },
    )
  })
}

export async function loadAccountStatuses() {
  const DBG = process.env.OPENCODE_DEBUG_PROVIDERS === "1"
  const log = (m: string) => DBG && process.stderr.write(`[providers] ${m}\n`)
  log("start allAuth")
  const credentials = await allAuth()
  log(`allAuth ok (${Object.keys(credentials).length} creds)`)
  const accounts = quotaAccounts(
    credentials as Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
  )
  log(`accounts filtered: ${accounts.length}`)
  let state = await readConnections()
  log(`connections loaded (${Object.keys(state.connections).length})`)
  const newlyDeactivated = new Set<string>()
  const probeEnabled = process.env.OPENCODE_PROBE_DISCOVERY !== "0"
  const { discover } = await import("../../plugin/github-copilot/connections")
  const { base, proxyHeaders } = await import("../../plugin/github-copilot/copilot")
  // Unified per-account probe task: `/copilot_internal/user` then `/models`
  // (serial within one task because `/models` needs the `api_base_url` from
  // `/copilot_internal/user`). ALL accounts run concurrently via
  // `Promise.allSettled` under one shared PROBE_DEADLINE_MS ceiling per
  // upstream call. Mirrors codex_git's
  // `fetch_account_model_catalog_with_discovery_via_proxy` fanned out over
  // `discover_copilot_accounts`. Total wall-clock is
  // `max(per-account(quota + /models))` instead of the previous two-stage
  // layout where the `/models` fan-out waited for the slowest quota probe.
  type ProbeUpdate = {
    key: string
    ids: string[] | null
    err?: string
    apiBase: string
    plan?: string
    login?: string
  }
  type FannedOutResult = {
    key: string
    info: (typeof accounts)[number][1]
    proxy: { url?: string; token?: string; envelope?: boolean } | undefined
    quota: Awaited<ReturnType<typeof fetchQuota>> | undefined
    quotaError?: string
    probeUpdate?: ProbeUpdate
  }
  const started = Date.now()
  const settledResults = await Promise.allSettled(
    accounts.map(async ([key, info]): Promise<FannedOutResult> => {
      const proxy = state.connections[key]?.proxyUrl
        ? {
            url: state.connections[key]?.proxyUrl,
            token: state.connections[key]?.proxyToken,
            envelope: state.connections[key]?.envelope,
          }
        : undefined
      log(`fetchQuota ${key} start`)
      const quotaOutcome = await withDeadline(
        () => fetchQuota(info.refresh || "", info.enterpriseUrl, proxy),
        PROBE_DEADLINE_MS,
      ).catch((err) => ({ ok: false as const, err: err instanceof Error ? err.message : String(err) }))
      if (!("ok" in quotaOutcome) || quotaOutcome.ok !== true) {
        const msg =
          "err" in quotaOutcome
            ? quotaOutcome.err
            : "timedOut" in quotaOutcome
              ? `Probe deadline ${PROBE_DEADLINE_MS}ms exceeded`
              : "unknown probe error"
        log(`fetchQuota ${key} err: ${msg}`)
        return { key, info, proxy, quota: undefined, quotaError: msg }
      }
      const quota = quotaOutcome.value
      log(`fetchQuota ${key} ok`)
      // Skip discovery when disabled, when already discovered successfully
      // (dedup), or when there's no refresh token to use.
      if (!probeEnabled) return { key, info, proxy, quota }
      const conn = state.connections[key]
      if (conn?.discovery?.at && conn.discovery.ok !== false) {
        log(`probe: ${key} already discovered, skip`)
        return { key, info, proxy, quota }
      }
      const refresh = info.refresh || ""
      if (!refresh) {
        log(`probe: ${key} no refresh token, skip`)
        return { key, info, proxy, quota }
      }
      const apiBase = quota.api ?? base(info.enterpriseUrl)
      log(`probe: ${key} GET ${apiBase}/models start`)
      const probeOutcome = await withDeadline(
        () =>
          ModelsCache.instance().get(key, {
            apiBase,
            headers: {
              Authorization: `Bearer ${refresh}`,
              "User-Agent": `opencode/providers-cli`,
              ...proxyHeaders(proxy?.token),
            },
            existing: {},
            proxyUrl: proxy?.url,
            plan: quota.plan,
            proxy: { token: proxy?.token, envelope: proxy?.envelope },
          }),
        PROBE_DEADLINE_MS,
      ).catch((err) => ({ ok: false as const, err: err instanceof Error ? err.message : String(err) }))
      if ("ok" in probeOutcome && probeOutcome.ok === true) {
        const ids = Object.values(probeOutcome.value).map((m) => m.api.id)
        log(`probe: ${key} ok, ${ids.length} models`)
        return {
          key,
          info,
          proxy,
          quota,
          probeUpdate: { key, ids, apiBase, plan: quota.plan, login: quota.login },
        }
      }
      const probeMsg =
        "err" in probeOutcome
          ? probeOutcome.err
          : "timedOut" in probeOutcome
            ? `Probe deadline ${PROBE_DEADLINE_MS}ms exceeded`
            : "unknown probe error"
      log(`probe: ${key} err: ${probeMsg}`)
      return {
        key,
        info,
        proxy,
        quota,
        probeUpdate: { key, ids: null, err: probeMsg, apiBase, plan: quota.plan, login: quota.login },
      }
    }),
  )
  log(`fan-out settled in ${Date.now() - started}ms`)
  const probeUpdates: ProbeUpdate[] = []
  const items = settledResults.map((settled, idx) => {
    const [key, info] = accounts[idx]!
    if (settled.status === "rejected") {
      // Should not happen — the inner promise swallows errors into the
      // result shape. Guard anyway so a surprise rejection doesn't collapse
      // the whole fan-out.
      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
      return {
        info,
        quota: undefined,
        proxy: undefined,
        status: accountStatus({ key, state, quotaError: msg }),
        premium: undefined,
        ghe: info.enterpriseUrl ?? null,
      }
    }
    const r = settled.value
    if (r.probeUpdate) probeUpdates.push(r.probeUpdate)
    if (r.quota) {
      return {
        info,
        quota: r.quota,
        proxy: r.proxy,
        status: accountStatus({ key, state, quota: r.quota }),
        premium: r.quota.premium ? formatQuotaBar(r.quota.premium, r.quota.resetDate) : "no quota info available",
        ghe: info.enterpriseUrl ?? null,
      }
    }
    const msg = r.quotaError ?? "unknown quota error"
    const match = msg.match(/Failed to fetch quota: (\d{3})/)
    const statusCode = match ? Number(match[1]) : undefined
    if (statusCode === 401 || statusCode === 403) newlyDeactivated.add(key)
    return {
      info,
      quota: undefined,
      proxy: r.proxy,
      status: accountStatus({ key, state, quotaError: msg }),
      premium: undefined,
      ghe: info.enterpriseUrl ?? null,
    }
  })
  log(`items resolved (${items.length})`)
  // Apply probe updates into the in-memory state before persisting.
  for (const u of probeUpdates) {
    state = discover(state, u.key, {
      models: u.ids ?? [],
      api: u.apiBase,
      plan: u.plan,
      login: u.login,
      ok: !u.err,
      err: u.err,
    })
  }
  // Deactivation pass: persist any 401/403-triggered deactivations + surface
  // them in status so the pool routing layer (connections.ts::next) skips
  // them on the next dispatch.
  if (newlyDeactivated.size > 0) {
    const { markDeactivated } = await import("../../plugin/github-copilot/connections")
    for (const key of newlyDeactivated) {
      state = markDeactivated(state, key)
      const hit = items.find((it) => it.status.key === key)
      if (hit) {
        hit.status.health = "deactivated"
        hit.status.error = hit.status.error ?? "account suspended / token revoked (401/403)"
      }
    }
    log(`marked deactivated: ${[...newlyDeactivated].join(", ")}`)
  }
  // Single batched write for both deactivation + probe updates. Mirrors
  // Rust's one-writer-at-end pattern instead of per-account writes racing
  // on the same file.
  const needsWrite = newlyDeactivated.size > 0 || probeUpdates.length > 0
  if (needsWrite) {
    try {
      log("persist: writing copilot-connections.json")
      await Bun.write(connectionFile, JSON.stringify(state, null, 2))
      log("persist: ok")
    } catch (err) {
      log(`persist: err: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Re-render each account status from the freshly-updated state so
  // downstream consumers see discovery/login/plan metadata.
  if (probeUpdates.length > 0) {
    for (const item of items) {
      item.status = accountStatus({
        key: item.status.key,
        state,
        quota: item.quota,
        quotaError: item.status.error && !item.quota ? item.status.error : undefined,
      })
    }
  }
  log("loadAccountStatuses: done")
  return { accounts, state, items }
}

export async function loadRouteDebug(input: { model: string; providerID?: string; account?: string }) {
  const credentials = await allAuth()
  const accounts = quotaAccounts(
    credentials as Record<
      string,
      { type: string; refresh?: string; access?: string; expires?: number; enterpriseUrl?: string }
    >,
  )
  const auths = accounts.map(([key, info]) => ({
    key,
    label: copilotAliasLabel(key),
    refresh: info.refresh || "",
    access: (info as any).access || info.refresh || "",
    expires: (info as any).expires || 0,
    enterpriseUrl: info.enterpriseUrl,
  }))
  const state = await readConnections()
  const debug = routeDebug({ auths, state, modelId: input.model, providerID: input.providerID })
  const candidates = input.account ? debug.filter((item) => item.key === input.account) : debug
  const selected = candidates[0]?.key ?? null
  return {
    schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
    model: input.model,
    providerID: input.providerID ?? null,
    account: input.account ?? null,
    selected,
    candidates,
  } satisfies RouteDebugJSON
}

export function routeSummary(models: RouteDebugJSON[]): RouteDebugSummaryJSON {
  const wins = Object.fromEntries(
    Object.entries(
      models.reduce(
        (acc, item) => {
          if (item.selected) acc[item.selected] = (acc[item.selected] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      ),
    ).sort(([a], [b]) => a.localeCompare(b)),
  )
  const selectedCount = models.filter((item) => !!item.selected).length
  const total = models.length || 1
  const byAccount = Object.fromEntries(
    Object.entries(wins).map(([key, value]) => [key, { wins: value, winRate: value / total }]),
  )
  const top = Object.entries(wins).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  const seen = new Set(models.flatMap((item) => item.candidates.map((x) => x.key)))
  const losers = [...seen].filter((key) => !(key in wins)).sort()
  return {
    wins,
    byAccount,
    byProviderAlias: byAccount,
    topWinner: top?.[0] ?? null,
    topWinRate: top ? top[1] / total : 0,
    topLoser: losers[0] ?? null,
    rejectionRate: 1 - selectedCount / total,
    modelCount: models.length,
    selectedCount,
    selectedRate: selectedCount / total,
    winRate: Object.fromEntries(Object.entries(wins).map(([key, value]) => [key, value / total])),
    rejectedByLane: models
      .flatMap((item) => item.candidates)
      .filter((item) => item.rejectedReason.includes("laneMismatch")).length,
    rejectedByPenalty: models
      .flatMap((item) => item.candidates)
      .filter((item) => item.rejectedReason.includes("higherPenalty")).length,
    rejectedByDiscovery: models
      .flatMap((item) => item.candidates)
      .filter((item) => item.rejectedReason.includes("lowerDiscoveryRank")).length,
    byModel: Object.fromEntries(
      models.map((item) => [
        item.model,
        {
          selected: item.selected,
          winnerReason: item.candidates.find((x) => x.selected)?.selectedReason ?? [],
          rejectedByLane: item.candidates.filter((x) => x.rejectedReason.includes("laneMismatch")).length,
          rejectedByPenalty: item.candidates.filter((x) => x.rejectedReason.includes("higherPenalty")).length,
          rejectedByDiscovery: item.candidates.filter((x) => x.rejectedReason.includes("lowerDiscoveryRank")).length,
        },
      ]),
    ),
  }
}

export async function loadRouteExplain(input: {
  model?: string
  models?: string[]
  providerID?: string
  account?: string
  allModels?: boolean
  allAccounts?: boolean
}): Promise<RouteDebugExplainJSON> {
  const models = input.allModels
    ? ["gpt-5-mini", "gpt-4.1", "gpt-5-enterprise", "gpt-4.1-edu"]
    : [input.model || "gpt-5-mini"]
  const data = await Promise.all(
    models.map((model) =>
      loadRouteDebug({ model, providerID: input.providerID, account: input.allAccounts ? undefined : input.account }),
    ),
  )
  if (input.allModels)
    return { schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION, summary: routeSummary(data), models: data }
  return data[0]
}

export async function saveProxy(key: string, proxyUrl?: string, proxyToken?: string) {
  const raw = await Bun.file(connectionFile)
    .json()
    .catch(() => empty())
  const parsed = StateSchema.zod.safeParse(raw)
  const state = parsed.success ? (parsed.data as State) : empty()
  const next = applyProxy(state, key, { proxyUrl, proxyToken })
  await Bun.write(connectionFile, JSON.stringify(next, null, 2))
  return next
}

/**
 * Path of the global opencode config used by `providers pool` and
 * `providers test-accounts …` to persist pool overrides + injected
 * test-account slots. Mirrors the file loaded by
 * `Config.Service.getGlobal` (`config/config.ts` — `Global.Path.config`).
 */
export function globalConfigPath(): string {
  return path.join(Global.Path.config, "opencode.json")
}

/**
 * Read the global `opencode.json` as an unconstrained record. Missing
 * or malformed files yield `{}` so callers can treat "no config yet"
 * and "empty config" identically.
 */
export async function readGlobalConfigRaw(): Promise<Record<string, any>> {
  try {
    const raw = (await Bun.file(globalConfigPath()).json()) as unknown
    return raw && typeof raw === "object" ? (raw as Record<string, any>) : {}
  } catch {
    return {}
  }
}

/**
 * Pretty-print the config to `~/.config/opencode/opencode.json`. Keeps a
 * trailing newline so existing editors that hard-wrap on load don't
 * re-wrap the last object on save.
 */
export async function writeGlobalConfigRaw(cfg: Record<string, any>): Promise<void> {
  await Bun.write(globalConfigPath(), JSON.stringify(cfg, null, 2) + "\n")
}

/**
 * Produce a new config record with the given account pinned to `pool`.
 * `pool === "none"` removes the account from both pools (reverting to
 * plan-derived defaults). Preserves unrelated `copilot.poolRouting.pools`
 * members (e.g. other accounts pinned to edu/prod). Does not touch
 * `copilot.testAccounts`.
 */
export function setPoolOverrideConfig(
  cfg: Record<string, any>,
  key: string,
  pool: "edu" | "prod" | "none",
): Record<string, any> {
  const next = { ...cfg }
  const copilot = { ...(next.copilot ?? {}) }
  const poolRouting = { ...(copilot.poolRouting ?? {}) }
  const pools = { ...(poolRouting.pools ?? {}) } as { edu?: string[]; prod?: string[] }
  const stripped = {
    edu: (pools.edu ?? []).filter((k: string) => k !== key),
    prod: (pools.prod ?? []).filter((k: string) => k !== key),
  }
  if (pool !== "none") {
    const current = new Set<string>(stripped[pool])
    current.add(key)
    stripped[pool] = [...current].sort()
  }
  // Drop empty arrays to keep the JSON tidy; the pools object collapses
  // to `{}` when no overrides remain and then the whole poolRouting
  // block is dropped below.
  const cleaned: { edu?: string[]; prod?: string[] } = {}
  if (stripped.edu.length > 0) cleaned.edu = stripped.edu
  if (stripped.prod.length > 0) cleaned.prod = stripped.prod
  if (Object.keys(cleaned).length > 0) {
    poolRouting.pools = cleaned
  } else {
    delete poolRouting.pools
  }
  if (Object.keys(poolRouting).length > 0) {
    copilot.poolRouting = poolRouting
  } else {
    delete copilot.poolRouting
  }
  if (Object.keys(copilot).length > 0) {
    next.copilot = copilot
  } else {
    delete next.copilot
  }
  return next
}

/**
 * Append a test-account slot to `copilot.testAccounts`. Mutates all
 * three parallel arrays (tokens/labels/proxyUrls) in lockstep so the
 * synth key `github-copilot#edu-<slug>` stays stable across list /
 * remove cycles. Throws if the `label` is already in use.
 */
export function addTestAccountConfig(
  cfg: Record<string, any>,
  input: { label: string; token: string; proxy?: string },
): Record<string, any> {
  const next = { ...cfg }
  const copilot = { ...(next.copilot ?? {}) }
  const testAccounts = { ...(copilot.testAccounts ?? {}) }
  const tokens = [...(testAccounts.tokens ?? [])] as string[]
  const labels = [...(testAccounts.labels ?? [])] as string[]
  const proxyUrls = [...(testAccounts.proxyUrls ?? [])] as string[]
  if (labels.includes(input.label)) {
    throw new Error(`test account with label "${input.label}" already exists`)
  }
  tokens.push(input.token)
  labels.push(input.label)
  // Keep proxyUrls index-matched even when the caller didn't set one, so
  // `proxyUrls[i]` lines up with `tokens[i]` / `labels[i]`.
  proxyUrls.push(input.proxy ?? "")
  testAccounts.tokens = tokens
  testAccounts.labels = labels
  testAccounts.proxyUrls = proxyUrls
  copilot.testAccounts = testAccounts
  next.copilot = copilot
  return next
}

/**
 * Remove the slot matching `label` from `copilot.testAccounts`. Returns
 * the unchanged config when no slot matches (caller can detect that by
 * comparing `listTestAccountsConfig(before).length` to `after`).
 */
export function removeTestAccountConfig(cfg: Record<string, any>, label: string): Record<string, any> {
  const ta = cfg.copilot?.testAccounts
  const labels = (ta?.labels ?? []) as string[]
  const idx = labels.findIndex((l) => l === label)
  if (idx < 0) return cfg
  const next = { ...cfg }
  const copilot = { ...(next.copilot ?? {}) }
  const testAccounts = { ...(copilot.testAccounts ?? {}) }
  const remove = (arr: string[] | undefined) => {
    if (!arr) return arr
    const out = [...arr]
    out.splice(idx, 1)
    return out
  }
  testAccounts.tokens = remove(testAccounts.tokens)
  testAccounts.labels = remove(testAccounts.labels)
  testAccounts.proxyUrls = remove(testAccounts.proxyUrls)
  const nonEmpty = (arr: string[] | undefined) => (arr && arr.length > 0 ? arr : undefined)
  const clean = {
    tokens: nonEmpty(testAccounts.tokens),
    labels: nonEmpty(testAccounts.labels),
    proxyUrls: nonEmpty(testAccounts.proxyUrls),
    supportedModels: testAccounts.supportedModels,
  }
  const hasAny =
    clean.tokens !== undefined ||
    clean.labels !== undefined ||
    clean.proxyUrls !== undefined ||
    clean.supportedModels !== undefined
  if (hasAny) {
    copilot.testAccounts = Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined))
  } else {
    delete copilot.testAccounts
  }
  if (Object.keys(copilot).length > 0) {
    next.copilot = copilot
  } else {
    delete next.copilot
  }
  return next
}

/**
 * Return the configured test-account slots as `{label, token, proxy}`.
 * Mirrors the display form used by `providers test-accounts list` — the
 * caller decides whether to mask the token.
 */
export function listTestAccountsConfig(
  cfg: Record<string, any>,
): Array<{ label: string; token: string; proxy: string | null }> {
  const ta = cfg.copilot?.testAccounts
  const tokens = (ta?.tokens ?? []) as string[]
  const labels = (ta?.labels ?? []) as string[]
  const proxyUrls = (ta?.proxyUrls ?? []) as string[]
  return tokens.map((token, i) => ({
    label: labels[i] ?? `edu-${i + 1}`,
    token,
    proxy: proxyUrls[i] && proxyUrls[i].length > 0 ? proxyUrls[i] : null,
  }))
}

/**
 * Load `copilot-connections.json`, run `transform`, and persist the
 * result. Shared helper that backs `deactivate`, `activate`,
 * `rotate-machine-id`, and `rotate-proxy` so they all take the same
 * "read → mutate → write" path.
 */
export async function mutateConnections(transform: (state: State) => State): Promise<State> {
  const raw = await Bun.file(connectionFile)
    .json()
    .catch(() => empty())
  const parsed = StateSchema.zod.safeParse(raw)
  const state = parsed.success ? (parsed.data as State) : empty()
  const next = transform(state)
  await Bun.write(connectionFile, JSON.stringify(next, null, 2))
  return next
}

/**
 * Strip `machineId` from the connection. `machine()` generates a fresh
 * UUID on the next dispatch, so the account effectively rotates to a
 * new device identity. `JSON.stringify` drops `undefined` values on
 * persistence, which matches the on-disk shape for accounts that never
 * had a machine id assigned.
 */
export function rotateMachineId(state: State, key: string): State {
  return upsert(state, key, { machineId: undefined })
}

/**
 * Overwrite per-account proxy config. Passing `undefined` for `url`
 * clears the proxy (same semantics as `saveProxy(key, undefined)`).
 * `envelope` defaults to the previously-stored value — pass
 * `true`/`false` to change it explicitly.
 */
export function rotateProxyConfig(
  state: State,
  key: string,
  input: { url?: string; token?: string; envelope?: boolean },
): State {
  return upsert(state, key, {
    proxyUrl: input.url,
    proxyToken: input.token,
    envelope: input.envelope,
  })
}

export const ProvidersDeactivateCommand = cmd({
  command: "deactivate <key>",
  describe: "mark a GitHub Copilot account as deactivated (skipped by routing)",
  builder: (yargs) =>
    yargs.positional("key", {
      describe: "account key (e.g. github-copilot or github-copilot#edu)",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    const key = String(args.key)
    await mutateConnections((state) => markDeactivatedConn(state, key))
    prompts.log.success(`deactivated ${copilotAliasLabel(key)}`)
  },
})

export const ProvidersActivateCommand = cmd({
  command: "activate <key>",
  aliases: ["reactivate"],
  describe: "clear the deactivated flag for a GitHub Copilot account (alias: reactivate)",
  builder: (yargs) =>
    yargs.positional("key", {
      describe: "account key (e.g. github-copilot or github-copilot#edu)",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    const key = String(args.key)
    await mutateConnections((state) => clearDeactivatedConn(state, key))
    prompts.log.success(`activated ${copilotAliasLabel(key)}`)
  },
})

export const ProvidersRotateMachineIdCommand = cmd({
  command: "rotate-machine-id <key>",
  describe: "regenerate machineId for a GitHub Copilot account on next dispatch",
  builder: (yargs) =>
    yargs.positional("key", {
      describe: "account key (e.g. github-copilot or github-copilot#edu)",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    const key = String(args.key)
    await mutateConnections((state) => rotateMachineId(state, key))
    prompts.log.success(
      `cleared machineId for ${copilotAliasLabel(key)} — a fresh UUID will be generated on next dispatch`,
    )
  },
})

export const ProvidersRotateProxyCommand = cmd({
  command: "rotate-proxy <key>",
  describe: "update proxy config for a GitHub Copilot account",
  builder: (yargs) =>
    yargs
      .positional("key", {
        describe: "account key (e.g. github-copilot or github-copilot#edu)",
        type: "string",
        demandOption: true,
      })
      .option("url", {
        type: "string",
        describe: "proxy base URL (pass empty string to clear)",
      })
      .option("token", {
        type: "string",
        describe: "proxy token (optional)",
      })
      .option("envelope", {
        type: "boolean",
        describe: "opt into the POST /fetch envelope protocol",
      }),
  async handler(args) {
    const key = String(args.key)
    const url = typeof args.url === "string" ? args.url.trim() : undefined
    const token = typeof args.token === "string" ? args.token.trim() : undefined
    const envelope = typeof args.envelope === "boolean" ? args.envelope : undefined
    await mutateConnections((state) =>
      rotateProxyConfig(state, key, {
        url: url && url.length > 0 ? url : undefined,
        token: token && token.length > 0 ? token : undefined,
        envelope,
      }),
    )
    prompts.log.success(
      url ? `updated proxy for ${copilotAliasLabel(key)} -> ${url}` : `cleared proxy for ${copilotAliasLabel(key)}`,
    )
  },
})

export const ProvidersPoolCommand = cmd({
  command: "pool <key> <pool>",
  describe: "pin a GitHub Copilot account to a specific pool (edu/prod) via config override",
  builder: (yargs) =>
    yargs
      .positional("key", {
        describe: "account key (e.g. github-copilot#edu)",
        type: "string",
        demandOption: true,
      })
      .positional("pool", {
        describe: "target pool: edu, prod, or none (clear override)",
        type: "string",
        choices: ["edu", "prod", "none"],
        demandOption: true,
      }),
  async handler(args) {
    const key = String(args.key)
    const pool = String(args.pool) as "edu" | "prod" | "none"
    const cfg = await readGlobalConfigRaw()
    const next = setPoolOverrideConfig(cfg, key, pool)
    await writeGlobalConfigRaw(next)
    if (pool === "none") {
      prompts.log.success(`cleared pool override for ${copilotAliasLabel(key)}`)
    } else {
      prompts.log.success(`pinned ${copilotAliasLabel(key)} to pool=${pool}`)
    }
  },
})

export const ProvidersAllowedModelsCommand = cmd({
  command: "allowed-models [key]",
  describe: "show allowed prod + test-only models per pool",
  builder: (yargs) =>
    yargs
      .positional("key", {
        describe: "restrict output to the pool of this account key",
        type: "string",
      })
      .option("json", { type: "boolean", describe: "emit result as JSON" }),
  async handler(args) {
    const allPools: PoolId[] = ["edu", "prod"]
    let targetPool: PoolId | undefined
    if (args.key) {
      const key = String(args.key)
      const state = await readConnections()
      const plan = state.connections[key]?.plan
      targetPool = accountPoolLabel(key, plan)
      if (!targetPool) {
        prompts.log.error(`no pool classification for ${copilotAliasLabel(key)} (plan=${plan ?? "unknown"})`)
        return
      }
    }
    const result: Record<string, { prod: string[]; test: string[] }> = Object.fromEntries(
      (targetPool ? [targetPool] : allPools).map((pool) => [
        pool,
        {
          prod: poolAllowedProdModels(pool),
          test: poolAllowedTestModels(pool),
        },
      ]),
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      return
    }
    for (const [pool, entry] of Object.entries(result)) {
      prompts.log.info(`pool=${pool}`)
      prompts.log.info(`  Allowed (prod): ${entry.prod.join(", ") || "<none>"}`)
      prompts.log.info(`  Allowed (test-only): ${entry.test.join(", ") || "<none>"}`)
    }
  },
})

export const ProvidersTestAccountsCommand = cmd({
  command: "test-accounts <action>",
  describe: "manage copilot.testAccounts in ~/.config/opencode/opencode.json",
  builder: (yargs) =>
    yargs
      .command({
        command: "add <label>",
        describe: "add a test account slot to copilot.testAccounts",
        builder: (y) =>
          y
            .positional("label", {
              describe: "human-readable label (e.g. student-1)",
              type: "string",
              demandOption: true,
            })
            .option("token", {
              type: "string",
              describe: "Copilot OAuth token (ghu_…)",
              demandOption: true,
            })
            .option("proxy", {
              type: "string",
              describe: "optional proxy URL (enables envelope protocol)",
            }),
        async handler(args) {
          const cfg = await readGlobalConfigRaw()
          try {
            const next = addTestAccountConfig(cfg, {
              label: String(args.label),
              token: String(args.token),
              proxy: typeof args.proxy === "string" && args.proxy.length > 0 ? args.proxy : undefined,
            })
            await writeGlobalConfigRaw(next)
            prompts.log.success(`added test account "${args.label}"`)
          } catch (err) {
            prompts.log.error((err as Error).message)
            process.exit(1)
          }
        },
      })
      .command({
        command: "list",
        describe: "print configured copilot.testAccounts slots",
        builder: (y) => y.option("json", { type: "boolean", describe: "emit result as JSON" }),
        async handler(args) {
          const cfg = await readGlobalConfigRaw()
          const items = listTestAccountsConfig(cfg)
          if (args.json) {
            process.stdout.write(JSON.stringify(items, null, 2) + "\n")
            return
          }
          if (items.length === 0) {
            prompts.log.info("no test accounts configured")
            return
          }
          for (const item of items) {
            const masked = item.token.length > 8 ? item.token.slice(0, 4) + "…" + item.token.slice(-4) : "…"
            const proxy = item.proxy ? ` proxy=${item.proxy}` : ""
            prompts.log.info(`${item.label} ${UI.Style.TEXT_DIM}token=${masked}${proxy}`)
          }
        },
      })
      .command({
        command: "remove <label>",
        describe: "remove a test account slot by label",
        builder: (y) =>
          y.positional("label", {
            describe: "label of the slot to remove",
            type: "string",
            demandOption: true,
          }),
        async handler(args) {
          const cfg = await readGlobalConfigRaw()
          const before = listTestAccountsConfig(cfg).length
          const next = removeTestAccountConfig(cfg, String(args.label))
          const after = listTestAccountsConfig(next).length
          if (after === before) {
            prompts.log.error(`no test account with label "${args.label}"`)
            process.exit(1)
          }
          await writeGlobalConfigRaw(next)
          prompts.log.success(`removed test account "${args.label}"`)
        },
      })
      .demandCommand(),
  async handler() {},
})

export const ProvidersModelsCacheCommand = cmd({
  command: "models-cache <action>",
  describe: "inspect or invalidate the GitHub Copilot /models response cache",
  builder: (yargs) =>
    yargs
      .command({
        command: "list",
        describe: "show cached /models entries with age",
        builder: (y) => y.option("json", { type: "boolean", describe: "emit result as JSON" }),
        async handler(args) {
          const cache = ModelsCache.instance()
          const entries = cache.list()
          const now = Date.now()
          const rows = entries.map((e) => ({
            accountKey: e.accountKey,
            apiBase: e.apiBase,
            plan: e.plan,
            fetchedAt: new Date(e.fetchedAt).toISOString(),
            ageMs: now - e.fetchedAt,
            modelCount: Object.keys(e.models).length,
          }))
          if (args.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  entries: rows,
                  hits: cache.hits,
                  misses: cache.misses,
                  refreshes: cache.refreshes,
                  swrRefreshes: cache.swrRefreshes,
                },
                null,
                2,
              ) + "\n",
            )
            return
          }
          if (rows.length === 0) {
            prompts.log.info("models cache is empty")
            return
          }
          for (const r of rows) {
            prompts.log.info(
              `${r.accountKey} ${UI.Style.TEXT_DIM}age=${Math.floor(r.ageMs / 1000)}s models=${r.modelCount} plan=${r.plan ?? "unknown"} api=${r.apiBase}`,
            )
          }
          prompts.log.info(
            `${UI.Style.TEXT_DIM}hits=${cache.hits} misses=${cache.misses} refreshes=${cache.refreshes} swr=${cache.swrRefreshes}`,
          )
        },
      })
      .command({
        command: "clear [account]",
        describe: "invalidate one or all cache entries",
        builder: (y) =>
          y.positional("account", {
            describe: "account key (omit to clear all)",
            type: "string",
          }),
        async handler(args) {
          const cache = ModelsCache.instance()
          const key = typeof args.account === "string" && args.account.length > 0 ? args.account : undefined
          await cache.clear(key)
          prompts.log.success(key ? `cleared cache entry for ${key}` : "cleared all cache entries")
        },
      })
      .command({
        command: "refresh <account>",
        describe: "force a live /models fetch for the given account",
        builder: (y) =>
          y.positional("account", {
            describe: "account key (e.g. github-copilot or github-copilot#edu)",
            type: "string",
            demandOption: true,
          }),
        async handler(args) {
          const key = String(args.account)
          const credentials = await allAuth()
          const info = (credentials as Record<string, { type?: string; refresh?: string; enterpriseUrl?: string }>)[key]
          if (!info || info.type !== "oauth" || !info.refresh) {
            prompts.log.error(`no oauth credential for ${key}`)
            process.exit(1)
          }
          const { base, proxyHeaders } = await import("../../plugin/github-copilot/copilot")
          const state = await readConnections()
          const conn = state.connections[key]
          const apiBase = conn?.discovery?.api ?? base(info!.enterpriseUrl)
          const cfg = conn ? { url: conn.proxyUrl, token: conn.proxyToken, envelope: conn.envelope } : undefined
          const entry = await ModelsCache.instance().refresh(key, {
            apiBase,
            headers: {
              Authorization: `Bearer ${info!.refresh!}`,
              "User-Agent": `opencode/providers-cli`,
              ...proxyHeaders(cfg?.token),
            },
            existing: {},
            proxyUrl: cfg?.url,
            plan: conn?.plan,
            proxy: { token: cfg?.token, envelope: cfg?.envelope },
          })
          prompts.log.success(`refreshed ${key} (${Object.keys(entry.models).length} models)`)
        },
      })
      .demandCommand(),
  async handler() {},
})

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs
      .command(ProvidersListCommand)
      .command(ProvidersLoginCommand)
      .command(ProvidersLogoutCommand)
      .command(ProvidersQuotaCommand)
      .command(ProvidersAccountsCommand)
      .command(ProvidersRouteDebugCommand)
      .command(ProvidersProxyCommand)
      .command(ProvidersExportCommand)
      .command(ProvidersImportCommand)
      .command(ProvidersStatsCommand)
      .command(ProvidersTelemetryCommand)
      .command(ProvidersEnvCommand)
      .command(ProvidersDeactivateCommand)
      .command(ProvidersActivateCommand)
      .command(ProvidersRotateMachineIdCommand)
      .command(ProvidersRotateProxyCommand)
      .command(ProvidersPoolCommand)
      .command(ProvidersAllowedModelsCommand)
      .command(ProvidersTestAccountsCommand)
      .command(ProvidersModelsCacheCommand)
      .demandCommand(),
  async handler() {},
})

/**
 * Render the per-account "best per vendor" pick from cached discovery
 * state. Mirrors the Rust `CopilotModelCatalog::best_per_vendor` display
 * (`github-copilot/src/models.rs:92-161`). Pulls model catalogs from the
 * persisted `connections.json` so we don't trigger live network calls
 * inside `providers list`.
 */
export function renderBestPerVendor(state: State, opts?: { includeDeactivated?: boolean }): string[] {
  const lines: string[] = []
  const showDeactivated = !!opts?.includeDeactivated
  for (const [key, conn] of Object.entries(state.connections)) {
    // Skip suspended / revoked accounts by default — they can't actually
    // route the "best" model anyway.
    if (!showDeactivated && conn.deactivated) continue
    const pool = accountPoolLabel(key, conn.plan)
    const unsupported = new Set(conn.unsupportedModels ?? [])
    // "best" now reflects the POOL ROUTING default, not the raw cached
    // /models probe. For a prod account we'd prefer gpt-5.4-xhigh;
    // claude-4.7-opus-high is the secondary prod option. For an edu
    // account we route codex-5.3-xhigh. Test-only models are shown
    // separately via `Allowed (test-only): …`.
    if (pool) {
      const prodAllowed = poolAllowedProdModels(pool).filter((id) => !unsupported.has(id))
      if (prodAllowed.length === 0) {
        lines.push(`${copilotAliasLabel(key)} ${UI.Style.TEXT_DIM}best (none — pool defaults all marked unsupported)`)
        continue
      }
      const best = prodAllowed[0]
      const option = prodAllowed.slice(1).join(", ")
      const tail = option ? ` (option: ${option})` : ""
      lines.push(`${copilotAliasLabel(key)} ${UI.Style.TEXT_DIM}best ${best}${tail}`)
      continue
    }
    // Unpooled account — fall back to the legacy "best per vendor from
    // cached /models discovery" behaviour so unclassified accounts still
    // render something sensible.
    const catalog = conn.discovery?.models ?? []
    if (catalog.length === 0) continue
    const usable = catalog.filter((id) => !unsupported.has(id))
    if (usable.length === 0) {
      lines.push(`${copilotAliasLabel(key)} ${UI.Style.TEXT_DIM}best (none — all discovered models unsupported)`)
      continue
    }
    const items = usable.map((id) => ({ id }))
    const best = CopilotModels.bestPerVendor(items)
    if (best.length === 0) continue
    const display = best.map((b) => `${b.vendor}=${b.modelId}`).join(", ")
    lines.push(`${copilotAliasLabel(key)} ${UI.Style.TEXT_DIM}best ${display}`)
  }
  return lines
}

export const ProvidersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  async handler(_args) {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(await AppRuntime.runPromise(Auth.Service.use((svc) => svc.all())))
    const database = await ModelsDev.get()

    for (const [providerID, result] of results) {
      const name = copilotAliasName(providerID, database[providerID]?.name)
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    // Per-account best-per-vendor pick from cached Copilot discovery.
    const state = await readConnections()
    for (const line of renderBestPerVendor(state)) {
      prompts.log.info(line)
    }

    prompts.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: copilotAliasName(providerID, provider.name),
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const ProvidersLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: "opencode auth provider",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url) {
          const url = args.url.replace(/\/+$/, "")
          const wellknown = await fetch(`${url}/.well-known/opencode`).then((x) => x.json() as any)
          prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
          const proc = Process.spawn(wellknown.auth.command, {
            stdout: "pipe",
          })
          if (!proc.stdout) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          const [exit, token] = await Promise.all([proc.exited, text(proc.stdout)])
          if (exit !== 0) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          await AppRuntime.runPromise(
            Auth.Service.use((svc) =>
              svc.set(url, {
                type: "wellknown",
                key: wellknown.auth.env,
                token: token.trim(),
              }),
            ),
          )
          prompts.log.success("Logged into " + url)
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh().catch(() => {})

        const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get()))

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ModelsDev.get().then((x) => {
          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return filtered
        })

        const priority: Record<string, number> = {
          opencode: 0,
          openai: 1,
          "github-copilot": 2,
          google: 3,
          anthropic: 4,
          openrouter: 5,
          vercel: 6,
        }
        const pluginProviders = resolvePluginProviders({
          hooks: await AppRuntime.runPromise(Plugin.Service.use((svc) => svc.list())),
          existingProviders: providers,
          disabled,
          enabled,
          providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
        })
        const options = [
          ...pipe(
            providers,
            values(),
            sortBy(
              (x) => priority[x.id] ?? 99,
              (x) => x.name ?? x.id,
            ),
            map((x) => ({
              label: x.name,
              value: x.id,
              hint: {
                opencode: "recommended",
                openai: "ChatGPT Plus/Pro or API key",
              }[x.id],
            })),
          ),
          ...pluginProviders.map((x) => ({
            label: x.name,
            value: x.id,
            hint: "plugin",
          })),
        ]

        let provider: string
        if (args.provider) {
          const input = args.provider
          const byID = options.find((x) => x.value === input)
          const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
          const match = byID ?? byName
          if (!match) {
            prompts.log.error(`Unknown provider "${input}"`)
            process.exit(1)
          }
          provider = match.value
        } else {
          const selected = await prompts.autocomplete({
            message: "Select provider",
            maxItems: 8,
            options: [
              ...options,
              {
                value: "other",
                label: "Other",
              },
            ],
          })
          if (prompts.isCancel(selected)) throw new UI.CancelledError()
          provider = selected as string
        }

        const plugin = await AppRuntime.runPromise(Plugin.Service.use((svc) => svc.list())).then((x) =>
          x.findLast((x) => x.auth?.provider === provider),
        )
        if (plugin && plugin.auth) {
          const handled = await handlePluginAuth({ auth: plugin.auth }, provider, args.method)
          if (handled) return
        }

        if (provider === "other") {
          const custom = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(custom)) throw new UI.CancelledError()
          provider = custom.replace(/^@ai-sdk\//, "")

          const customPlugin = await AppRuntime.runPromise(Plugin.Service.use((svc) => svc.list())).then((x) =>
            x.findLast((x) => x.auth?.provider === provider),
          )
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider, args.method)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in opencode.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
              "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
              "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
              "Configure via opencode.json options (profile, region, endpoint) or\n" +
              "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
          )
        }

        if (provider === "opencode") {
          prompts.log.info("Create an api key at https://opencode.ai/auth")
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await AppRuntime.runPromise(
          Auth.Service.use((svc) =>
            svc.set(provider, {
              type: "api",
              key,
            }),
          ),
        )

        prompts.outro("Done")
      },
    })
  },
})

export const ProvidersLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler(_args) {
    UI.empty()
    const credentials = await AppRuntime.runPromise(Auth.Service.use((svc) => svc.all())).then((x) =>
      Object.entries(x),
    )
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ModelsDev.get()
    const providerID = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: copilotAliasName(key, database[key]?.name) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(providerID)) throw new UI.CancelledError()
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove(providerID)))
    prompts.outro("Logout successful")
  },
})

export const ProvidersQuotaCommand = cmd({
  command: "quota",
  describe: "show GitHub Copilot quota for all configured accounts",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "output account overview as json" }),
  async handler(args) {
    UI.empty()
    prompts.intro("GitHub Copilot Quota")

    const { accounts, items } = await loadAccountStatuses()
    const migration = resolveMigrationSummary(accounts.length > 0)

    if (accounts.length === 0) {
      prompts.log.error("No GitHub Copilot accounts configured. Run: opencode providers login")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
            migration: jsonMigration(migration),
            items: items.map((item) => ({
              schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
              ...item,
              status: jsonStatus(item.status),
            })),
          },
          null,
          2,
        ) + "\n",
      )
      return
    }

    prompts.log.info(`Migration: ${migration.text}`)
    if (migration.source) prompts.log.info(`Migration source: ${migration.source}`)
    if (migration.migratedAt) prompts.log.info(`Migration at: ${new Date(migration.migratedAt).toISOString()}`)
    for (const item of items) {
      const text = renderAccountStatus(item.status, { premium: item.premium, enterpriseUrl: item.info.enterpriseUrl })
      if (item.status.error && item.status.health !== "ok") prompts.log.error(text)
      else prompts.log.info(text)
    }
    prompts.outro(`${accounts.length} account${accounts.length === 1 ? "" : "s"}`)
  },
})

/**
 * Probe each Copilot account in parallel and bucket into
 * healthy / deactivated / rateLimited / networkError. Mirrors the Rust
 * `check_account_statuses` triage (`lib.rs:212-264`) and powers the
 * `providers accounts --json` envelope so external tooling can read
 * account health without scraping human output.
 */
export async function loadAccountHealth(): Promise<AccountStatusInfo[]> {
  const credentials = await allAuth()
  const accounts = quotaAccounts(
    credentials as Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
  )
  const state = await readConnections()
  const auths = accounts.map(([key, info]) => ({
    key,
    label: copilotAliasLabel(key),
    refresh: info.refresh || "",
    access: (info as any).access || info.refresh || "",
    expires: (info as any).expires || 0,
    enterpriseUrl: info.enterpriseUrl,
  }))
  return checkAccountStatuses({ auths, state })
}

export const ProvidersAccountsCommand = cmd({
  command: "accounts",
  describe: "show GitHub Copilot account overview",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", describe: "output account overview as json" })
      .option("all", {
        type: "boolean",
        describe: "include deactivated (suspended / revoked) accounts — default: hide them",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("GitHub Copilot Accounts")
    const { accounts, items: allItems, state } = await loadAccountStatuses()
    const includeDeactivated = !!(args as { all?: boolean }).all
    const items = includeDeactivated
      ? allItems
      : allItems.filter((it) => it.status.health !== "deactivated")
    const hiddenCount = allItems.length - items.length
    const migration = resolveMigrationSummary(accounts.length > 0)
    if (accounts.length === 0) {
      prompts.log.error("No GitHub Copilot accounts configured. Run: opencode providers login")
      prompts.outro("Done")
      return
    }
    if (args.json) {
      // Augment legacy `items` with the Rust-parity `health` triage.
      const auths = accounts.map(([key, info]) => ({
        key,
        label: copilotAliasLabel(key),
        refresh: info.refresh || "",
        access: (info as any).access || info.refresh || "",
        expires: (info as any).expires || 0,
        enterpriseUrl: info.enterpriseUrl,
      }))
      const triage = await checkAccountStatuses({ auths, state })
      const healthByKey = new Map(triage.map((h) => [h.key, h] as const))
      const bestPerVendor = Object.fromEntries(
        Object.entries(state.connections)
          .map(([key, conn]) => {
            const catalog = conn.discovery?.models ?? []
            if (catalog.length === 0) return [key, null] as const
            const best = CopilotModels.bestPerVendor(catalog.map((id) => ({ id })))
            return [key, best.length > 0 ? best : null] as const
          })
          .filter(([, v]) => v !== null),
      )
      process.stdout.write(
        JSON.stringify(
          {
            schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
            migration: jsonMigration(migration),
            health: triage,
            bestPerVendor,
            items: items.map((item) => ({
              schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
              ...item,
              status: jsonStatus(item.status),
              triage: healthByKey.get(item.status.key) ?? null,
            })),
          },
          null,
          2,
        ) + "\n",
      )
      return
    }
    for (const item of items) {
      const text = renderAccountStatus(item.status, { premium: item.premium, enterpriseUrl: item.info.enterpriseUrl })
      if (item.status.error && item.status.health !== "ok") prompts.log.error(text)
      else prompts.log.info(text)
    }
    // Render best-per-vendor pick when discovery data is available.
    for (const line of renderBestPerVendor(state, { includeDeactivated })) {
      prompts.log.info(line)
    }
    const tail = hiddenCount > 0
      ? ` (${hiddenCount} deactivated hidden — pass --all to show)`
      : ""
    prompts.outro(`${items.length} account${items.length === 1 ? "" : "s"}${tail}`)
  },
})

export const ProvidersRouteDebugCommand = cmd({
  command: "route-debug [model]",
  describe: "show GitHub Copilot routing candidates for a model",
  builder: (yargs) =>
    yargs
      .positional("model", { type: "string", describe: "model id to explain (omit with --all-models for full dump)" })
      .option("provider", { type: "string", describe: "restrict to this provider id (e.g. github-copilot)" })
      .option("account", { type: "string", describe: "restrict to a specific account key" })
      .option("all-accounts", { type: "boolean", describe: "include deactivated / suspended accounts in the explanation" })
      .option("all-models", { type: "boolean", describe: "explain every known model instead of a single one" })
      .option("summary-only", { type: "boolean", describe: "print only the aggregate summary block (use with --json)" })
      .option("json", { type: "boolean", describe: "emit routing explanation as JSON" }),
  handler: async (args) => {
    const data = await loadRouteExplain({
      model: args.model,
      providerID: args.provider,
      account: args.account,
      allAccounts: args.allAccounts,
      allModels: args.allModels,
    })
    if (args.json) {
      const body =
        args.summaryOnly && "summary" in data ? { schemaVersion: data.schemaVersion, summary: data.summary } : data
      process.stdout.write(JSON.stringify(body, null, 2) + "\n")
      return
    }
    if ("models" in data) {
      prompts.intro("Route debug for multiple models")
      prompts.log.info(`Selected: ${data.summary.selectedCount}`)
      prompts.log.info(`Rejected by lane: ${data.summary.rejectedByLane}`)
      prompts.log.info(`Rejected by penalty: ${data.summary.rejectedByPenalty}`)
      prompts.log.info(`Rejected by discovery: ${data.summary.rejectedByDiscovery}`)
      for (const [key, value] of Object.entries(data.summary.wins)) prompts.log.info(`Wins ${key}: ${value}`)
      for (const block of data.models) {
        prompts.log.info(`Model: ${block.model}`)
        if (block.selected) prompts.log.info(`Selected: ${block.selected}`)
        for (const item of block.candidates) {
          prompts.log.info(
            `${item.key} | discovery=${item.discovery} penalty=${item.penalty} | ${item.routeReason.join(", ") || "no-signals"}`,
          )
        }
      }
    } else {
      prompts.intro(`Route debug for ${data.model}`)
      if (data.providerID) prompts.log.info(`Provider: ${data.providerID}`)
      if (data.account) prompts.log.info(`Account: ${data.account}`)
      if (data.selected) prompts.log.info(`Selected: ${data.selected}`)
      for (const item of data.candidates) {
        prompts.log.info(
          `${item.key} | discovery=${item.discovery} penalty=${item.penalty} | ${item.routeReason.join(", ") || "no-signals"}`,
        )
      }
    }
    prompts.outro("Done")
  },
})

export const ProvidersProxyCommand = cmd({
  command: "proxy",
  describe: "configure GitHub Copilot proxy for a specific account",
  builder: (yargs) =>
    yargs
      .option("provider", { type: "string", describe: "provider/account key" })
      .option("url", { type: "string", describe: "proxy base url" })
      .option("token", { type: "string", describe: "proxy token" })
      .option("list", { type: "boolean", describe: "show current proxy config" }),
  async handler(args) {
    UI.empty()
    prompts.intro("GitHub Copilot Proxy")

    const credentials = await allAuth()
    const accounts = quotaAccounts(
      credentials as Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
    )

    if (accounts.length === 0) {
      prompts.log.error("No GitHub Copilot accounts configured. Run: opencode providers login")
      prompts.outro("Done")
      return
    }

    if (args.list) {
      const state = await readConnections()
      for (const item of proxyList(state, accounts)) {
        const detail = item.url ? `${item.url}${item.token ? " (token set)" : ""}` : "direct (no proxy)"
        prompts.log.info(`${item.label} ${UI.Style.TEXT_DIM}${detail}`)
      }
      prompts.outro(`${accounts.length} account${accounts.length === 1 ? "" : "s"}`)
      return
    }

    const key =
      args.provider ||
      (await prompts.select({
        message: "Account",
        options: accounts.map(([item]) => ({
          label: copilotAliasLabel(item),
          value: item,
        })),
      }))

    if (prompts.isCancel(key)) throw new UI.CancelledError()

    const url =
      args.url ??
      (await prompts.text({
        message: "Proxy URL (leave blank to clear)",
        placeholder: "https://gcp-proxy.example",
      }))

    if (prompts.isCancel(url)) throw new UI.CancelledError()

    const trimmed = url.trim()
    const token =
      args.token ??
      (trimmed
        ? await prompts.text({
            message: "Proxy token (optional)",
            placeholder: "token",
          })
        : "")

    if (prompts.isCancel(token)) throw new UI.CancelledError()

    const next = await saveProxy(key, trimmed || undefined, token?.trim() || undefined)
    const cfg = next.connections[key]
    prompts.log.success(
      cfg?.proxyUrl
        ? `Saved proxy for ${copilotAliasLabel(key)} -> ${cfg.proxyUrl}`
        : `Cleared proxy for ${copilotAliasLabel(key)}`,
    )
    prompts.outro("Done")
  },
})

/**
 * Export every configured GitHub Copilot account + connection state
 * into a portable JSON bundle. See
 * `packages/opencode/src/plugin/github-copilot/transfer.ts` for the
 * schema and redaction semantics.
 */
export const ProvidersExportCommand = cmd({
  command: "export",
  describe: "export GitHub Copilot accounts as a portable JSON bundle",
  builder: (yargs) =>
    yargs
      .option("out", {
        type: "string",
        describe: "write bundle to this file (default: stdout)",
      })
      .option("redact-tokens", {
        type: "boolean",
        describe: "omit refresh tokens and proxy tokens from the bundle",
      })
      .option("plain", {
        type: "boolean",
        describe: "emit raw JSON (default)",
      })
      .option("base64", {
        type: "boolean",
        describe: "wrap the JSON in a base64 envelope for clipboard-safe sharing",
      })
      .option("exported-by", {
        type: "string",
        describe: "free-form label recorded in the bundle (e.g. hostname)",
      }),
  async handler(args) {
    if (args.plain && args.base64) {
      process.stderr.write("error: --plain and --base64 are mutually exclusive\n")
      process.exit(1)
    }
    const bundle = await AppRuntime.runPromise(
      exportBundleEffect({
        redactTokens: !!args.redactTokens,
        exportedBy: args.exportedBy,
      }),
    )
    const json = JSON.stringify(bundle, null, 2)
    const payload = args.base64 ? Buffer.from(json, "utf8").toString("base64") + "\n" : json + "\n"
    if (args.out) {
      await Bun.write(args.out, payload)
      process.stderr.write(
        `wrote ${bundle.accounts.length} account${bundle.accounts.length === 1 ? "" : "s"} to ${args.out}${bundle.redacted ? " (redacted)" : ""}\n`,
      )
      return
    }
    process.stdout.write(payload)
  },
})

/**
 * Import a Copilot transfer bundle previously produced by
 * `providers export`. Merges by default; `--replace` wipes existing
 * `github-copilot*` entries first; `--dry-run` reports what would
 * change without touching disk.
 */
export const ProvidersImportCommand = cmd({
  command: "import <path>",
  describe: "import a GitHub Copilot transfer bundle",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "path to bundle JSON (or '-' for stdin)",
        demandOption: true,
      })
      .option("merge", {
        type: "boolean",
        describe: "merge into existing accounts (default)",
      })
      .option("replace", {
        type: "boolean",
        describe: "replace existing Copilot accounts before import",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would change without writing",
      })
      .option("json", {
        type: "boolean",
        describe: "emit import result as JSON",
      }),
  async handler(args) {
    if (args.merge && args.replace) {
      process.stderr.write("error: --merge and --replace are mutually exclusive\n")
      process.exit(1)
    }
    const mode: "merge" | "replace" = args.replace ? "replace" : "merge"
    let raw: string
    if (args.path === "-") {
      raw = await text(process.stdin)
    } else {
      raw = await Bun.file(args.path as string).text()
    }
    // Permit a base64-wrapped bundle for symmetry with `--base64` export.
    const trimmed = raw.trim()
    if (trimmed.length > 0 && trimmed[0] !== "{") {
      try {
        raw = Buffer.from(trimmed, "base64").toString("utf8")
      } catch {
        // fall through; parseBundle will reject.
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      process.stderr.write(`error: invalid JSON in bundle (${(err as Error).message})\n`)
      process.exit(1)
    }
    let bundle
    try {
      bundle = parseBundle(parsed)
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`)
      process.exit(1)
    }
    const result = await AppRuntime.runPromise(
      importBundleEffect(bundle, { mode, dryRun: !!args.dryRun }),
    )
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ schemaVersion: BUNDLE_VERSION, ...result }, null, 2) + "\n",
      )
      return
    }
    UI.empty()
    prompts.intro(`Import Copilot bundle${result.dryRun ? " (dry run)" : ""}`)
    prompts.log.info(`mode: ${result.mode}`)
    if (result.added.length > 0) prompts.log.success(`added: ${result.added.join(", ")}`)
    if (result.updated.length > 0) prompts.log.info(`updated: ${result.updated.join(", ")}`)
    if (result.removed.length > 0) prompts.log.info(`removed: ${result.removed.join(", ")}`)
    if (result.skipped.length > 0) prompts.log.warn(`skipped: ${result.skipped.join(", ")}`)
    prompts.outro(result.dryRun ? "no changes written" : "Done")
  },
})

/**
 * Assemble the unified stats payload shared by the CLI and HTTP endpoint.
 * Loads persistent rate-state rows from SQLite and the connections.json
 * plan / deactivated flags so operators can see a full cross-account
 * picture in one call.
 */
export async function loadProvidersStats(opts: {
  sinceMs?: number
  now?: number
} = {}): Promise<AggregateStats> {
  const [rateRows, connections] = await Promise.all([
    loadPersistedRateRows().catch(() => []),
    readConnections().catch(() => empty()),
  ])
  return CopilotStats.aggregate({
    sinceMs: opts.sinceMs,
    now: opts.now,
    rateRows,
    connections,
  })
}

export const ProvidersStatsCommand = cmd({
  command: "stats",
  describe: "show per-account dispatch / 429 / premium stats for GitHub Copilot",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", describe: "emit raw aggregate JSON" })
      .option("since", {
        type: "string",
        describe: "time window to report (e.g. 10m, 1h, 24h). Default: since boot.",
      }),
  async handler(args) {
    const rawSince = (args as { since?: string }).since
    const sinceMs = parseDuration(rawSince)
    if (rawSince !== undefined && sinceMs === undefined) {
      process.stderr.write(`error: invalid --since value "${rawSince}" (try 10m, 1h, 24h)\n`)
      process.exit(1)
    }
    const payload = await loadProvidersStats({ sinceMs })
    if ((args as { json?: boolean }).json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n")
      return
    }
    UI.empty()
    prompts.intro("GitHub Copilot Stats")
    const lines = renderStatsText(payload)
    for (const line of lines) {
      if (line === "") continue
      prompts.log.info(line)
    }
    prompts.outro(`${payload.totals.accounts} account${payload.totals.accounts === 1 ? "" : "s"}`)
  },
})

/**
 * `providers telemetry` — live-tail or JSON-dump the in-memory OTEL
 * ring buffer populated by `packages/opencode/src/plugin/github-copilot/telemetry.ts`.
 * Parallel to `providers stats` — both surfaces observability, but
 * telemetry captures per-HTTP / per-SSE samples with OTEL-style tags
 * (`account_key`, `model`, `pool`, `status_code`) rather than aggregate
 * rollups.
 *
 * Two modes:
 *   --json         dump the current buffer as JSON (no follow)
 *   --tail [N]     print the last N records (default 20) then follow
 *                  live additions; 500ms poll
 *
 * The ring buffer is always populated regardless of whether the OTLP
 * exporter is enabled, so local debugging never requires a collector.
 */
export const ProvidersTelemetryCommand = cmd({
  command: "telemetry",
  describe: "tail or dump the Copilot dispatch OTEL telemetry ring buffer",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", describe: "dump the current buffer as JSON" })
      .option("tail", {
        type: "number",
        describe: "print last N records then follow live additions (default 20)",
      })
      .option("since", {
        type: "string",
        describe: "time window to include when printing (e.g. 10m, 1h). Default: full buffer.",
      })
      .option("limit", {
        type: "number",
        describe: "max records to include in --json output (default: full buffer)",
      }),
  async handler(args) {
    const { getCopilotTelemetry } = await import("../../plugin/github-copilot/telemetry")
    const telemetry = getCopilotTelemetry()
    const rawSince = (args as { since?: string }).since
    const sinceMs = parseDuration(rawSince)
    if (rawSince !== undefined && sinceMs === undefined) {
      process.stderr.write(`error: invalid --since value "${rawSince}" (try 10m, 1h, 24h)\n`)
      process.exit(1)
    }
    const now = Date.now()
    const cutoff = sinceMs !== undefined ? now - sinceMs : undefined
    const full = telemetry.snapshot()
    const windowed = cutoff !== undefined ? full.filter((r) => r.at >= cutoff) : full

    if ((args as { json?: boolean }).json) {
      const limit = (args as { limit?: number }).limit
      const out = limit !== undefined && limit > 0 ? windowed.slice(Math.max(0, windowed.length - limit)) : windowed
      process.stdout.write(
        JSON.stringify(
          {
            generatedAt: now,
            config: {
              enabled: telemetry.config.enabled,
              endpoint: telemetry.config.endpoint ?? null,
              bufferCap: telemetry.config.bufferCap ?? null,
            },
            windowMs: sinceMs ?? null,
            count: out.length,
            records: out,
          },
          null,
          2,
        ) + "\n",
      )
      return
    }

    const tailRaw = (args as { tail?: number }).tail
    const tailN = tailRaw === undefined ? 20 : tailRaw
    const follow = tailRaw !== undefined
    const initial = windowed.slice(Math.max(0, windowed.length - tailN))

    UI.empty()
    prompts.intro("GitHub Copilot telemetry")
    prompts.log.info(
      `exporter=${telemetry.config.enabled ? "enabled" : "disabled"} endpoint=${telemetry.config.endpoint ?? "none"} buffered=${full.length}`,
    )
    for (const record of initial) prompts.log.info(formatTelemetryRecord(record, now))

    if (!follow) {
      prompts.outro(`${initial.length} record${initial.length === 1 ? "" : "s"}`)
      return
    }

    // Live-follow: poll the ring every 500ms, diff against the last seen
    // record's `at` stamp, print new entries.
    let cursor = initial.length > 0 ? initial[initial.length - 1]!.at : 0
    let running = true
    const stop = () => {
      running = false
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      while (running) {
        await new Promise((r) => setTimeout(r, 500))
        const next = telemetry.snapshot().filter((r) => r.at > cursor)
        for (const record of next) {
          prompts.log.info(formatTelemetryRecord(record, Date.now()))
          cursor = record.at
        }
      }
    } finally {
      prompts.outro("follow ended")
    }
  },
})

function formatTelemetryRecord(
  record: {
    at: number
    kind: string
    account_key?: string
    model?: string
    pool?: string
    status?: number
    durationMs?: number
    success?: boolean
    sseKind?: string
    inputTokens?: number
    outputTokens?: number
    cost?: number
    tool?: string
  },
  now: number,
): string {
  const ts = new Date(record.at).toISOString().replace("T", " ").replace("Z", "")
  const age = Math.max(0, now - record.at)
  const ago = age < 1000 ? `${age}ms` : `${Math.round(age / 1000)}s`
  const parts: string[] = [ts, record.kind]
  if (record.account_key) parts.push(`key=${record.account_key}`)
  if (record.model) parts.push(`model=${record.model}`)
  if (record.pool) parts.push(`pool=${record.pool}`)
  if (record.status !== undefined) parts.push(`status=${record.status}`)
  if (record.durationMs !== undefined) parts.push(`dur=${record.durationMs}ms`)
  if (record.sseKind) parts.push(`sse=${record.sseKind}`)
  if (record.success !== undefined) parts.push(`ok=${record.success}`)
  if (record.inputTokens !== undefined) parts.push(`in=${record.inputTokens}`)
  if (record.outputTokens !== undefined) parts.push(`out=${record.outputTokens}`)
  if (record.cost !== undefined) parts.push(`cost=${record.cost}`)
  if (record.tool) parts.push(`tool=${record.tool}`)
  parts.push(`(${ago} ago)`)
  return parts.join(" ")
}

/**
 * Table of all `OPENCODE_*` environment variables that influence the
 * GitHub Copilot integration. Used by `providers env` to print a
 * self-documenting list so operators can discover knobs without
 * grepping the source tree. When a new env var is wired up, add it
 * here alongside the feature toggle so the CLI help stays current.
 */
export const COPILOT_ENV_VARS: ReadonlyArray<{
  name: string
  description: string
  defaultValue?: string
}> = [
  {
    name: "OPENCODE_TEST_COPILOT_TOKENS",
    description:
      "Comma-separated list of Copilot OAuth tokens (ghu_...) injected as synthetic `github-copilot#edu-N` test accounts at boot. Ignored unless OPENCODE_ALLOW_TEST_ACCOUNTS=1.",
  },
  {
    name: "OPENCODE_ALLOW_TEST_ACCOUNTS",
    description:
      "When `1`, un-filter test accounts (both config-derived and env-derived) from the production routing pool so they receive real traffic.",
    defaultValue: "0",
  },
  {
    name: "OPENCODE_IMPORT_ALL_COPILOT_TOKENS",
    description:
      "When `1`, migrate() imports EVERY token discovered in ~/.config/github-copilot/apps.json instead of just the primary — useful for multi-account setups.",
    defaultValue: "0",
  },
  {
    name: "OPENCODE_COPILOT_PROXY_ENVELOPE",
    description:
      "When `1`, proxied Copilot dispatches use the POST {proxy}/fetch JSON envelope protocol instead of raw HTTP forward. Also toggled per-account via `providers proxy --envelope`.",
    defaultValue: "0",
  },
  {
    name: "OPENCODE_PROBE_DISCOVERY",
    description:
      "Set to `0` to disable the lazy /models discovery probe that runs on first dispatch for each account. Default: enabled.",
    defaultValue: "1",
  },
  {
    name: "OPENCODE_EAGER_COPILOT_DISCOVERY",
    description:
      "When `1` (default), `CopilotAuthPlugin` boot kicks off a parallel quota + /models fan-out (Promise.allSettled across all Copilot accounts) so the first `/turn/start` hits warmed discovery caches. Set to `0` to defer discovery until a request path triggers it (mirrors the pre-fan-out lazy behavior).",
    defaultValue: "1",
  },
  {
    name: "OPENCODE_DEBUG_PROVIDERS",
    description: "When `1`, emit verbose provider routing + dispatch decisions to stderr.",
    defaultValue: "0",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_ENABLED",
    description:
      "Toggle the adaptive per-account rate limiter. When false, dispatch bypasses the 429-sliding-window semaphore. Default: true.",
    defaultValue: "true",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_WINDOW_MS",
    description: "Sliding window (ms) for counting recent 429 errors per account. Default 600000 (10m).",
    defaultValue: "600000",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_CLEAN_MS",
    description:
      "Duration (ms) an account must stay below the 429 threshold before capacity regrows. Default 300000 (5m).",
    defaultValue: "300000",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_THRESHOLD",
    description: "Per-minute 429 rate that triggers a shrink. Default 0.2.",
    defaultValue: "0.2",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_MAX",
    description: "Maximum per-account concurrency ceiling. Default 7.",
    defaultValue: "7",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_MIN",
    description: "Minimum per-account concurrency floor (shrink bottom). Default 1.",
    defaultValue: "1",
  },
  {
    name: "OPENCODE_COPILOT_RATE_LIMITER_ACQUIRE_TIMEOUT_MS",
    description: "Max time (ms) a dispatch will wait on acquire() before giving up. Default 30000.",
    defaultValue: "30000",
  },
  {
    name: "OPENCODE_COPILOT_TELEMETRY_ENABLED",
    description:
      "Enable OTEL/OTLP export for the Copilot dispatch pipeline. When true, per-request and per-SSE metrics are exported via OTLP/HTTP (see ENDPOINT). When unset, auto-enables iff an endpoint is present. Default auto.",
  },
  {
    name: "OPENCODE_COPILOT_TELEMETRY_ENDPOINT",
    description:
      "OTLP/HTTP metrics collector URL (e.g. http://localhost:4318/v1/metrics). Overrides config `copilot.telemetry.endpoint`. Falls back to `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`.",
  },
  {
    name: "OPENCODE_COPILOT_TELEMETRY_BUFFER",
    description: "In-memory telemetry ring buffer capacity (records). Default 2048.",
    defaultValue: "2048",
  },
  {
    name: "OPENCODE_COPILOT_TELEMETRY_EXPORT_INTERVAL_MS",
    description: "OTLP PeriodicExportingMetricReader interval (ms). Default 15000.",
    defaultValue: "15000",
  },
]

export const ProvidersEnvCommand = cmd({
  command: "env",
  describe: "list OPENCODE_* environment variables that affect GitHub Copilot routing",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", describe: "emit the env-var table as JSON" })
      .option("set-only", {
        type: "boolean",
        describe: "only show variables currently set in the environment",
      }),
  async handler(args) {
    const rows = COPILOT_ENV_VARS.map((row) => ({
      name: row.name,
      description: row.description,
      default: row.defaultValue ?? null,
      current: process.env[row.name] ?? null,
    }))
    const filtered = (args as { setOnly?: boolean }).setOnly ? rows.filter((r) => r.current !== null) : rows
    if ((args as { json?: boolean }).json) {
      process.stdout.write(JSON.stringify(filtered, null, 2) + "\n")
      return
    }
    UI.empty()
    prompts.intro("GitHub Copilot environment variables")
    if (filtered.length === 0) {
      prompts.log.info("no OPENCODE_* copilot env vars currently set")
      prompts.outro("Done")
      return
    }
    for (const row of filtered) {
      const setMarker = row.current !== null ? ` ${UI.Style.TEXT_DIM}(set=${row.current})` : ""
      const defaultMarker = row.default !== null ? ` ${UI.Style.TEXT_DIM}[default=${row.default}]` : ""
      prompts.log.info(`${row.name}${setMarker}${defaultMarker}`)
      prompts.log.info(`  ${UI.Style.TEXT_DIM}${row.description}`)
    }
    prompts.outro(`${filtered.length} variable${filtered.length === 1 ? "" : "s"}`)
  },
})
