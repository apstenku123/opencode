import type { CopilotAuth } from "./auth"

// ---------------------------------------------------------------------------
// Constants mirroring `codex-rs/core/src/account_pool.rs`.
//
// Stepped recovery after a 429:
//   < PARTIAL_RECOVERY_MS          → 1 slot
//   >= PARTIAL_RECOVERY_MS         → 2 slots
//   >= SECOND_RECOVERY_MS          → 4 slots (clamped by per-account cap)
//   >= FULL_RECOVERY_MS            → full per-account cap
//
// Request-pacing (`minIntervalFor`) drops through matching thresholds:
//   30s → 20s → 12s → 7.5s (healthy).
//
// Headerless 429 escalator: 11m → 21m → 41m. Count resets after a clear that
// lands on a success more than `HEADERLESS_429_RESET_MS` after the last 429.
// ---------------------------------------------------------------------------

export const MAX_AGENTS_PER_ACCOUNT = 7

export const PARTIAL_RECOVERY_MS = 5 * 60 * 1000
export const SECOND_RECOVERY_MS = 7 * 60 * 1000
export const FULL_RECOVERY_MS = 9 * 60 * 1000

export const INITIAL_REQUEST_INTERVAL_MS = 30_000
export const PARTIAL_REQUEST_INTERVAL_MS = 20_000
export const SECOND_REQUEST_INTERVAL_MS = 12_000
export const HEALTHY_REQUEST_INTERVAL_MS = 7_500

export const HEADERLESS_429_FALLBACK_DELAYS_MS: readonly number[] = [
  11 * 60 * 1000,
  21 * 60 * 1000,
  41 * 60 * 1000,
]

// Reset the escalator if a successful request lands this long after the last
// 429 (mirrors the 24h "clean run" semantics requested in the port spec).
export const HEADERLESS_429_RESET_MS = 24 * 60 * 60 * 1000

// Bounded `acquire` timeout — matches Rust `ACQUIRE_TIMEOUT`.
export const ACQUIRE_TIMEOUT_MS = 5 * 60 * 1000

export type Reserve = {
  key: string
  held: boolean
  release: () => void
}

export type Pool = Record<string, number>

export type Event = {
  at: number
  key: string
  type: "reserve" | "release" | "touch"
  load: number
  lane?: string
  discovery?: number
  penalty?: number
  cooldown?: boolean
}

/**
 * Per-account rate-limit book-keeping tracked inside the runtime.
 *
 * `exhaustedUntil` is the live cooldown deadline (ms since epoch). It is a
 * duplicate of the value persisted in `connections.exhaustedUntil` — runtime
 * holds it for quick in-memory gating without a state read.
 */
export type RateState = {
  exhaustedUntil?: number
  last429At?: number
  headerless429Count: number
  requestAvailableAt?: number
}

export type Runtime = {
  pool: Pool
  limit: number
  minIntervalMs: number
  last: Record<string, number>
  feed: Event[]
  rate: Record<string, RateState>
}

export function emptyPool(): Pool {
  return {}
}

export function owner(limit = 1, minIntervalMs = 0): Runtime {
  return { pool: emptyPool(), limit, minIntervalMs, last: {}, feed: [], rate: {} }
}

export function event(state: Runtime, type: Event["type"], key: string, at = Date.now(), meta?: Partial<Omit<Event, "at" | "key" | "type" | "load">>) {
  state.feed = [
    { at, key, type, load: load(state, key), ...meta },
    ...state.feed,
  ].slice(0, 24)
  return state
}

export function runtime(pool: Pool | undefined, key: string) {
  return pool?.[key] ?? 0
}

export function acquire(pool: Pool | undefined, key: string) {
  return {
    ...pool,
    [key]: runtime(pool, key) + 1,
  }
}

export function release(pool: Pool | undefined, key: string) {
  const count = runtime(pool, key)
  if (count <= 1) {
    const next = { ...pool }
    delete next[key]
    return next
  }
  return {
    ...pool,
    [key]: count - 1,
  }
}

/**
 * Per-account effective slot cap at `now`, accounting for stepped recovery
 * after a 429. When no 429 has been recorded, returns the per-account cap
 * (the runtime's `limit`). Mirrors Rust `account_parallel_limit`.
 */
export function effectiveLimit(state: Runtime | undefined, key: string, now = Date.now()) {
  const cap = state?.limit ?? 1
  const rate = state?.rate?.[key]
  if (!rate) return cap
  if (rate.exhaustedUntil !== undefined && rate.exhaustedUntil > now) return 0
  if (rate.last429At === undefined) return cap
  const elapsed = now - rate.last429At
  if (elapsed >= FULL_RECOVERY_MS) return cap
  if (elapsed >= SECOND_RECOVERY_MS) return Math.min(cap, 4)
  if (elapsed >= PARTIAL_RECOVERY_MS) return Math.min(cap, 2)
  return Math.min(cap, 1)
}

export function available(state: Runtime | undefined, key: string, now = Date.now()) {
  return runtime(state?.pool, key) < effectiveLimit(state, key, now)
}

export function eligible(state: Runtime | undefined, auths: CopilotAuth[], now = Date.now()) {
  const idle = auths.filter((item) => available(state, item.key, now))
  return idle.length > 0 ? idle : auths
}

/**
 * Post-429 per-account minimum request interval (Rust
 * `request_interval_for_last_429`).  Used to back off between requests on a
 * recovering account independent of the global `minIntervalMs`.
 */
/**
 * Per-account minimum request interval.
 *
 * With no recorded 429, returns the configured `minIntervalMs` as-is — this
 * preserves the existing "0 = no pacing" opt-in behaviour. After a 429, the
 * interval floor is lifted to the stepped-recovery bucket (30s → 20s → 12s
 * → 7.5s) mirroring Rust `request_interval_for_last_429`.
 */
export function minIntervalFor(state: Runtime | undefined, key: string, now = Date.now()) {
  const last429 = state?.rate?.[key]?.last429At
  const base = state?.minIntervalMs ?? 0
  if (last429 === undefined) return base
  const elapsed = now - last429
  if (elapsed >= FULL_RECOVERY_MS) return Math.max(base, HEALTHY_REQUEST_INTERVAL_MS)
  if (elapsed >= SECOND_RECOVERY_MS) return Math.max(base, SECOND_REQUEST_INTERVAL_MS)
  if (elapsed >= PARTIAL_RECOVERY_MS) return Math.max(base, PARTIAL_REQUEST_INTERVAL_MS)
  return Math.max(base, INITIAL_REQUEST_INTERVAL_MS)
}

export function cooldown(state: Runtime | undefined, key: string, now = Date.now()) {
  const at = state?.last[key]
  if (!at) return false
  const min = minIntervalFor(state, key, now)
  if (!min) return false
  return now - at < min
}

export function load(state: Runtime | undefined, key: string) {
  return runtime(state?.pool, key)
}

export function touch(state: Runtime, key: string, at = Date.now()) {
  state.last[key] = at
  event(state, "touch", key, at)
  return state
}

export type Usage = {
  key: string
  load: number
  last: number | null
}

export function reserve(state: Runtime, key: string): Reserve {
  state.pool = acquire(state.pool, key)
  event(state, "reserve", key)
  return {
    key,
    held: true,
    release() {
      if (!this.held) return
      this.held = false
      state.pool = release(state.pool, key)
      event(state, "release", key)
    },
  }
}

export function reserveBatch(state: Runtime, keys: string[]) {
  const held = keys.map((key) => reserve(state, key))
  return {
    held,
    release(key: string) {
      const slot = held.find((item) => item.key === key)
      slot?.release()
    },
    releaseAll() {
      held.forEach((item) => item.release())
    },
  }
}

export function usage(state: Runtime | undefined) {
  const keys = new Set([...Object.keys(state?.pool ?? {}), ...Object.keys(state?.last ?? {})])
  return [...keys]
    .map((key) => ({ key, load: load(state, key), last: state?.last[key] ?? null }))
    .sort((a, b) => b.load - a.load || a.key.localeCompare(b.key))
}

export function feed(state: Runtime | undefined) {
  return state?.feed ?? []
}

// ---------------------------------------------------------------------------
// 429 escalator
// ---------------------------------------------------------------------------

function rateOf(state: Runtime, key: string): RateState {
  const existing = state.rate[key]
  if (existing) return existing
  const created: RateState = { headerless429Count: 0 }
  state.rate[key] = created
  return created
}

/**
 * Compute the next cooldown delay for a 429 event. If `retryAfterMs` is
 * provided, that value wins (with a floor of 0) and the headerless escalator
 * counter is reset. Otherwise the escalator advances: 11m → 21m → 41m and
 * caps at the last bucket.
 *
 * Returns `{ delayMs, until, count }` describing the new cooldown — the
 * caller is responsible for persisting `until` on the connection record.
 */
export function record429(
  state: Runtime,
  key: string,
  input?: { retryAfterMs?: number; now?: number },
) {
  const now = input?.now ?? Date.now()
  const rate = rateOf(state, key)
  let delayMs: number
  if (typeof input?.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0) {
    delayMs = input.retryAfterMs
    rate.headerless429Count = 0
  } else {
    const index = Math.min(rate.headerless429Count, HEADERLESS_429_FALLBACK_DELAYS_MS.length - 1)
    delayMs = HEADERLESS_429_FALLBACK_DELAYS_MS[index]!
    rate.headerless429Count += 1
  }
  rate.last429At = now
  // Monotonic exhaustion — never shorten an existing cooldown.
  const nextUntil = now + delayMs
  rate.exhaustedUntil = Math.max(rate.exhaustedUntil ?? 0, nextUntil)
  rate.requestAvailableAt = now + minIntervalFor(state, key, now)
  return {
    delayMs,
    until: rate.exhaustedUntil,
    count: rate.headerless429Count,
  }
}

/**
 * Parse `Retry-After` (seconds or HTTP-date). Returns `undefined` when
 * absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) return Math.trunc(secs * 1000)
  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return undefined
}

/**
 * Record a successful request. If the account has gone more than
 * `HEADERLESS_429_RESET_MS` since its last 429, the escalator counter is
 * reset — mirrors the Rust "24h clean run" behaviour.
 */
export function recordSuccess(state: Runtime, key: string, now = Date.now()) {
  const rate = state.rate[key]
  if (!rate) return
  rate.exhaustedUntil = undefined
  rate.requestAvailableAt = undefined
  if (rate.last429At && now - rate.last429At >= HEADERLESS_429_RESET_MS) {
    rate.headerless429Count = 0
    rate.last429At = undefined
  }
}

/**
 * Synchronise in-memory rate state with a cooldown deadline read back from
 * disk (e.g. on boot). Does not advance the escalator.
 */
export function hydrateExhaustion(state: Runtime, key: string, until: number | undefined) {
  const rate = rateOf(state, key)
  rate.exhaustedUntil = until
}
