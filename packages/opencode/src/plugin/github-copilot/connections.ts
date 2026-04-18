import { connectionFile } from "./paths"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect, Schema } from "effect"
import { zod } from "@/util/effect-zod"
import type { CopilotAuth } from "./auth"

const Discovery = Schema.Struct({
  at: Schema.Number,
  models: Schema.Array(Schema.String),
  api: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  ok: Schema.optional(Schema.Boolean),
  err: Schema.optional(Schema.String),
})

const Conn = Schema.Struct({
  exhaustedUntil: Schema.optional(Schema.Number),
  lastTestedAt: Schema.optional(Schema.Number),
  lastRoutedAt: Schema.optional(Schema.Number),
  lastDiscoveryErrorAt: Schema.optional(Schema.Number),
  label: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  preferred: Schema.optional(Schema.Boolean),
  deactivated: Schema.optional(Schema.Boolean),
  machineId: Schema.optional(Schema.String),
  proxyUrl: Schema.optional(Schema.String),
  proxyToken: Schema.optional(Schema.String),
  /**
   * Per-account opt-in for the Rust-compatible `POST {proxy}/fetch` envelope
   * protocol. Set automatically when a credential is imported from
   * `~/.copilot/auth/credential.json` (the Rust CLI always envelopes via
   * the GCP fetch-proxy). Manual connections (URL-rewrite mode) omit this.
   */
  envelope: Schema.optional(Schema.Boolean),
  discovery: Schema.optional(Discovery),
  /**
   * Models the server has rejected with `model_not_supported` for this
   * account. Mirrors Rust `AccountCapabilityState.unsupported_models`
   * (`account_pool.rs:1632-1658`).  Used by `failoverTokenForModel` so
   * routing skips accounts known to fail for the requested model.
   */
  unsupportedModels: Schema.optional(Schema.Array(Schema.String)),
})

const State = Schema.Struct({
  version: Schema.Number,
  preferred: Schema.optional(Schema.String),
  connections: Schema.Record(Schema.String, Conn),
})

export type Conn = typeof Conn.Type
export type State = typeof State.Type

export const StateSchema = Object.assign(State, { zod: zod(State) })

export function empty(): State {
  return { version: 1, connections: {} }
}

/**
 * `true` if test-only accounts (keys matching `github-copilot#edu-*`)
 * should be included in routing. Mirrors the Rust
 * `ConnectionManager::with_test_accounts` flag. Defaults to `false` in
 * production; set `OPENCODE_ALLOW_TEST_ACCOUNTS=1` to opt in (e.g. for
 * E2E coverage).
 */
export function allowTestAccounts(): boolean {
  return process.env.OPENCODE_ALLOW_TEST_ACCOUNTS === "1"
}

/** Returns `true` when the key matches the test-account pattern. */
export function isTestAccountKey(key: string): boolean {
  return /^github-copilot#edu-/.test(key)
}

/** Drop test accounts unless they have been explicitly allowed. */
export function filterTestAccounts<T extends { key: string }>(items: T[]): T[] {
  if (allowTestAccounts()) return items
  return items.filter((item) => !isTestAccountKey(item.key))
}

/**
 * Clear any `exhaustedUntil` entries that have already elapsed. Mirrors
 * the in-place stale-exhaustion auto-clear performed by Rust's
 * `ConnectionManager::get_connections` before returning the sorted list
 * (`connections.rs:148-189`).
 */
export function clearStaleExhaustion(state: State, now = Date.now()): State {
  let changed = false
  const connections: Record<string, Conn> = {}
  for (const [key, conn] of Object.entries(state.connections)) {
    const until = conn.exhaustedUntil
    if (until !== undefined && until <= now) {
      const { exhaustedUntil: _dropped, ...rest } = conn
      connections[key] = rest
      changed = true
    } else {
      connections[key] = conn
    }
  }
  return changed ? { ...state, connections } : state
}

export function sort(auths: CopilotAuth[], state: State) {
  return filterTestAccounts(
    [...auths].sort((a, b) => {
      if (state.preferred === a.key) return -1
      if (state.preferred === b.key) return 1
      if (a.key === "github-copilot") return -1
      if (b.key === "github-copilot") return 1
      return a.key.localeCompare(b.key)
    }),
  )
}

export function next(auths: CopilotAuth[], state: State, now = Date.now()) {
  const items = sort(auths, state)
  const live = items.filter((item) => {
    const conn = state.connections[item.key]
    if (conn?.deactivated) return false
    const until = conn?.exhaustedUntil
    return !until || until <= now
  })
  if (live.length > 0) return live[0]
  // Fall back to any non-deactivated entry before returning the first.
  const active = items.filter((item) => !state.connections[item.key]?.deactivated)
  if (active.length > 0) return active[0]
  return items[0]
}

export function rotate(state: State, auths: CopilotAuth[]) {
  return [...auths].sort((a, b) => {
    const av = state.connections[a.key]?.lastRoutedAt ?? 0
    const bv = state.connections[b.key]?.lastRoutedAt ?? 0
    if (av !== bv) return av - bv
    return sort([a, b], state)[0]?.key === a.key ? -1 : 1
  })
}

export function routed(state: State, key: string, at = Date.now()) {
  return upsert(state, key, { lastRoutedAt: at })
}

export function upsert(state: State, key: string, input: Partial<Conn>): State {
  return {
    ...state,
    connections: {
      ...state.connections,
      [key]: {
        ...state.connections[key],
        ...input,
      },
    },
  }
}

/**
 * Mark the account exhausted until at least `until`. Mirrors Rust's
 * `set_exhaustion` (`connections.rs:326-345`) — monotonic: never
 * shortens an existing cooldown.
 */
export function mark(state: State, key: string, until: number) {
  const existing = state.connections[key]?.exhaustedUntil ?? 0
  return upsert(state, key, { exhaustedUntil: Math.max(existing, until) })
}

export function clear(state: State, key: string) {
  const item = state.connections[key]
  if (!item) return state
  return upsert(state, key, { exhaustedUntil: undefined })
}

/** Mark the account as deactivated (401/403 from the Copilot API). */
export function markDeactivated(state: State, key: string): State {
  return upsert(state, key, { deactivated: true })
}

/** Clear the deactivated flag, e.g. after a successful re-auth. */
export function clearDeactivated(state: State, key: string): State {
  return upsert(state, key, { deactivated: undefined })
}

export function isDeactivated(state: State, key: string): boolean {
  return state.connections[key]?.deactivated === true
}

export function machine(state: State, key: string) {
  const item = state.connections[key]
  if (item?.machineId) return [state, item.machineId] as const
  const machineId = crypto.randomUUID().toLowerCase()
  return [upsert(state, key, { machineId }), machineId] as const
}

export function discovered(state: State, key: string) {
  return state.connections[key]?.discovery
}

export function discover(
  state: State,
  key: string,
  input: {
    at?: number
    models: string[]
    api?: string
    plan?: string
    login?: string
    ok?: boolean
    err?: string
  },
) {
  const at = input.at ?? Date.now()
  return upsert(state, key, {
    discovery: {
      at,
      models: [...new Set(input.models)].sort(),
      api: input.api,
      plan: input.plan,
      login: input.login,
      ok: input.ok,
      err: input.err,
    },
    lastDiscoveryErrorAt: input.ok === false || input.err ? at : undefined,
  })
}

export function clearDiscovery(state: State, key: string) {
  return upsert(state, key, { discovery: undefined })
}

export function hasModel(state: State, key: string, model: string) {
  return !!state.connections[key]?.discovery?.models.includes(model)
}

/**
 * Add `model` to the per-account `unsupportedModels` list.  Mirrors Rust
 * `AccountPool::mark_model_unsupported` persistence side-effect — the
 * runtime in-memory pool also gets the same flag separately.
 *
 * As a side-effect, clears any cooldown longer than `STALE_COOLDOWN_THRESHOLD_MS`
 * (1h) on the same account: those are almost always leftovers from the legacy
 * 24-hour `model_not_supported` eviction, not real 429 backoff.
 */
export const STALE_COOLDOWN_THRESHOLD_MS = 60 * 60 * 1000

export function markModelUnsupported(state: State, key: string, model: string, now = Date.now()): State {
  const existing = state.connections[key]?.unsupportedModels ?? []
  const set = new Set(existing)
  set.add(model)
  const conn = state.connections[key]
  const stale = conn?.exhaustedUntil !== undefined && conn.exhaustedUntil > now + STALE_COOLDOWN_THRESHOLD_MS
  return upsert(state, key, {
    unsupportedModels: [...set].sort(),
    ...(stale ? { exhaustedUntil: undefined } : {}),
  })
}

/** Remove `model` from `unsupportedModels` (e.g. after a successful re-discovery). */
export function clearModelUnsupported(state: State, key: string, model: string): State {
  const existing = state.connections[key]?.unsupportedModels
  if (!existing || !existing.includes(model)) return state
  const next = existing.filter((item) => item !== model)
  return upsert(state, key, { unsupportedModels: next.length > 0 ? next : undefined })
}

export function isModelUnsupported(state: State, key: string, model: string): boolean {
  return !!state.connections[key]?.unsupportedModels?.includes(model)
}

export function staleDiscovery(state: State, key: string, now = Date.now(), max = 30 * 60 * 1000) {
  const item = state.connections[key]?.discovery
  if (!item) return true
  return now - item.at > max
}

export class Store {
  constructor(private fs: AppFileSystem.Interface) {}

  read = Effect.fn("CopilotConnections.read")(
    function* (this: Store) {
      const raw = (yield* this.fs.readJson(connectionFile).pipe(Effect.orElseSucceed(() => empty()))) as unknown
      const parsed = Schema.decodeUnknownOption(State)(raw)
      const value = parsed._tag === "Some" ? parsed.value : empty()
      // Mirror Rust's in-place stale-exhaustion auto-clear so callers never
      // see expired cooldowns (connections.rs:148-189).
      return clearStaleExhaustion(value)
    }.bind(this),
  )

  write = Effect.fn("CopilotConnections.write")(
    function* (this: Store, state: State) {
      yield* this.fs.writeJson(connectionFile, state, 0o600)
    }.bind(this),
  )
}

export function byPlan(state: State, key: string) {
  return state.connections[key]?.plan
}

export function proxy(state: State, key: string) {
  return {
    url: state.connections[key]?.proxyUrl,
    token: state.connections[key]?.proxyToken,
    envelope: state.connections[key]?.envelope,
  }
}
