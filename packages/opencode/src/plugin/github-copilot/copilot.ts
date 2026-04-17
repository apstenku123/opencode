import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@/installation/version"
import { iife } from "@/util/iife"
import { Log } from "../../util"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect } from "effect"
import { CopilotModels } from "./models"
import {
  cooldown,
  eligible,
  feed,
  load,
  owner,
  record429,
  recordSuccess,
  reserve,
  reserveBatch,
  touch,
  usage,
  type Event,
  type Runtime,
} from "./runtime"
import { classifyPlan, fetchQuota } from "./quota"
import { MessageV2 } from "@/session/message-v2"
import { Auth } from "@/auth"
import { Config } from "@/config"
// NOTE: AppRuntime is lazy-loaded inside CopilotAuthPlugin to avoid a
// module-init cycle (message-v2 → @/provider → plugin/index → this file →
// app-runtime → prompt.ts, which then reads MessageV2.* before it's populated).
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { list, migrate, outcome as migrationOutcome, summarizeMigration, type CopilotAuth } from "./auth"
import {
  Store,
  byPlan,
  clear,
  discover,
  empty,
  hasModel,
  rotate,
  routed,
  machine,
  mark,
  next,
  proxy,
  staleDiscovery,
  upsert,
  type State,
} from "./connections"

const log = Log.create({ service: "plugin.copilot" })

async function readState() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return yield* new Store(fs).read()
    }).pipe(Effect.provide(AppFileSystem.defaultLayer)),
  ).catch(() => empty())
}

async function writeState(state: State) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      yield* new Store(fs).write(state)
    }).pipe(Effect.provide(AppFileSystem.defaultLayer)),
  ).catch(() => undefined)
}

async function allAuths() {
  return Effect.runPromise(Auth.Service.use((auth) => auth.all()).pipe(Effect.provide(Auth.defaultLayer))).then(list).catch(() => [])
}

export const CopilotRuntimeState = {
  migration() {
    return migrationOutcome.last
  },
  migrationSummary() {
    return summarizeMigration(migrationOutcome.last)
  },
  current: undefined as Runtime | undefined,
  info: {} as Record<string, { lane?: string; discovery: number; penalty: number; cooldown: boolean; selected?: boolean; selectedReason?: string[]; rejectedReason?: string[] }>,
  usage() {
    return usage(this.current)
  },
  feed() {
    return feed(this.current).map((item) => ({ ...this.info[item.key], ...item }))
  },
}

export type CopilotRuntimeEvent = Event

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
export function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

export function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

export function base(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"
}

export async function aliasModels(input: {
  provider: { id: string; models: Record<string, Model> }
  auth?: { type: string; refresh?: string; enterpriseUrl?: string }
  auths: CopilotAuth[]
  state: State
  write(state: State): Promise<void>
}) {
  if (!input.provider.id.startsWith("github-copilot#")) return
  if (!input.auth || input.auth.type !== "oauth" || !input.auth.refresh) return
  const key = routeProvider(input.provider.id, input.auths, input.state)
  const match = key ? input.auths.find((item) => item.key === key) : undefined
  if (!match) return
  const cfg = proxyConfig(input.state, match.key)
  return CopilotModels.get(
    base(match.enterpriseUrl),
    {
      Authorization: `Bearer ${match.refresh}`,
      "User-Agent": `opencode/${InstallationVersion}`,
      ...proxyHeaders(cfg?.token),
    },
    input.provider.models,
    cfg?.url,
  )
    .then(async (models) => {
      const next = discover(input.state, match.key, {
        models: Object.values(models).map((item) => item.api.id),
        api: base(match.enterpriseUrl),
        plan: input.state.connections[match.key]?.plan,
        login: input.state.connections[match.key]?.login,
        ok: true,
      })
      await input.write(next)
      return models
    })
    .catch(async (error) => {
      const next = discover(input.state, match.key, {
        models: [],
        api: base(match.enterpriseUrl),
        plan: input.state.connections[match.key]?.plan,
        login: input.state.connections[match.key]?.login,
        ok: false,
        err: error instanceof Error ? error.message : String(error),
      })
      await input.write(next)
      return Object.fromEntries(Object.entries(input.provider.models).map(([id, model]) => [id, fix(model, base(match.enterpriseUrl))]))
    })
}

// Check if a message is a synthetic user msg used to attach an image from a tool call
export function imgMsg(msg: any): boolean {
  if (msg?.role !== "user") return false

  // Handle the 3 api formats

  const content = msg.content
  if (typeof content === "string") return content === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT
  if (!Array.isArray(content)) return false
  return content.some(
    (part: any) =>
      (part?.type === "text" || part?.type === "input_text") && part.text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
  )
}

export function fix(model: Model, url: string): Model {
  return {
    ...model,
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

export function selectAccount(input: { auths: CopilotAuth[]; state: State; fallback: CopilotAuth; now?: number }) {
  return next(input.auths, input.state, input.now) ?? input.fallback
}

export function model(body: unknown) {
  if (!body || typeof body !== "object") return ""
  return typeof (body as { model?: unknown }).model === "string" ? (body as { model: string }).model : ""
}

export function premiumState(state: Map<string, Set<string>>, key: string, modelId: string) {
  const set = state.get(key) ?? new Set<string>()
  state.set(key, set)
  if (set.has(modelId)) return false
  set.add(modelId)
  return true
}

export function premiumRollback(state: Map<string, Set<string>>, key: string, modelId: string) {
  state.get(key)?.delete(modelId)
}

export function syncAccount(state: State, auths: CopilotAuth[]) {
  return auths.reduce((acc, item) => upsert(acc, item.key, { label: item.label }), state)
}

export function preferPlan(state: State, auths: CopilotAuth[], modelId: string) {
  if (!modelId) return auths
  const want = modelId.includes("edu") ? "edu" : modelId.includes("free") ? "free" : undefined
  if (!want) return auths
  const items = auths.filter((item) => byPlan(state, item.key) === want)
  return items.length > 0 ? items : auths
}

export function policyPlan(modelId: string) {
  const text = modelId.toLowerCase()
  if (text.includes("edu")) return "edu"
  if (text.includes("enterprise")) return "enterprise"
  if (text.includes("business")) return "business"
  if (text.includes("team")) return "team"
  if (text.includes("personal") || text.includes("free")) return "free"
  return undefined
}

export function recent429(state: State, key: string, now = Date.now(), max = 15 * 60 * 1000) {
  const until = state.connections[key]?.exhaustedUntil
  if (!until) return false
  return until > now - max
}

export function recentDiscoveryError(state: State, key: string, now = Date.now(), max = 30 * 60 * 1000) {
  const at = state.connections[key]?.lastDiscoveryErrorAt
  if (!at) return false
  return now - at <= max
}

export function discoveryRank(state: State, key: string, modelId: string) {
  const item = state.connections[key]?.discovery
  if (!item) return 0
  if (!item.models.includes(modelId)) return 0
  if (item.ok === false) return 1
  if (staleDiscovery(state, key)) return 2
  return 3
}

export function penalty(state: State, key: string, now = Date.now()) {
  return {
    recent429: recent429(state, key, now),
    recentDiscoveryError: recentDiscoveryError(state, key, now),
  }
}

export function score(state: State, key: string, modelId: string, now = Date.now()) {
  const p = penalty(state, key, now)
  return {
    discovery: discoveryRank(state, key, modelId),
    penalty: (p.recent429 ? 1 : 0) + (p.recentDiscoveryError ? 1 : 0),
    ...p,
  }
}

export function runtimeScore(input: { state: State; runtime?: Runtime; key: string; modelId: string; now?: number }) {
  const now = input.now ?? Date.now()
  const s = score(input.state, input.key, input.modelId, now)
  return {
    ...s,
    load: load(input.runtime, input.key),
    cooldown: cooldown(input.runtime, input.key, now),
  }
}

export function weighted(state: State, auths: CopilotAuth[], modelId: string, now = Date.now()) {
  return [...auths].sort((a, b) => {
    const ar = score(state, a.key, modelId, now)
    const br = score(state, b.key, modelId, now)
    if (ar.discovery !== br.discovery) return br.discovery - ar.discovery
    if (ar.penalty !== br.penalty) return ar.penalty - br.penalty
    return 0
  })
}

export function preferDiscovery(state: State, auths: CopilotAuth[], modelId: string, now = Date.now()) {
  if (!modelId) return auths
  const items = weighted(state, auths, modelId, now)
  const rank = Math.max(...items.map((item) => discoveryRank(state, item.key, modelId)), 0)
  if (rank <= 0) return items
  const pool = items.filter((item) => discoveryRank(state, item.key, modelId) === rank)
  const best = Math.min(
    ...pool.map(
      (item) => (recent429(state, item.key, now) ? 1 : 0) + (recentDiscoveryError(state, item.key, now) ? 1 : 0),
    ),
  )
  return pool.filter(
    (item) => (recent429(state, item.key, now) ? 1 : 0) + (recentDiscoveryError(state, item.key, now) ? 1 : 0) === best,
  )
}

export function preferAccount(state: State, auths: CopilotAuth[]) {
  const key = state.preferred
  if (!key) return auths
  const match = auths.find((item) => item.key === key)
  if (!match) return auths
  return [match, ...auths.filter((item) => item.key !== key)]
}

export function preferPolicy(state: State, auths: CopilotAuth[], modelId: string, now = Date.now()) {
  const want = policyPlan(modelId)
  const items = preferAccount(state, auths)
  const live = items.filter((item) => {
    const until = state.connections[item.key]?.exhaustedUntil
    return !until || until <= now
  })
  const pool = live.length > 0 ? live : items
  if (!want) return rotate(state, pool)
  const lane = pool.filter((item) => byPlan(state, item.key) === want)
  return rotate(state, lane.length > 0 ? lane : pool)
}

export function aliases(auths: CopilotAuth[], state: State) {
  const by = (plan: string) => auths.find((item) => byPlan(state, item.key) === plan)?.key
  return {
    "github-copilot#edu": by("edu"),
    "github-copilot#enterprise": by("enterprise") ?? by("business") ?? by("team"),
    "github-copilot#personal": by("free"),
    "github-copilot#free": by("free"),
  }
}

export function routeAlias(auths: CopilotAuth[], state: State, key: string) {
  const map = aliases(auths, state)
  if (key in map) {
    const next = map[key as keyof typeof map]
    return next ?? key
  }
  return key
}

export type RouteDebug = {
  key: string
  alias?: string
  lane?: string
  discovery: number
  recent429: boolean
  recentDiscoveryError: boolean
  penalty: number
  load: number
  cooldown: boolean
  routeReason: string[]
  selectedReason: string[]
  rejectedReason: string[]
  selected: boolean
}

export function batchOrder(input: {
  auths: CopilotAuth[]
  state: State
  modelId: string
  runtime?: Runtime
  now?: number
}) {
  const now = input.now ?? Date.now()
  return [...input.auths].sort((a, b) => {
    const ar = runtimeScore({ state: input.state, runtime: input.runtime, key: a.key, modelId: input.modelId, now })
    const br = runtimeScore({ state: input.state, runtime: input.runtime, key: b.key, modelId: input.modelId, now })
    if (ar.cooldown !== br.cooldown) return Number(ar.cooldown) - Number(br.cooldown)
    if (ar.discovery !== br.discovery) return br.discovery - ar.discovery
    if (ar.penalty !== br.penalty) return ar.penalty - br.penalty
    if (ar.load !== br.load) return ar.load - br.load
    return 0
  })
}

export function autobestBatch(input: {
  auths: CopilotAuth[]
  state: State
  modelId: string
  count: number
  runtime?: Runtime
  now?: number
}) {
  const now = input.now ?? Date.now()
  const runtime = input.runtime
    ? { ...input.runtime, pool: { ...input.runtime.pool }, last: { ...input.runtime.last } }
    : undefined
  const planned = preferPlan(input.state, input.auths, input.modelId)
  const lane = preferPolicy(input.state, planned, input.modelId, now)
  const pool = preferDiscovery(input.state, lane, input.modelId, now)
  const out: string[] = []
  for (let i = 0; i < input.count; i++) {
    const live = runtime ? eligible(runtime, pool) : pool
    const pick = batchOrder({ auths: live, state: input.state, modelId: input.modelId, runtime, now })[0]
    if (!pick) break
    out.push(pick.key)
    if (runtime) runtime.pool[pick.key] = load(runtime, pick.key) + 1
  }
  return out
}

export function routeDebug(input: {
  auths: CopilotAuth[]
  state: State
  modelId: string
  providerID?: string
  runtime?: Runtime
  now?: number
}) {
  const now = input.now ?? Date.now()
  const alias = input.providerID ? routeAlias(input.auths, input.state, input.providerID) : undefined
  const lane = policyPlan(input.modelId)
  const items = weighted(
    input.state,
    preferPolicy(input.state, preferPlan(input.state, input.auths, input.modelId), input.modelId, now),
    input.modelId,
    now,
  )
  const selected = items[0]?.key
  const top = items[0]
    ? runtimeScore({ state: input.state, runtime: input.runtime, key: items[0].key, modelId: input.modelId, now })
    : undefined
  return items.map((item) => {
    const s = runtimeScore({ state: input.state, runtime: input.runtime, key: item.key, modelId: input.modelId, now })
    const routeReason = [
      alias && item.key === alias ? `alias:${input.providerID}` : undefined,
      lane && byPlan(input.state, item.key) === lane ? `lane:${lane}` : undefined,
      s.discovery > 0 ? `discovery:${s.discovery}` : undefined,
      s.recent429 ? "penalty:recent429" : undefined,
      s.recentDiscoveryError ? "penalty:recentDiscoveryError" : undefined,
    ].filter(Boolean) as string[]
    const rejectedReason = [
      selected !== item.key && top && s.discovery < top.discovery ? "lowerDiscoveryRank" : undefined,
      selected !== item.key && top && s.penalty > top.penalty ? "higherPenalty" : undefined,
      alias && item.key !== alias ? "aliasMismatch" : undefined,
      lane && byPlan(input.state, item.key) !== lane ? "laneMismatch" : undefined,
    ].filter(Boolean) as string[]
    return {
      key: item.key,
      alias,
      lane,
      discovery: s.discovery,
      recent429: s.recent429,
      recentDiscoveryError: s.recentDiscoveryError,
      penalty: s.penalty,
      load: s.load,
      cooldown: s.cooldown,
      routeReason,
      selectedReason: item.key === selected ? routeReason : [],
      rejectedReason,
      selected: item.key === selected,
    }
  })
}

export function routeAccount(input: {
  auths: CopilotAuth[]
  state: State
  modelId: string
  providerID?: string
  fallback: CopilotAuth
  runtime?: Runtime
  now?: number
}) {
  const alias = input.providerID ? routeAlias(input.auths, input.state, input.providerID) : undefined
  if (alias) {
    const match = input.auths.find((item) => item.key === alias)
    if (match) return match
  }
  const now = input.now ?? Date.now()
  const planned = preferPlan(input.state, input.auths, input.modelId)
  const lane = preferPolicy(input.state, planned, input.modelId, now)
  const pool = preferDiscovery(input.state, lane, input.modelId, now)
  const live = input.runtime ? eligible(input.runtime, pool) : pool
  return (
    batchOrder({ auths: live, state: input.state, modelId: input.modelId, runtime: input.runtime, now })[0] ??
    selectAccount({ auths: live, state: input.state, fallback: input.fallback, now })
  )
}

export async function refreshAccount(input: { state: State; key: string; token: string; enterpriseUrl?: string }) {
  try {
    const quota = await fetchQuota(input.token, input.enterpriseUrl, proxy(input.state, input.key))
    return upsert(input.state, input.key, {
      login: quota.login,
      plan: classifyPlan(quota),
      lastTestedAt: Date.now(),
    })
  } catch {
    return upsert(input.state, input.key, { lastTestedAt: Date.now() })
  }
}

export function proxyConfig(state: State, key: string) {
  const item = proxy(state, key)
  if (!item.url) return
  return item
}

export function proxyHeaders(token?: string): Record<string, string> {
  return token ? { "x-copilot-proxy-token": token } : {}
}

export function copilotRuntimeConfig(config?: { provider?: Record<string, { options?: Record<string, unknown> }> }) {
  const opts = config?.provider?.["github-copilot"]?.options
  const limit = Number(process.env.OPENCODE_COPILOT_RUNTIME_LIMIT ?? opts?.runtimeLimit ?? 1)
  const minIntervalMs = Number(process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS ?? opts?.runtimeMinIntervalMs ?? 0)
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1,
    minIntervalMs: Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? Math.trunc(minIntervalMs) : 0,
  }
}

export function routeUrl(url: RequestInfo | URL, cfg?: { url?: string }) {
  if (!cfg?.url) return url
  const raw = url instanceof URL ? url.href : url.toString()
  return new URL(raw, cfg.url).href
}

export async function routedFetch(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  cfg?: { url?: string; token?: string },
) {
  const headers = { ...(init?.headers as Record<string, string>), ...proxyHeaders(cfg?.token) }
  return fetch(routeUrl(request, cfg), { ...init, headers })
}

export function protocol(input: {
  init?: RequestInit
  token: string
  machineId: string
  sessionId: string
  premium: boolean
  vision: boolean
  agent: boolean
}) {
  const os = process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux"
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
  const headers: Record<string, string> = {
    ...(input.init?.headers as Record<string, string>),
    "x-initiator": input.agent ? "agent" : input.premium ? "user" : "agent",
    "X-Interaction-Type": input.agent
      ? "conversation-subagent"
      : input.premium
        ? "conversation-user"
        : "conversation-agent",
    "User-Agent": `opencode/${InstallationVersion} (${process.platform} ${process.version}) copilot-compat/1.0.14`,
    Authorization: `Bearer ${input.token}`,
    "Openai-Intent": "conversation-agent",
    "Copilot-Integration-Id": "copilot-developer-cli",
    "X-GitHub-Api-Version": "2026-01-09",
    "X-Interaction-Id": crypto.randomUUID(),
    "X-Agent-Task-Id": crypto.randomUUID(),
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "5.20.1",
    "X-Stainless-OS": os,
    "X-Stainless-Arch": arch,
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": process.version,
    "X-Client-Session-Id": input.sessionId,
    "X-Client-Machine-Id": input.machineId,
  }
  if (input.vision) headers["Copilot-Vision-Request"] = "true"
  delete headers["x-api-key"]
  delete headers["authorization"]
  return headers
}

export function routeProvider(providerID: string | undefined, auths: CopilotAuth[], state: State) {
  if (!providerID) return undefined
  if (!providerID.startsWith("github-copilot#")) return undefined
  return routeAlias(auths, state, providerID)
}

export async function dispatch(input: {
  providerID?: string
  getAuth: () => Promise<Auth.Info>
  auths: CopilotAuth[]
  read: () => Promise<State>
  write: (state: State) => Promise<void>
  premium: Map<string, Set<string>>
  runtime: Runtime
  request: RequestInfo | URL
  init?: RequestInit
  isVision: boolean
  isAgent: boolean
  modelId: string
}) {
  const info = await input.getAuth()
  if (info.type !== "oauth") return fetch(input.request, input.init)
  const loaded = await input.read()
  const state = syncAccount(loaded, input.auths)
  const fallback: CopilotAuth = {
    key: "github-copilot",
    label: "Primary",
    refresh: info.refresh,
    access: info.access,
    expires: info.expires,
    accountId: info.accountId,
    enterpriseUrl: info.enterpriseUrl,
  }
  const live = routeAccount({
    auths: input.auths,
    state,
    modelId: input.modelId,
    providerID: input.providerID,
    fallback,
    runtime: input.runtime,
  })
  const held =
    !input.providerID && input.auths.length > 1
      ? reserveBatch(input.runtime, autobestBatch({
          auths: input.auths,
          state,
          modelId: input.modelId,
          count: input.runtime.limit,
        }))
      : undefined
  const slot = held?.held.find((item) => item.key === live.key && item.held)
  if (held) {
    held.held.filter((item) => item !== slot).forEach((item) => item.release())
  }
  const pick = slot ?? reserve(input.runtime, live.key)
  const isPremium = input.modelId ? premiumState(input.premium, live.key, input.modelId) : !input.isAgent
  const fresh = await refreshAccount({ state, key: live.key, token: live.refresh, enterpriseUrl: live.enterpriseUrl })
  const [nextState, machineId] = machine(routed(fresh, live.key), live.key)
  await input.write(nextState)
  const s = runtimeScore({ state: nextState, runtime: input.runtime, key: live.key, modelId: input.modelId })
  const debug = routeDebug({
    auths: input.auths,
    state: nextState,
    modelId: input.modelId,
    providerID: input.providerID,
    runtime: input.runtime,
  })
  debug.forEach((item) => {
    CopilotRuntimeState.info[item.key] = {
      lane: item.lane,
      discovery: item.discovery,
      penalty: item.penalty,
      cooldown: item.cooldown,
      selected: item.selected,
      selectedReason: item.selectedReason,
      rejectedReason: item.rejectedReason,
    }
  })
  const headers = protocol({
    init: input.init,
    token: live.refresh,
    machineId,
    sessionId: crypto.randomUUID(),
    premium: isPremium,
    vision: input.isVision,
    agent: input.isAgent,
  })
  const cfg = proxyConfig(nextState, live.key)
  const res = await routedFetch(input.request, { ...input.init, headers }, cfg)
  if (res.status === 429) {
    pick.release()
    // Honor Retry-After when present; else run the headerless-429 escalator
    // (11m → 21m → 41m). `record429` is monotonic — it never shortens an
    // existing cooldown (Rust `set_exhaustion` semantics).
    const retryAfter = res.headers.get("retry-after") ?? res.headers.get("Retry-After")
    const { until } = record429(input.runtime, live.key, {
      retryAfterMs: parseRetryAfterHeader(retryAfter),
    })
    await input.write(mark(nextState, live.key, until))
    if (input.modelId && isPremium) premiumRollback(input.premium, live.key, input.modelId)
    return res
  }
  if (res.status === 401) {
    pick.release()
    if (input.modelId && isPremium) premiumRollback(input.premium, live.key, input.modelId)
    return res
  }
  if (res.ok) {
    recordSuccess(input.runtime, live.key)
    await input.write(clear(nextState, live.key))
  }
  pick.release()
  touch(input.runtime, live.key)
  return res
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) return Math.trunc(secs * 1000)
  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  await Effect.runPromise(migrate().pipe(Effect.provide(Auth.defaultLayer), Effect.provide(AppFileSystem.defaultLayer))).catch(() => [])
  const premium = new Map<string, Set<string>>()
  const { AppRuntime } = await import("@/effect/app-runtime")
  const cfg = copilotRuntimeConfig(
    await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get())).catch(() => undefined),
  )
  const runtime = owner(cfg.limit, cfg.minIntervalMs)
  CopilotRuntimeState.current = runtime
  return {
    provider: {
      id: "github-copilot",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") {
          return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())]))
        }

        const auth = ctx.auth
        const all = await allAuths()
        const storeState = syncAccount(await readState(), all)
        const match =
          all.find((item) => item.key === "github-copilot") ?? all.find((item) => item.refresh === auth.refresh)
        const key = match?.key ?? "github-copilot"
        const cfg = proxyConfig(storeState, key)

        return CopilotModels.get(
          base(auth.enterpriseUrl),
          {
            Authorization: `Bearer ${auth.refresh}`,
            "User-Agent": `opencode/${InstallationVersion}`,
            ...proxyHeaders(cfg?.token),
          },
          provider.models,
          cfg?.url,
        )
          .then(async (models) => {
            const next = discover(storeState, key, {
              models: Object.values(models).map((item) => item.api.id),
              api: base(auth.enterpriseUrl),
              plan: storeState.connections[key]?.plan,
              login: storeState.connections[key]?.login,
              ok: true,
            })
            await writeState(next)
            return models
          })
          .catch(async (error) => {
            log.error("failed to fetch copilot models", { error })
            const next = discover(storeState, key, {
              models: [],
              api: base(auth.enterpriseUrl),
              plan: storeState.connections[key]?.plan,
              login: storeState.connections[key]?.login,
              ok: false,
              err: error instanceof Error ? error.message : String(error),
            })
            await writeState(next)
            return Object.fromEntries(
              Object.entries(provider.models).map(([id, model]) => [id, fix(model, base(auth.enterpriseUrl))]),
            )
          })
      },
    },
    auth: {
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        return {
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const url = request instanceof URL ? request.href : request.toString()
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const body = iife(() => {
              try {
                return typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
              } catch {
                return undefined
              }
            })
            return dispatch({
              getAuth,
              auths: await allAuths(),
              read: readState,
              write: writeState,
              premium,
              runtime,
              request,
              init,
              isVision,
              isAgent,
              providerID: (info as any).accountId,
              modelId: model(body),
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
            }

            const urls = getUrls(domain)

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `opencode/${InstallationVersion}`,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user",
              }),
            })

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization")
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  })

                  if (!response.ok) return { type: "failed" as const }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    interval?: number
                  }

                  if (data.access_token) {
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                    }

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    // Based on the RFC spec, we must add 5 seconds to our current polling interval.
                    // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
                    let newInterval = (deviceData.interval + 5) * 1000

                    // GitHub OAuth API may return the new interval in seconds in the response.
                    // We should try to use that if provided with safety margin.
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }

                    await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error) return { type: "failed" as const }

                  await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
      ],
    },
    "chat.params": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      // Match github copilot cli, omit maxOutputTokens for gpt models
      if (incoming.model.api.id.includes("gpt")) {
        output.maxOutputTokens = undefined
      }
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (parts?.data.parts?.some((part) => part.type === "compaction")) {
        output.headers["x-initiator"] = "agent"
        return
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
    },
  }
}
