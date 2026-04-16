import { Auth } from "../../auth"
import { AppRuntime } from "../../effect/app-runtime"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider/models"
import { classifyPlan, fetchQuota, formatQuotaBar, type Quota } from "../../plugin/github-copilot/quota"
import { summarizeMigration } from "../../plugin/github-copilot/auth"
import { connectionFile } from "../../plugin/github-copilot/paths"
import { CopilotRuntimeState } from "../../plugin/github-copilot/copilot"
import { policyPlan, recent429, recentDiscoveryError, routeDebug, score } from "../../plugin/github-copilot/copilot"
import { Store, StateSchema, empty, type State } from "../../plugin/github-copilot/connections"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import type { Hooks } from "@opencode-ai/plugin"
import { Process } from "../../util/process"
import { text } from "node:stream/consumers"
import { Effect } from "effect"

type PluginAuth = NonNullable<Hooks["auth"]>

export async function allAuth() {
  if ((Auth as any).all) return (Auth as any).all()
  return AppRuntime.runPromise(Auth.Service.use((auth) => auth.all()))
}

async function readConnections() {
  const raw = await Bun.file(connectionFile).json().catch(() => empty())
  const parsed = StateSchema.zod.safeParse(raw)
  return parsed.success ? parsed.data : empty()
}

const put = (key: string, info: Auth.Info) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(key, info)
    }),
  )

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
          await put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await put(saveProvider, {
            type: "api",
            key: result.key,
          })
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
          await put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await put(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const key = await prompts.password({
        message: "Enter your API key",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(key)) throw new UI.CancelledError()

      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await put(saveProvider, {
          type: "api",
          key: result.key ?? key,
        })
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

export function quotaAccounts(credentials: Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>) {
  return Object.entries(credentials).filter(([key, info]) => key.startsWith("github-copilot") && info.type === "oauth")
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
  candidates: import("../../plugin/github-copilot/copilot").RouteDebug[]
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
  proxy: boolean
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

export function jsonMigration(input: ReturnType<typeof summarizeMigration>): MigrationJSON {
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

export function jsonStatus(input: ReturnType<typeof accountStatus> & { premium?: string; ghe?: string }): AccountStatusJSON {
  return {
    key: input.key,
    label: input.label,
    login: input.login ?? null,
    plan: input.plan ?? null,
    proxy: input.proxy,
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
  const extra = [
    status.proxy ? "proxy on" : "direct",
    status.exhausted ? "cooldown" : undefined,
    input?.enterpriseUrl ? `ghe ${input.enterpriseUrl}` : undefined,
    status.discovery?.stale ? "discovery stale" : status.discovery ? "discovery fresh" : undefined,
  ]
    .filter(Boolean)
    .join(", ")
  return `${status.label} ${UI.Style.TEXT_DIM}${extra}
  Login: ${status.login ?? "unknown"}
  Plan: ${status.plan ?? "unknown"}
  Health: ${status.health}
  Discovery: ${status.discovery ? `${status.discovery.ok ? "ok" : "error"}${status.discovery.models?.length ? `, ${status.discovery.models.length} models` : ""}${status.discovery.err ? `, ${status.discovery.err}` : ""}` : "unknown"}${
    input?.premium
      ? `
  Premium: ${input.premium}`
      : ""
  }`
}

export async function loadAccountStatuses() {
  const credentials = await allAuth()
  const accounts = quotaAccounts(
    credentials as Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
  )
  const state = await readConnections()
  const items = await Promise.all(
    accounts.map(async ([key, info]) => {
      try {
        const quota = await fetchQuota(
          info.refresh || "",
          info.enterpriseUrl,
          state.connections[key]?.proxyUrl
            ? {
                url: state.connections[key]?.proxyUrl,
                token: state.connections[key]?.proxyToken,
              }
            : undefined,
        )
        return {
          info,
          status: accountStatus({ key, state, quota }),
          premium: quota.premium ? formatQuotaBar(quota.premium, quota.resetDate) : "no quota info available",
          ghe: info.enterpriseUrl ?? null,
        }
      } catch (err) {
        return {
          info,
          status: accountStatus({ key, state, quotaError: err instanceof Error ? err.message : String(err) }),
          premium: undefined,
          ghe: info.enterpriseUrl ?? null,
        }
      }
    }),
  )
  return { accounts, state, items }
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
    schemaVersion: 1,
    model: input.model,
    providerID: input.providerID ?? null,
    account: input.account ?? null,
    selected,
    candidates,
  } satisfies RouteDebugJSON
}

export async function loadRouteExplain(input: {
  model?: string
  models?: string[]
  providerID?: string
  account?: string
  allModels?: boolean
  allAccounts?: boolean
}) {
  const models = input.allModels
    ? ["gpt-5-mini", "gpt-4.1", "gpt-5-enterprise", "gpt-4.1-edu"]
    : [input.model || "gpt-5-mini"]
  const data = await Promise.all(
    models.map((model) =>
      loadRouteDebug({ model, providerID: input.providerID, account: input.allAccounts ? undefined : input.account }),
    ),
  )
  if (input.allModels)
    return { schemaVersion: 1, summary: routeSummary(data), models: data }
  return data[0]
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
      .demandCommand(),
  async handler() {},
})

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
    const results = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return Object.entries(yield* auth.all())
      }),
    )
    const database = await ModelsDev.get()

    for (const [providerID, result] of results) {
      const name = copilotAliasName(providerID, database[providerID]?.name)
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
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
          await put(url, {
            type: "wellknown",
            key: wellknown.auth.env,
            token: token.trim(),
          })
          prompts.log.success("Logged into " + url)
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh(true).catch(() => {})

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
        const hooks = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            return yield* plugin.list()
          }),
        )

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
          hooks,
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

        const plugin = hooks.findLast((x) => x.auth?.provider === provider)
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

          const customPlugin = hooks.findLast((x) => x.auth?.provider === provider)
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
        await put(provider, {
          type: "api",
          key,
        })

        prompts.outro("Done")
      },
    })
  },
})

export const ProvidersQuotaCommand = cmd({
  command: "quota",
  describe: "show GitHub Copilot quota for all configured accounts",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "output account overview as json" }),
  async handler(args) {
    UI.empty()
    prompts.intro("GitHub Copilot Quota")

    const { accounts, items, state } = await loadAccountStatuses()
    const migration = CopilotRuntimeState.migrationSummary() ?? summarizeMigration({ version: 1, keys: [] })

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

export const ProvidersAccountsCommand = cmd({
  command: "accounts",
  describe: "show GitHub Copilot account overview",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "output account overview as json" }),
  async handler(args) {
    UI.empty()
    prompts.intro("GitHub Copilot Accounts")
    const { accounts, items, state } = await loadAccountStatuses()
    const migration = CopilotRuntimeState.migrationSummary() ?? summarizeMigration({ version: 1, keys: [] })
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
    for (const item of items) {
      const text = renderAccountStatus(item.status, { premium: item.premium, enterpriseUrl: item.info.enterpriseUrl })
      if (item.status.error && item.status.health !== "ok") prompts.log.error(text)
      else prompts.log.info(text)
    }
    prompts.outro(`${accounts.length} account${accounts.length === 1 ? "" : "s"}`)
  },
})

export const ProvidersRouteDebugCommand = cmd({
  command: "route-debug [model]",
  describe: "Show GitHub Copilot routing candidates for a model",
  builder: (yargs) =>
    yargs
      .positional("model", { type: "string" })
      .option("provider", { type: "string" })
      .option("account", { type: "string" })
      .option("all-accounts", { type: "boolean" })
      .option("all-models", { type: "boolean" })
      .option("summary-only", { type: "boolean" })
      .option("json", { type: "boolean" }),
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

export const ProvidersLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler(_args) {
    UI.empty()
    const credentials: Array<[string, Auth.Info]> = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return Object.entries(yield* auth.all())
      }),
    )
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ModelsDev.get()
    const selected = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: copilotAliasName(key, database[key]?.name) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(selected)) throw new UI.CancelledError()
    const providerID = selected as string
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove(providerID)
      }),
    )
    prompts.outro("Logout successful")
  },
})

export async function saveProxy(key: string, proxyUrl?: string, proxyToken?: string) {
  const raw = await Bun.file(connectionFile).json().catch(() => empty())
  const parsed = StateSchema.zod.safeParse(raw)
  const state = parsed.success ? parsed.data : empty()
  const next = applyProxy(state, key, { proxyUrl, proxyToken })
  await Bun.write(connectionFile, JSON.stringify(next, null, 2))
  return next
}

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
