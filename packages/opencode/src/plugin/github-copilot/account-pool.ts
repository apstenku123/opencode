/**
 * AccountPool — evolution of the flat `Runtime.pool` map into a structure
 * that knows about a primary account, zero or more backup accounts, per-slot
 * concurrency caps and stepped post-429 recovery.
 *
 * Ported from `codex-rs/core/src/account_pool.rs`. This round-1 port keeps
 * the API deliberately small: `acquire`, `release`, `recordExhaustion`,
 * `recordSuccess`, `availableSlots`.
 *
 *   - `acquire(key)` returns an async-disposable `Lease` or throws after
 *     `ACQUIRE_TIMEOUT_MS` if no slot opens up.  Leases have an RAII-style
 *     `release()` method that's also invoked automatically by a GC pass over
 *     stale leases (drop-on-finalizer is approximated via `setInterval`).
 *   - `recordExhaustion(key, delay?)` applies the headerless-429 escalator
 *     (11 → 21 → 41 min) when `delay` is omitted; when `delay` is provided
 *     (typically from the `Retry-After` header) that value wins and the
 *     escalator counter resets.
 *   - `availableSlots(key)` returns the effective per-account slot budget
 *     given the stepped-recovery state (1 → 2 → 4 → full at 5/7/9 min).
 *
 * The pool is pure TypeScript (Promise + AbortController) so it is safe to
 * use from Effect fibers or plain async functions interchangeably.
 */

import {
  ACQUIRE_TIMEOUT_MS,
  HEADERLESS_429_FALLBACK_DELAYS_MS,
  MAX_AGENTS_PER_ACCOUNT,
  effectiveLimit,
  ensureRate,
  hydrateExhaustion as hydrateRateState,
  owner,
  parseRetryAfter,
  record429,
  recordSuccess,
  type Runtime,
} from "./runtime"
import type { RateRow, RateStore } from "./account-pool-sqlite"

/**
 * Per-account model capability classification — mirrors Rust
 * `core/src/account_pool.rs::ModelCapability`. Hard priority during
 * model-aware failover: `Supported > Unknown > DiscoveryFailed > Unsupported`
 * (lower rank wins; `Unsupported` is skipped entirely).
 */
export type ModelCapability = "Supported" | "Unknown" | "DiscoveryFailed" | "Unsupported"

const CAPABILITY_RANK: Record<ModelCapability, number> = {
  Supported: 0,
  Unknown: 1,
  DiscoveryFailed: 2,
  Unsupported: Number.MAX_SAFE_INTEGER,
}

/** Cooldowns longer than this are presumed stale (legacy 24h evictions). */
export const STALE_COOLDOWN_THRESHOLD_MS = 60 * 60 * 1000

export type AccountEntry = {
  key: string
  label?: string
  /** `true` when this account is the primary (main oauth) account. */
  primary?: boolean
}

export type Lease = {
  key: string
  held: boolean
  release(): void
  /** Allow `await using lease = …` in callers that want RAII. */
  [Symbol.dispose]?(): void
}

export type AcquireOptions = {
  signal?: AbortSignal
  /** Timeout in ms; defaults to `ACQUIRE_TIMEOUT_MS` (5 min). */
  timeoutMs?: number
  /** Skip the primary account if any backup is currently assignable. */
  preferSecondary?: boolean
  now?: number
}

export type RecordExhaustionOptions = {
  /** Explicit delay (ms). When set, bypasses the headerless escalator. */
  delayMs?: number
  /** Raw `Retry-After` header value (seconds or HTTP-date). */
  retryAfter?: string | null
  now?: number
}

type Waiter = {
  key?: string
  preferSecondary: boolean
  resolve(lease: Lease): void
  reject(err: Error): void
  expiresAt: number
  signal?: AbortSignal
  listener?: () => void
  timer?: ReturnType<typeof setTimeout>
}

type LeaseRecord = {
  key: string
  release(): void
  createdAt: number
}

type CapabilityState = {
  unsupported: Set<string>
  supported: Set<string>
  discoveryFailed: boolean
}

export class AccountPool {
  readonly runtime: Runtime
  private accounts: AccountEntry[] = []
  private waiters: Waiter[] = []
  private leases = new Set<LeaseRecord>()
  private gc: ReturnType<typeof setInterval> | undefined
  private capabilities = new Map<string, CapabilityState>()
  private store: RateStore | undefined

  /**
   * Max lease lifetime before the GC forcibly releases it. Defaults to the
   * acquire timeout. Override for long-running streaming requests if needed.
   */
  leaseTTL = ACQUIRE_TIMEOUT_MS

  constructor(input: {
    accounts?: AccountEntry[]
    runtime?: Runtime
    limit?: number
    minIntervalMs?: number
    /** Optional persistence store (see `account-pool-sqlite.ts`). */
    store?: RateStore
  } = {}) {
    this.runtime =
      input.runtime ?? owner(input.limit ?? MAX_AGENTS_PER_ACCOUNT, input.minIntervalMs ?? 0)
    if (input.store) this.attachStore(input.store)
    if (input.accounts) this.setAccounts(input.accounts)
  }

  /**
   * Attach a persistence store and hydrate the runtime rate book-keeping
   * with whatever it returns from {@link RateStore.loadAll}. Subsequent
   * `recordExhaustion` / `recordSuccess` calls will write through.
   */
  attachStore(store: RateStore) {
    this.store = store
    for (const row of store.loadAll()) this.hydrateExhaustion(row)
  }

  /**
   * Apply a snapshot row read from disk. Mirrors Rust
   * `AccountPoolPersistence::with_root` boot-time `snapshot.retain` step.
   */
  hydrateExhaustion(row: RateRow) {
    const rate = ensureRate(this.runtime, row.key)
    if (row.exhaustedUntil !== undefined) hydrateRateState(this.runtime, row.key, row.exhaustedUntil)
    rate.headerless429Count = row.headerless429Count
    if (row.last429At !== undefined) rate.last429At = row.last429At
  }

  /** Replace the account roster. The primary flag, if absent, defaults to
   *  the account with key `"github-copilot"`. */
  setAccounts(accounts: AccountEntry[]) {
    const hasExplicit = accounts.some((item) => item.primary)
    this.accounts = accounts.map((item) => ({
      ...item,
      primary: hasExplicit ? item.primary === true : item.key === "github-copilot",
    }))
    // Wake waiters — the set of candidate keys may have changed.
    this.flush()
  }

  getAccounts(): AccountEntry[] {
    return [...this.accounts]
  }

  /** Start the lease-GC timer. Safe to call multiple times. */
  start() {
    if (this.gc) return
    this.gc = setInterval(() => this.collect(), Math.min(30_000, this.leaseTTL))
    // Don't keep the event loop alive for the GC alone.
    ;(this.gc as any)?.unref?.()
  }

  /** Stop the GC timer and reject all pending waiters. */
  stop() {
    if (this.gc) {
      clearInterval(this.gc)
      this.gc = undefined
    }
    const waiters = this.waiters
    this.waiters = []
    waiters.forEach((w) => {
      if (w.timer) clearTimeout(w.timer)
      if (w.signal && w.listener) w.signal.removeEventListener("abort", w.listener)
      w.reject(new Error("AccountPool stopped"))
    })
  }

  private collect(now = Date.now()) {
    if (this.leaseTTL <= 0) return
    for (const lease of this.leases) {
      if (now - lease.createdAt > this.leaseTTL) {
        lease.release()
      }
    }
  }

  /** Effective slot budget for `key` after stepped recovery. */
  availableSlots(key: string, now = Date.now()) {
    const limit = effectiveLimit(this.runtime, key, now)
    const inUse = this.runtime.pool[key] ?? 0
    return Math.max(0, limit - inUse)
  }

  private candidates(preferSecondary: boolean): AccountEntry[] {
    if (!preferSecondary) return this.accounts
    const backups = this.accounts.filter((item) => !item.primary)
    const now = Date.now()
    const anyBackupAssignable = backups.some((item) => this.availableSlots(item.key, now) > 0)
    return anyBackupAssignable ? backups : this.accounts
  }

  private tryImmediate(key: string | undefined, preferSecondary: boolean, now: number): Lease | undefined {
    const pool = this.candidates(preferSecondary)
    if (key) {
      const match = pool.find((item) => item.key === key)
      if (!match) return undefined
      if (this.availableSlots(match.key, now) <= 0) return undefined
      return this.reserve(match.key, now)
    }
    // Best-headroom pick among candidates.
    let best: { key: string; slots: number } | undefined
    for (const item of pool) {
      const slots = this.availableSlots(item.key, now)
      if (slots <= 0) continue
      if (!best || slots > best.slots) best = { key: item.key, slots }
    }
    if (!best) return undefined
    return this.reserve(best.key, now)
  }

  private reserve(key: string, now: number): Lease {
    this.runtime.pool[key] = (this.runtime.pool[key] ?? 0) + 1
    this.runtime.feed = [
      { at: now, key, type: "reserve" as const, load: this.runtime.pool[key]! },
      ...this.runtime.feed,
    ].slice(0, 24)
    const record: LeaseRecord = {
      key,
      createdAt: now,
      release: () => this.releaseLease(record),
    }
    this.leases.add(record)
    const lease: Lease = {
      key,
      held: true,
      release() {
        if (!this.held) return
        this.held = false
        record.release()
      },
    }
    lease[Symbol.dispose] = () => lease.release()
    return lease
  }

  private releaseLease(record: LeaseRecord) {
    if (!this.leases.delete(record)) return
    const count = this.runtime.pool[record.key] ?? 0
    if (count <= 1) delete this.runtime.pool[record.key]
    else this.runtime.pool[record.key] = count - 1
    this.runtime.feed = [
      {
        at: Date.now(),
        key: record.key,
        type: "release" as const,
        load: this.runtime.pool[record.key] ?? 0,
      },
      ...this.runtime.feed,
    ].slice(0, 24)
    this.flush()
  }

  /**
   * Public API requested in the porting brief. Accepts either a specific
   * `key` or `undefined` to pick the best-headroom candidate. Throws on
   * timeout / abort / pool stopped.
   */
  async acquire(key?: string, options: AcquireOptions = {}): Promise<Lease> {
    const now = options.now ?? Date.now()
    const preferSecondary = options.preferSecondary ?? false
    const immediate = this.tryImmediate(key, preferSecondary, now)
    if (immediate) return immediate

    const timeoutMs = options.timeoutMs ?? ACQUIRE_TIMEOUT_MS
    return await new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        preferSecondary,
        resolve,
        reject,
        expiresAt: now + timeoutMs,
        signal: options.signal,
      }
      if (options.signal) {
        if (options.signal.aborted) {
          reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("aborted"))
          return
        }
        waiter.listener = () => {
          this.removeWaiter(waiter)
          reject(
            waiter.signal?.reason instanceof Error ? waiter.signal.reason : new Error("aborted"),
          )
        }
        options.signal.addEventListener("abort", waiter.listener, { once: true })
      }
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter)
        reject(new Error(`AccountPool.acquire timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      ;(waiter.timer as any)?.unref?.()
      this.waiters.push(waiter)
    })
  }

  private removeWaiter(waiter: Waiter) {
    const idx = this.waiters.indexOf(waiter)
    if (idx >= 0) this.waiters.splice(idx, 1)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.listener) waiter.signal.removeEventListener("abort", waiter.listener)
  }

  /**
   * Explicit release hook mirrors the Rust `release_failover_reservation`
   * entry. Prefer `lease.release()`; this is exposed for callers that only
   * have the key (e.g. crash recovery paths).
   */
  release(key: string) {
    for (const lease of this.leases) {
      if (lease.key !== key) continue
      lease.release()
      return true
    }
    return false
  }

  private flush() {
    if (this.waiters.length === 0) return
    const now = Date.now()
    // Iterate a snapshot because `tryImmediate` mutates waiter list on resolve.
    const pending = [...this.waiters]
    for (const waiter of pending) {
      if (waiter.expiresAt <= now) continue
      const lease = this.tryImmediate(waiter.key, waiter.preferSecondary, now)
      if (!lease) continue
      this.removeWaiter(waiter)
      waiter.resolve(lease)
    }
  }

  /**
   * Apply a 429. When `retryAfter` is provided, it wins over the escalator
   * (the same pattern used by Rust's `record_429`). Returns the computed
   * cooldown details so callers can persist `until` on the connection state.
   */
  recordExhaustion(key: string, options: RecordExhaustionOptions = {}) {
    const now = options.now ?? Date.now()
    let retryAfterMs: number | undefined = options.delayMs
    if (retryAfterMs === undefined) {
      retryAfterMs = parseRetryAfter(options.retryAfter ?? null, now)
    }
    const result = record429(this.runtime, key, { retryAfterMs, now })
    this.persist(key)
    // An exhaustion shrinks the effective slot budget to 0 — wake waiters
    // targeting other keys so they may pick a different account.
    this.flush()
    return result
  }

  recordSuccess(key: string, now = Date.now()) {
    recordSuccess(this.runtime, key, now)
    this.persist(key)
    this.flush()
  }

  private persist(key: string) {
    if (!this.store) return
    const rate = this.runtime.rate[key]
    if (!rate) {
      this.store.remove(key)
      return
    }
    if (rate.exhaustedUntil === undefined && rate.last429At === undefined && rate.headerless429Count === 0) {
      this.store.remove(key)
      return
    }
    this.store.upsert({
      key,
      exhaustedUntil: rate.exhaustedUntil,
      headerless429Count: rate.headerless429Count,
      last429At: rate.last429At,
    })
  }

  // ---------------------------------------------------------------------------
  // Model capability tracking + model-aware failover
  // ---------------------------------------------------------------------------

  private capabilityState(key: string): CapabilityState {
    let state = this.capabilities.get(key)
    if (!state) {
      state = { unsupported: new Set(), supported: new Set(), discoveryFailed: false }
      this.capabilities.set(key, state)
    }
    return state
  }

  /** Replace the supported-model set for an account; clears the discovery-failed flag. */
  setAccountCapabilities(key: string, supportedModels: Iterable<string>) {
    const state = this.capabilityState(key)
    state.supported = new Set(supportedModels)
    state.discoveryFailed = false
    state.unsupported.forEach((model) => {
      // A model showing up on the supported list outranks a stale unsupported flag.
      if (state.supported.has(model)) state.unsupported.delete(model)
    })
    this.flush()
  }

  /** Mark capability discovery as failed (network error / non-2xx). */
  markDiscoveryFailed(key: string) {
    const state = this.capabilityState(key)
    state.discoveryFailed = true
    this.flush()
  }

  /**
   * Mark a single model as unsupported on `key`.
   *
   * Mirrors Rust `AccountPool::mark_model_unsupported` (`account_pool.rs:1632-1658`).
   * As a side-effect, clears any rate-limit cooldown longer than 1 hour on
   * the same account — those are almost certainly leftovers from the legacy
   * 24-hour `model_not_supported` eviction, not a real 429 backoff.
   */
  markModelUnsupported(key: string, modelId: string, now = Date.now()) {
    const state = this.capabilityState(key)
    state.unsupported.add(modelId)
    state.supported.delete(modelId)
    const rate = this.runtime.rate[key]
    if (rate?.exhaustedUntil !== undefined && rate.exhaustedUntil > now + STALE_COOLDOWN_THRESHOLD_MS) {
      rate.exhaustedUntil = undefined
      rate.headerless429Count = 0
      rate.requestAvailableAt = undefined
      this.persist(key)
    }
    this.flush()
  }

  /** Capability classification for a (key, model) pair. */
  modelCapability(key: string, modelId: string): ModelCapability {
    const state = this.capabilities.get(key)
    if (!state) return "Unknown"
    if (state.unsupported.has(modelId)) return "Unsupported"
    if (state.supported.has(modelId)) return "Supported"
    if (state.discoveryFailed) return "DiscoveryFailed"
    return "Unknown"
  }

  /**
   * Pick the best alternate account for `modelId` excluding `currentKey`.
   * Mirrors Rust `AccountPool::failover_token_for_model`
   * (`account_pool.rs:1038-1142`).
   *
   *   - hard priority on capability rank (Supported > Unknown > DiscoveryFailed)
   *   - never returns an `Unsupported` account
   *   - tie-breaks on more available headroom
   *   - returns `undefined` when no alternate is currently assignable
   */
  failoverTokenForModel(currentKey: string, modelId: string, now = Date.now()): string | undefined {
    let best: { key: string; rank: number; slots: number } | undefined
    for (const account of this.accounts) {
      if (account.key === currentKey) continue
      const cap = this.modelCapability(account.key, modelId)
      if (cap === "Unsupported") continue
      const slots = this.availableSlots(account.key, now)
      if (slots <= 0) continue
      const rank = CAPABILITY_RANK[cap]
      if (
        !best ||
        rank < best.rank ||
        (rank === best.rank && slots > best.slots)
      ) {
        best = { key: account.key, rank, slots }
      }
    }
    return best?.key
  }

  /** Total accounts currently assignable (have >=1 slot). */
  availableAccountCount(now = Date.now()) {
    return this.accounts.filter((item) => this.availableSlots(item.key, now) > 0).length
  }

  /** Rust `should_throttle_spawns` — >50% of accounts in cooldown. */
  shouldThrottleSpawns(now = Date.now()) {
    const total = this.accounts.length
    if (total <= 1) return false
    const avail = this.availableAccountCount(now)
    return avail * 2 < total
  }
}

export { HEADERLESS_429_FALLBACK_DELAYS_MS }
