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
  recordSuccess,
  touch,
  usage,
  type Event,
  type Runtime,
} from "./runtime"
import { AccountPool, type Lease } from "./account-pool"
import { openRateStore } from "./account-pool-sqlite"
import { CopilotRateLimiter, copilotRateLimiterConfig, type Release as RateLimiterRelease } from "./rate-limiter"
import path from "path"
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
  filterTestAccounts,
  hasModel,
  isDeactivated,
  isModelUnsupported,
  markDeactivated,
  markModelUnsupported,
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
  pool: undefined as AccountPool | undefined,
  /**
   * Adaptive rate limiter keyed by account key. Populated during plugin
   * boot and mirrors `runtime.rateLimiter`. Null-safe for non-copilot
   * sessions.
   */
  rateLimiter(): CopilotRateLimiter | undefined {
    return this.current?.rateLimiter
  },
  info: {} as Record<string, { lane?: string; discovery: number; penalty: number; cooldown: boolean; selected?: boolean; selectedReason?: string[]; rejectedReason?: string[] }>,
  usage() {
    return usage(this.current)
  },
  feed() {
    return feed(this.current).map((item) => ({ ...this.info[item.key], ...item }))
  },
  /**
   * Number of accounts currently assignable (not in cooldown / not in use up
   * to the per-account cap). Mirrors Rust `AccountPool::available_account_count`.
   */
  availableAccountCount(now = Date.now()) {
    return this.pool?.availableAccountCount(now) ?? 0
  },
  /**
   * Cascade-breaker signal — `true` when more than 50% of accounts are in
   * cooldown. Callers (e.g. `tool/task.ts`) can use this to defer spawning
   * new sub-agents.  Mirrors Rust `AccountPool::should_throttle_spawns`
   * (`account_pool.rs:1422-1430`).
   */
  shouldThrottleSpawns(now = Date.now()) {
    return this.pool?.shouldThrottleSpawns(now) ?? false
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

export type CopilotStatus = {
  rateLimited: boolean
  authError: boolean
  networkError: boolean
  retryAfterSec?: number
}

/**
 * Triage an HTTP response against the Copilot API, mirroring
 * `github-copilot/src/error.rs::{is_auth_error,is_rate_limited,is_network_error}`
 * so dispatch callers can branch on a single classification.
 *
 * - `rateLimited` — HTTP 429
 * - `authError`   — HTTP 401 or 403 (token invalid / account deactivated)
 * - `networkError`— HTTP 5xx (transient server-side)
 * - `retryAfterSec` — parsed `retry-after` / `retry-delay` header when present
 */
export function copilotStatus(res: { status: number; headers?: Headers | Record<string, string> }): CopilotStatus {
  const status = res.status
  const headers = res.headers
  const get = (name: string): string | undefined => {
    if (!headers) return undefined
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name) ?? undefined
    }
    const rec = headers as Record<string, string>
    return rec[name] ?? rec[name.toLowerCase()] ?? undefined
  }
  let retryAfterSec: number | undefined
  const retry = get("retry-after") ?? get("retry-delay")
  if (retry) {
    const n = Number(retry)
    if (Number.isFinite(n) && n >= 0) retryAfterSec = Math.trunc(n)
  }
  return {
    rateLimited: status === 429,
    authError: status === 401 || status === 403,
    networkError: status >= 500 && status < 600,
    retryAfterSec,
  }
}

/**
 * Resolve the discovered API base + plan SKU for an account via
 * `/copilot_internal/user`. Mirrors the first leg of Rust
 * `fetch_account_model_catalog_with_discovery` in `models.rs:439-567`.
 * Returns `{api, sku}` on success; silently swallows errors so callers
 * can fall back to the static `base(enterpriseUrl)`.
 */
export async function discoverEndpoints(input: {
  token: string
  enterpriseUrl?: string
  proxy?: { url?: string; token?: string }
}): Promise<{ api?: string; sku?: string }> {
  try {
    const quota = await fetchQuota(input.token, input.enterpriseUrl, input.proxy)
    return { api: quota.api, sku: quota.sku }
  } catch {
    return {}
  }
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
  // Step 1: two-step discovery — resolve dynamic API base + plan SKU.
  const disc = await discoverEndpoints({
    token: match.refresh,
    enterpriseUrl: match.enterpriseUrl,
    proxy: cfg,
  })
  const apiBase = disc.api ?? base(match.enterpriseUrl)
  const planSku = disc.sku
  return CopilotModels.get(
    apiBase,
    {
      Authorization: `Bearer ${match.refresh}`,
      "User-Agent": `opencode/${InstallationVersion}`,
      ...proxyHeaders(cfg?.token),
    },
    input.provider.models,
    cfg?.url,
    planSku,
  )
    .then(async (models) => {
      const next = discover(input.state, match.key, {
        models: Object.values(models).map((item) => item.api.id),
        api: apiBase,
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
        api: apiBase,
        plan: input.state.connections[match.key]?.plan,
        login: input.state.connections[match.key]?.login,
        ok: false,
        err: error instanceof Error ? error.message : String(error),
      })
      await input.write(next)
      return Object.fromEntries(Object.entries(input.provider.models).map(([id, model]) => [id, fix(model, apiBase)]))
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

/**
 * Pseudo-random index in `[0, length)` seeded by a clock value. Mirrors
 * Rust `select_best_token`'s sub-nanosecond `pseudo_rand` (`lib.rs:308-313`)
 * — deterministic when callers pin `now` (used by tests) and uniformly
 * spread otherwise.
 */
export function spreadIndex(length: number, now: number): number {
  if (length <= 0) return 0
  // Mix high + low bits so adjacent millisecond seeds produce different
  // residues even for small `length` values.
  const seed = (Math.trunc(now) ^ (Math.trunc(now) >>> 16)) >>> 0
  return seed % length
}

/**
 * Select an account for dispatch. Mirrors Rust `select_best_token`
 * (`github-copilot/src/lib.rs:266-344`):
 *
 *   1. Sort by health (cooldown / deactivated last) via `next` semantics
 *      from `connections.ts`.
 *   2. **Spread startup load** across the healthy tier instead of always
 *      picking the lexically-first account — otherwise every fresh process
 *      hammers the same primary on its first turn.
 *
 * The randomization is keyed off `now` so tests pin determinism with
 * `selectAccount({…, now: 100})`. Pass an injected `pick` to override the
 * spreader entirely (used by the `health.ts`-aware quota-spread test).
 */
export function selectAccount(input: {
  auths: CopilotAuth[]
  state: State
  fallback: CopilotAuth
  now?: number
  pick?: (length: number, now: number) => number
}) {
  if (input.auths.length === 0) return next(input.auths, input.state, input.now) ?? input.fallback
  const now = input.now ?? Date.now()
  const ordered = [...input.auths].filter((item) => !isDeactivated(input.state, item.key))
  const candidates = ordered.length > 0 ? ordered : input.auths
  const live = candidates.filter((item) => {
    const until = input.state.connections[item.key]?.exhaustedUntil
    return !until || until <= now
  })
  const tier = live.length > 0 ? live : candidates
  if (tier.length === 1) return tier[0]
  const idx = (input.pick ?? spreadIndex)(tier.length, now)
  return tier[idx % tier.length] ?? next(input.auths, input.state, input.now) ?? input.fallback
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

/**
 * Exclude test (`#edu-*`) and deactivated accounts from routing.
 * Keeps the primary / fallback as a last-resort so callers always
 * get *something* back even when every alternate has been flagged.
 */
export function routableAuths(state: State, auths: CopilotAuth[]): CopilotAuth[] {
  const filtered = filterTestAccounts(auths).filter((item) => !isDeactivated(state, item.key))
  return filtered.length > 0 ? filtered : auths
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
  const candidates = routableAuths(input.state, input.auths)
  const alias = input.providerID ? routeAlias(candidates, input.state, input.providerID) : undefined
  if (alias) {
    const match = candidates.find((item) => item.key === alias)
    if (match) return match
  }
  const now = input.now ?? Date.now()
  const planned = preferPlan(input.state, candidates, input.modelId)
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

/**
 * Default timeout (in seconds) advertised in the fetch-envelope. Matches
 * Rust `http_get_via_proxy` (`models.rs:348`).
 */
export const PROXY_FETCH_TIMEOUT_SEC = 120

/**
 * Detect whether the configured proxy speaks the Rust `POST /fetch`
 * envelope protocol (`models.rs:305-378`). When `cfg.envelope === true`
 * we wrap the request as `POST {proxy}/fetch` with `{url, method,
 * headers, body, timeout_ms}` and `Authorization: Bearer {token}`.
 *
 * Set `OPENCODE_COPILOT_PROXY_ENVELOPE=1` to opt in globally; per-account
 * preference can be encoded by passing `{ envelope: true }` through the
 * proxy config.  When neither is set, `routedFetch` keeps the legacy
 * URL-rewrite behaviour for backwards compatibility.
 */
export function envelopeEnabled(cfg?: { envelope?: boolean }): boolean {
  if (cfg?.envelope === true) return true
  return process.env.OPENCODE_COPILOT_PROXY_ENVELOPE === "1"
}

/**
 * Headers whose values would be wrong if forwarded verbatim by the
 * envelope proxy (e.g. Content-Length set against the inner body, Host
 * pointing at the proxy). Mirrors the `target_headers` filter used by
 * the Rust counterpart.
 */
const ENVELOPE_STRIP_HEADERS = new Set(["content-length", "host"])

function flattenHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {}
  if (input instanceof Headers) {
    const out: Record<string, string> = {}
    input.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input)
  }
  return { ...(input as Record<string, string>) }
}

async function readEnvelopeBody(input: RequestInit["body"] | undefined): Promise<string | undefined> {
  if (input === undefined || input === null) return undefined
  if (typeof input === "string") return input
  if (input instanceof Uint8Array) return new TextDecoder().decode(input)
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input))
  // Node Buffer (Bun) extends Uint8Array; covered above.
  // Streams / FormData are not supported by the envelope — best-effort stringify.
  try {
    return JSON.stringify(input)
  } catch {
    return undefined
  }
}

/**
 * POST `{proxyUrl}/fetch` with the inner request as a JSON envelope.
 * Mirrors Rust `http_get_via_proxy` extended for arbitrary methods +
 * bodies (`models.rs:305-378`).
 */
export async function envelopeFetch(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  cfg: { url: string; token?: string },
): Promise<Response> {
  const inner = request instanceof URL ? request.href : request.toString()
  const targetUrl = inner.startsWith("http://") || inner.startsWith("https://") ? inner : new URL(inner, cfg.url).href
  const method = (init?.method ?? "GET").toUpperCase()
  const headers = flattenHeaders(init?.headers)
  const filtered: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!ENVELOPE_STRIP_HEADERS.has(k.toLowerCase())) filtered[k] = v
  }
  const body = await readEnvelopeBody(init?.body)
  const envelope: Record<string, unknown> = {
    url: targetUrl,
    method,
    headers: filtered,
    timeout_ms: PROXY_FETCH_TIMEOUT_SEC * 1000,
  }
  if (body !== undefined) envelope.body = body
  const endpoint = `${cfg.url.replace(/\/$/, "")}/fetch`
  const proxyHeadersInit: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (cfg.token) proxyHeadersInit["Authorization"] = `Bearer ${cfg.token}`
  const proxyResp = await fetch(endpoint, {
    method: "POST",
    headers: proxyHeadersInit,
    body: JSON.stringify(envelope),
  })
  if (!proxyResp.ok) {
    // Proxy itself errored — surface the proxy status so callers can
    // distinguish from inner-API errors.
    const text = await proxyResp.text().catch(() => "")
    return new Response(text, { status: proxyResp.status, headers: { "x-copilot-proxy-error": "1" } })
  }
  const contentType = proxyResp.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    // Pass through non-JSON proxy responses unchanged.
    return proxyResp
  }
  const decoded = (await proxyResp.json().catch(() => null)) as
    | { status_code?: number; headers?: Record<string, string>; body?: string }
    | null
  if (!decoded) return new Response("", { status: 502, headers: { "x-copilot-proxy-error": "decode-failed" } })
  const status = typeof decoded.status_code === "number" ? decoded.status_code : 502
  const innerHeaders = new Headers()
  for (const [k, v] of Object.entries(decoded.headers ?? {})) {
    if (typeof v === "string") innerHeaders.set(k, v)
  }
  return new Response(decoded.body ?? "", { status, headers: innerHeaders })
}

export async function routedFetch(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  cfg?: { url?: string; token?: string; envelope?: boolean },
) {
  if (cfg?.url && envelopeEnabled(cfg)) {
    return envelopeFetch(request, init, { url: cfg.url, token: cfg.token })
  }
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
  /**
   * Optional `AccountPool`. When provided the dispatch path replaces the
   * legacy flat `reserve()/release()` book-keeping with bounded
   * `pool.acquire()` (5 min timeout, `preferSecondary: true`) and routes
   * 429 / model-not-supported signals through the pool's API. Callers
   * without a pool fall back to the previous flat-reserve behaviour so
   * legacy tests stay green.
   */
  pool?: AccountPool
  request: RequestInfo | URL
  init?: RequestInit
  isVision: boolean
  isAgent: boolean
  modelId: string
}): Promise<Response> {
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
  // Acquire a slot via the AccountPool when available — RAII lease w/
  // bounded 5-min wait + secondary preference for sub-agents (`isAgent`).
  // Otherwise fall back to the legacy autobest batch reservation.
  const slot = await reserveSlot({
    pool: input.pool,
    runtime: input.runtime,
    auths: input.auths,
    state,
    modelId: input.modelId,
    providerID: input.providerID,
    key: live.key,
    isAgent: input.isAgent,
  })
  // `leaseRef` is updated in-place when an atomic `reassign` happens on 429;
  // the closure below reads from it so `release()` frees the *current* lease.
  const leaseRef = { lease: slot.lease }
  // Acquire an adaptive-rate-limiter slot for the same account, if the
  // runtime has a limiter attached. This sits on top of the pool lease and
  // shrinks/grows capacity based on the 10-min 429 window. On reassign the
  // slot is released for the old key and re-acquired for the new one.
  const rateRef: { release?: RateLimiterRelease } = {}
  if (input.runtime.rateLimiter) {
    try {
      rateRef.release = await input.runtime.rateLimiter.acquire(live.key)
    } catch {
      // Limiter timeout — fall through without the adaptive gate so we
      // never permanently stall dispatch on a single slow account.
    }
  }
  const release = () => {
    if (leaseRef.lease) {
      leaseRef.lease.release()
      leaseRef.lease = undefined
    } else if (slot.fallbackRelease) {
      slot.fallbackRelease()
    }
    if (rateRef.release) {
      rateRef.release.release()
      rateRef.release = undefined
    }
  }
  const res = await dispatchOnce({
    input,
    state,
    live,
    leaseRef,
  })
  // 429 retry: if a pool + viable failover target exists, atomically
  // reassign the lease to the new key and retry once. Mirrors Rust
  // `account_pool.rs:1038-1142` + `:1390-1430`.
  if (input.pool && leaseRef.lease && copilotStatus(res).rateLimited) {
    const failoverKey = input.pool.failoverTokenForModel(live.key, input.modelId)
    const failoverAuth = failoverKey
      ? (input.auths.find((a) => a.key === failoverKey) ?? undefined)
      : undefined
    if (failoverKey && failoverAuth) {
      try {
        const newLease = leaseRef.lease.reassign(failoverKey)
        leaseRef.lease = newLease
        // Swap the rate-limiter slot to the failover account too — the
        // adaptive gate must follow the actual dispatch target.
        if (input.runtime.rateLimiter) {
          if (rateRef.release) {
            rateRef.release.release()
            rateRef.release = undefined
          }
          try {
            rateRef.release = await input.runtime.rateLimiter.acquire(failoverKey)
          } catch {
            // fall through — limiter disabled/unavailable for the failover
          }
        }
        // Re-read state (it was updated in the first attempt's body).
        const nextLoaded = await input.read()
        const nextState = syncAccount(nextLoaded, input.auths)
        return await dispatchOnce({
          input,
          state: nextState,
          live: failoverAuth,
          leaseRef,
          alreadyRetried: true,
        })
      } catch {
        // reassign failed (no headroom on failover) — fall through to return
        // the original 429 so the caller's outer retry loop can decide.
      }
    }
  }
  release()
  return res
}

async function dispatchOnce(ctx: {
  input: Parameters<typeof dispatch>[0]
  state: State
  live: CopilotAuth
  leaseRef: { lease: Lease | undefined }
  alreadyRetried?: boolean
}): Promise<Response> {
  const { input, live, state } = ctx
  const isPremium = input.modelId ? premiumState(input.premium, live.key, input.modelId) : !input.isAgent
  const fresh = await refreshAccount({ state, key: live.key, token: live.refresh, enterpriseUrl: live.enterpriseUrl })
  const [nextState, machineId] = machine(routed(fresh, live.key), live.key)
  await input.write(nextState)
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
  const triage = copilotStatus(res)
  if (triage.rateLimited) {
    // Honor Retry-After when present; else run the headerless-429 escalator
    // (11m → 21m → 41m). `record429` is monotonic — it never shortens an
    // existing cooldown (Rust `set_exhaustion` semantics). Routed through
    // `pool.recordExhaustion` when a pool is attached so persistence picks
    // it up in the background flush.
    // Also feed the adaptive rate-limiter's sliding window so it can
    // shrink concurrency across subsequent dispatches.
    input.runtime.rateLimiter?.record429(live.key)
    const retryAfter = res.headers.get("retry-after") ?? res.headers.get("Retry-After")
    const retryAfterMs = parseRetryAfterHeader(retryAfter)
    const result = input.pool
      ? input.pool.recordExhaustion(live.key, { retryAfter, ...(retryAfterMs !== undefined ? { delayMs: retryAfterMs } : {}) })
      : (await import("./runtime")).record429(input.runtime, live.key, { retryAfterMs })
    await input.write(mark(nextState, live.key, result.until))
    if (input.modelId && isPremium) premiumRollback(input.premium, live.key, input.modelId)
    // On the retried attempt we do NOT release here; the caller decides.
    // On the first attempt we leave the lease live so the caller can reassign.
    return res
  }
  if (triage.authError) {
    // 401/403 means the token is invalid or the account has been deactivated.
    // Flag the account so subsequent dispatches skip it (mirror Rust
    // `check_account_statuses` → `AccountStatus::is_deactivated`).
    await input.write(markDeactivated(nextState, live.key))
    if (input.modelId && isPremium) premiumRollback(input.premium, live.key, input.modelId)
    if (ctx.leaseRef.lease) {
      ctx.leaseRef.lease.release()
      ctx.leaseRef.lease = undefined
    }
    return res
  }
  if (triage.networkError) {
    // 5xx is transient server-side: don't mark the account, but roll back
    // the premium stamp so the retry is free to re-claim it.
    if (input.modelId && isPremium) premiumRollback(input.premium, live.key, input.modelId)
    if (ctx.leaseRef.lease) {
      ctx.leaseRef.lease.release()
      ctx.leaseRef.lease = undefined
    }
    return res
  }
  // model_not_supported: server rejects the model on this account. Mark the
  // account as Unsupported for that model and clear any stale >1h cooldown
  // (Rust `mark_model_unsupported` semantics, `account_pool.rs:1632-1658`).
  // We need to peek at the body without consuming it — clone first.
  let modelUnsupportedNoticed = false
  if (input.modelId && (res.status === 400 || res.status === 422)) {
    try {
      const peek = await res.clone().text()
      if (/model[_\s-]?not[_\s-]?supported/i.test(peek)) {
        modelUnsupportedNoticed = true
        input.pool?.markModelUnsupported(live.key, input.modelId)
        await input.write(markModelUnsupported(nextState, live.key, input.modelId))
      }
    } catch {
      // body unreadable — silently fall through
    }
  }
  if (res.ok) {
    if (input.pool) input.pool.recordSuccess(live.key)
    else recordSuccess(input.runtime, live.key)
    await input.write(clear(nextState, live.key))
  }
  if (ctx.leaseRef.lease) {
    ctx.leaseRef.lease.release()
    ctx.leaseRef.lease = undefined
  }
  touch(input.runtime, live.key)
  void modelUnsupportedNoticed // surfaced via `markModelUnsupported` side-effects only
  return res
}

async function reserveSlot(input: {
  pool?: AccountPool
  runtime: Runtime
  auths: CopilotAuth[]
  state: State
  modelId: string
  providerID?: string
  key: string
  isAgent: boolean
}): Promise<{ lease: Lease | undefined; fallbackRelease?: () => void }> {
  if (input.pool) {
    try {
      const lease = input.isAgent
        ? await input.pool.acquirePreferSecondary(input.key, { timeoutMs: 5 * 60 * 1000 })
        : await input.pool.acquire(input.key, { timeoutMs: 5 * 60 * 1000 })
      return { lease }
    } catch {
      // fall through to the legacy reservation path so we never deadlock the
      // dispatcher just because the pool can't immediately give us the slot.
    }
  }
  const { reserve, reserveBatch } = await import("./runtime")
  const held =
    !input.providerID && input.auths.length > 1
      ? reserveBatch(input.runtime, autobestBatch({
          auths: input.auths,
          state: input.state,
          modelId: input.modelId,
          count: input.runtime.limit,
        }))
      : undefined
  const slot = held?.held.find((item) => item.key === input.key && item.held)
  if (held) {
    held.held.filter((item) => item !== slot).forEach((item) => item.release())
  }
  const pick = slot ?? reserve(input.runtime, input.key)
  return { lease: undefined, fallbackRelease: () => pick.release() }
}

/**
 * Per-account discovery barrier. The first dispatch for a given account key
 * `await`s the promise (bounded by `DISCOVERY_TIMEOUT_MS`); `resolve(key)`
 * releases all waiters once endpoint discovery has completed. Mirrors Rust
 * `AccountPool::wait_for_discovery` / `mark_discovery_complete` in
 * `core/src/account_pool.rs:1576-1610`.
 */
export const DISCOVERY_TIMEOUT_MS = 10_000

export type DiscoveryBarrier = {
  /**
   * Block until discovery resolves for `key`. Returns immediately if the
   * barrier was never `start()`ed for this key (i.e. there's no pending
   * work to wait on) or if `resolve()` has already been called.
   */
  wait(key: string, timeoutMs?: number): Promise<void>
  /**
   * Mark discovery as "in flight" for `key`. Must be called before any
   * `wait()` can actually block — mirrors the Rust pool's implicit
   * "discovery was scheduled" signal from `fetch_account_model_catalog*`.
   */
  start(key: string): void
  /** Release all waiters for `key`. Idempotent. */
  resolve(key: string): void
  done(key: string): boolean
}

export function createDiscoveryBarrier(): DiscoveryBarrier {
  const waiters = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; done: boolean; started: boolean }
  >()
  function slot(key: string) {
    const existing = waiters.get(key)
    if (existing) return existing
    let resolver: () => void = () => {}
    const promise = new Promise<void>((r) => {
      resolver = r
    })
    const entry = { promise, resolve: resolver, done: false, started: false }
    waiters.set(key, entry)
    return entry
  }
  return {
    async wait(key, timeoutMs = DISCOVERY_TIMEOUT_MS) {
      const entry = slot(key)
      if (entry.done) return
      if (!entry.started) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((r) => {
        timer = setTimeout(r, timeoutMs)
      })
      await Promise.race([entry.promise, timeout])
      if (timer) clearTimeout(timer)
    },
    start(key) {
      slot(key).started = true
    },
    resolve(key) {
      const entry = slot(key)
      if (entry.done) return
      entry.done = true
      entry.resolve()
    },
    done(key) {
      return waiters.get(key)?.done ?? false
    },
  }
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
  const resolvedCfg = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get())).catch(() => undefined)
  const cfg = copilotRuntimeConfig(resolvedCfg)
  const runtime = owner(cfg.limit, cfg.minIntervalMs)
  // Attach the adaptive rate limiter. Driven by `copilot.rateLimiter.*`
  // config (see `rate-limiter.ts::copilotRateLimiterConfig`). Env
  // overrides (`OPENCODE_COPILOT_RATE_LIMITER_*`) are resolved there.
  const rlOpts = copilotRateLimiterConfig(resolvedCfg as any)
  runtime.rateLimiter = new CopilotRateLimiter(rlOpts)
  const discoveryBarrier = createDiscoveryBarrier()
  CopilotRuntimeState.current = runtime
  // Boot the AccountPool against the live runtime + SQLite cooldown store.
  // The roster is refreshed lazily in `dispatch` (every call observes the
  // current `auths` + `state.connections.unsupportedModels`).
  const { Global } = await import("@/global")
  const sqlitePath = path.join(Global.Path.data, "copilot-rate-state.sqlite")
  const rateStore = await openRateStore(sqlitePath).catch(() => undefined)
  const pool = new AccountPool({ runtime, store: rateStore })
  CopilotRuntimeState.pool = pool
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

        // Two-step discovery chain: `/copilot_internal/user` → `/models`.
        // Announce start *before* the first network call so concurrent
        // `dispatch` calls block in `wait_for_discovery` until either
        // `.resolve(key)` runs or the bounded timeout fires.
        discoveryBarrier.start(key)
        const disc = await discoverEndpoints({
          token: auth.refresh,
          enterpriseUrl: auth.enterpriseUrl,
          proxy: cfg,
        })
        const apiBase = disc.api ?? base(auth.enterpriseUrl)
        const planSku = disc.sku

        return CopilotModels.get(
          apiBase,
          {
            Authorization: `Bearer ${auth.refresh}`,
            "User-Agent": `opencode/${InstallationVersion}`,
            ...proxyHeaders(cfg?.token),
          },
          provider.models,
          cfg?.url,
          planSku,
        )
          .then(async (models) => {
            const supported = Object.values(models).map((item) => item.api.id)
            const next = discover(storeState, key, {
              models: supported,
              api: apiBase,
              plan: storeState.connections[key]?.plan,
              login: storeState.connections[key]?.login,
              ok: true,
            })
            await writeState(next)
            // Hand the supported model set to the AccountPool so
            // `failoverTokenForModel` can rank Supported > Unknown for
            // this account on subsequent dispatches.
            pool.setAccountCapabilities(key, supported)
            discoveryBarrier.resolve(key)
            return models
          })
          .catch(async (error) => {
            log.error("failed to fetch copilot models", { error })
            const next = discover(storeState, key, {
              models: [],
              api: apiBase,
              plan: storeState.connections[key]?.plan,
              login: storeState.connections[key]?.login,
              ok: false,
              err: error instanceof Error ? error.message : String(error),
            })
            await writeState(next)
            pool.markDiscoveryFailed(key)
            discoveryBarrier.resolve(key)
            return Object.fromEntries(
              Object.entries(provider.models).map(([id, model]) => [id, fix(model, apiBase)]),
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
            // Bounded wait for endpoint discovery. Mirrors Rust
            // `AccountPool::wait_for_discovery` — first dispatch blocks up
            // to 10 s for the `/copilot_internal/user` + `/models` chain
            // to complete; subsequent dispatches resolve immediately.
            const barrierKey = (info as any).accountId ?? "github-copilot"
            await discoveryBarrier.wait(barrierKey)
            const auths = await allAuths()
            // Keep the pool's roster in sync with the live auth list. This
            // is cheap (`setAccounts` is a Map rebuild) and ensures
            // `acquire`/`shouldThrottleSpawns` see freshly-added accounts
            // without restarting the process.
            pool.setAccounts(auths.map((a) => ({ key: a.key, label: a.label })))
            // Hydrate persisted per-account `unsupportedModels` into the
            // pool capability cache so `failoverTokenForModel` skips
            // accounts that have already been rejected for the requested
            // model.
            const currentState = await readState()
            for (const auth of auths) {
              const list = currentState.connections[auth.key]?.unsupportedModels
              if (!list || list.length === 0) continue
              for (const m of list) pool.markModelUnsupported(auth.key, m)
            }
            return dispatch({
              getAuth,
              auths,
              read: readState,
              write: writeState,
              premium,
              runtime,
              pool,
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
                // Cap `slow_down` retries at 10 to avoid trapping the login
                // flow indefinitely. Mirrors the Rust device-flow guard
                // (`device_flow.rs:233-240`).
                let slowDownCount = 0
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
                    slowDownCount += 1
                    if (slowDownCount > 10) {
                      return { type: "failed" as const }
                    }
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
