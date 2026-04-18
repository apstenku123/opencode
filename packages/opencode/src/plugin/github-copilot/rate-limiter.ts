/**
 * CopilotRateLimiter — adaptive per-account semaphore with a 10-minute
 * sliding 429 window that auto-tunes concurrency.
 *
 * Ported from `codex-rs/core/src/copilot_rate_limiter.rs` (~299 LOC).
 *
 * Behaviour:
 *
 *   - Each account gets its own `AccountLimiter` keyed by the account's
 *     stable key (e.g. `github-copilot`, `github-copilot#work`). Instances
 *     are created lazily via `CopilotRateLimiter.for(key)`.
 *
 *   - Every `record429(key)` call pushes a timestamp onto a deque; the
 *     deque is trimmed to the sliding window (`slidingWindowMs`, default
 *     10 min).
 *
 *   - A per-minute 429 rate is computed as `count / windowMinutes`.  When
 *     that rate exceeds `threshold` (default 0.2 => 1 hit per 5 min), the
 *     semaphore capacity is **halved** down to `minConcurrent` (default 1).
 *
 *   - When the window has been clean for ≥ `cleanWindowMs` (default 5 min),
 *     capacity is **doubled** up to `maxConcurrent` (default 7, mirroring
 *     `MAX_AGENTS_PER_ACCOUNT`).
 *
 *   - `acquire(key, { timeoutMs })` returns a `Release`. If no slot opens
 *     within `timeoutMs` (default 30 s) the promise rejects with an
 *     `AcquireTimeoutError`. Waiters form a FIFO queue.
 *
 * The limiter is a pure-TypeScript complement to the `AccountPool`:
 *
 *   - `AccountPool` gates **per-account concurrency caps** and stepped
 *     recovery after an individual 429. That's a hard ceiling backed by
 *     persistent cooldown state.
 *
 *   - `CopilotRateLimiter` gates **adaptive concurrency under a burst of
 *     429s** — it reacts to a noisy-neighbour signal (429 density over a
 *     sliding window) independent of per-request cooldowns and shrinks
 *     the dispatch fan-out so the pool doesn't thrash.
 *
 * Callers should acquire from the pool first (bounded per-account headroom)
 * and then from the rate-limiter (adaptive gate), mirroring the Rust
 * dispatch path.
 */

export const DEFAULT_SLIDING_WINDOW_MS = 10 * 60 * 1000 // 10 min
export const DEFAULT_CLEAN_WINDOW_MS = 5 * 60 * 1000 // 5 min
export const DEFAULT_THRESHOLD = 0.2 // 429s per minute
export const DEFAULT_MAX_CONCURRENT = 7 // matches MAX_AGENTS_PER_ACCOUNT
export const DEFAULT_MIN_CONCURRENT = 1
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000

export class AcquireTimeoutError extends Error {
  readonly key: string
  readonly timeoutMs: number
  constructor(key: string, timeoutMs: number) {
    super(`CopilotRateLimiter: acquire on "${key}" timed out after ${timeoutMs}ms`)
    this.name = "AcquireTimeoutError"
    this.key = key
    this.timeoutMs = timeoutMs
  }
}

export type Release = {
  key: string
  held: boolean
  release(): void
  [Symbol.dispose]?(): void
}

export type CopilotRateLimiterOptions = {
  /** Master switch. When `false`, `acquire` is a no-op. */
  enabled?: boolean
  /** Sliding 429 window size in ms. Default 10 min. */
  slidingWindowMs?: number
  /** Clean-window duration before growth is considered. Default 5 min. */
  cleanWindowMs?: number
  /** 429s-per-minute threshold that triggers shrink. Default 0.2. */
  threshold?: number
  /** Max concurrent slots per account (starting capacity). Default 7. */
  maxConcurrent?: number
  /** Floor capacity when shrinking. Default 1. */
  minConcurrent?: number
  /** Default acquire timeout (ms). Default 30 s. */
  acquireTimeoutMs?: number
}

export type AcquireOptions = {
  /** Override the limiter-level acquire timeout. */
  timeoutMs?: number
  /** Abort signal. Rejects the pending acquire. */
  signal?: AbortSignal
  /** Test-only: pin the clock. */
  now?: number
}

type Waiter = {
  resolve(release: Release): void
  reject(err: Error): void
  timer?: ReturnType<typeof setTimeout>
  listener?: () => void
  signal?: AbortSignal
  timeoutMs: number
}

/**
 * Adaptive semaphore for a single account. Not meant to be used directly —
 * go through `CopilotRateLimiter.for(key)`.
 */
export class AccountLimiter {
  readonly key: string
  readonly options: Required<Omit<CopilotRateLimiterOptions, "enabled">> & { enabled: boolean }
  private capacity: number
  private inUse = 0
  private waiters: Waiter[] = []
  /** Deque of 429 timestamps (newest at the end). */
  private events: number[] = []
  /** Timestamp of the most recent capacity evaluation. */
  private lastEvalAt: number = 0
  /** Timestamp of the most recent shrink event (for clean-window growth). */
  private lastShrinkAt: number = 0

  constructor(key: string, options: CopilotRateLimiterOptions = {}) {
    this.key = key
    const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    const min = options.minConcurrent ?? DEFAULT_MIN_CONCURRENT
    this.options = {
      enabled: options.enabled ?? true,
      slidingWindowMs: options.slidingWindowMs ?? DEFAULT_SLIDING_WINDOW_MS,
      cleanWindowMs: options.cleanWindowMs ?? DEFAULT_CLEAN_WINDOW_MS,
      threshold: options.threshold ?? DEFAULT_THRESHOLD,
      maxConcurrent: Math.max(1, max),
      minConcurrent: Math.max(1, Math.min(min, Math.max(1, max))),
      acquireTimeoutMs: options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    }
    this.capacity = this.options.maxConcurrent
  }

  /** Effective concurrency cap at `now` (after evaluating the adaptive curve). */
  effectiveCapacity(now = Date.now()): number {
    this.evaluate(now)
    return this.capacity
  }

  /** Count of 429 timestamps currently inside the sliding window at `now`. */
  recentCount(now = Date.now()): number {
    this.trim(now)
    return this.events.length
  }

  /** Available slot count at `now` (capacity minus in-flight leases). */
  available(now = Date.now()): number {
    return Math.max(0, this.effectiveCapacity(now) - this.inUse)
  }

  /** Queue length for diagnostics. */
  pending(): number {
    return this.waiters.length
  }

  /**
   * Record a 429 event. Updates the sliding window and may shrink capacity
   * if the density now exceeds `threshold`.
   */
  record429(now = Date.now()): void {
    this.events.push(now)
    this.trim(now)
    this.evaluate(now)
  }

  /**
   * Acquire a semaphore slot. Resolves with a `Release`; rejects with
   * `AcquireTimeoutError` after `timeoutMs`.
   */
  async acquire(opts: AcquireOptions = {}): Promise<Release> {
    const now = opts.now ?? Date.now()
    const timeoutMs = opts.timeoutMs ?? this.options.acquireTimeoutMs
    // Disabled limiter — hand back a no-op release.
    if (!this.options.enabled) return this.makeDisabledRelease()
    this.evaluate(now)
    if (this.inUse < this.capacity) {
      this.inUse += 1
      return this.makeRelease()
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timeoutMs,
        signal: opts.signal,
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"))
          return
        }
        waiter.listener = () => {
          this.removeWaiter(waiter)
          reject(
            opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("aborted"),
          )
        }
        opts.signal.addEventListener("abort", waiter.listener, { once: true })
      }
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter)
        reject(new AcquireTimeoutError(this.key, timeoutMs))
      }, timeoutMs)
      ;(waiter.timer as any)?.unref?.()
      this.waiters.push(waiter)
    })
  }

  /** Reject every pending waiter (used during shutdown). */
  drain(err: Error = new Error("CopilotRateLimiter drained")): void {
    const pending = this.waiters
    this.waiters = []
    for (const w of pending) {
      if (w.timer) clearTimeout(w.timer)
      if (w.signal && w.listener) w.signal.removeEventListener("abort", w.listener)
      w.reject(err)
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Adaptive evaluation:
   *
   *   - Trim the sliding window.
   *   - If density > threshold, halve capacity (floor `minConcurrent`).
   *   - Else if no 429 in ≥ cleanWindowMs AND capacity < max, double capacity.
   *
   * Always wakes waiters when capacity grows.
   */
  private evaluate(now: number): void {
    this.trim(now)
    const windowMinutes = Math.max(1e-6, this.options.slidingWindowMs / 60_000)
    const rate = this.events.length / windowMinutes
    let changed = false
    if (rate > this.options.threshold) {
      const next = Math.max(this.options.minConcurrent, Math.floor(this.capacity / 2))
      if (next < this.capacity) {
        this.capacity = next
        this.lastShrinkAt = now
        changed = true
      }
    } else {
      const cleanFor = this.events.length === 0
        ? now - Math.max(this.lastShrinkAt, this.lastEvalAt || 0)
        : now - this.events[this.events.length - 1]!
      if (cleanFor >= this.options.cleanWindowMs && this.capacity < this.options.maxConcurrent) {
        const next = Math.min(this.options.maxConcurrent, this.capacity * 2)
        if (next > this.capacity) {
          this.capacity = next
          changed = true
        }
      }
    }
    this.lastEvalAt = now
    if (changed) this.flush(now)
  }

  private trim(now: number): void {
    const cutoff = now - this.options.slidingWindowMs
    while (this.events.length > 0 && this.events[0]! <= cutoff) this.events.shift()
  }

  private removeWaiter(w: Waiter): void {
    const idx = this.waiters.indexOf(w)
    if (idx >= 0) this.waiters.splice(idx, 1)
    if (w.timer) clearTimeout(w.timer)
    if (w.signal && w.listener) w.signal.removeEventListener("abort", w.listener)
  }

  private flush(now: number): void {
    while (this.waiters.length > 0 && this.inUse < this.capacity) {
      const w = this.waiters.shift()!
      if (w.timer) clearTimeout(w.timer)
      if (w.signal && w.listener) w.signal.removeEventListener("abort", w.listener)
      this.inUse += 1
      w.resolve(this.makeRelease(now))
    }
  }

  private makeRelease(now = Date.now()): Release {
    void now
    const self = this
    const release: Release = {
      key: this.key,
      held: true,
      release() {
        if (!this.held) return
        this.held = false
        self.inUse = Math.max(0, self.inUse - 1)
        self.flush(Date.now())
      },
    }
    release[Symbol.dispose] = () => release.release()
    return release
  }

  private makeDisabledRelease(): Release {
    const release: Release = {
      key: this.key,
      held: true,
      release() {
        this.held = false
      },
    }
    release[Symbol.dispose] = () => release.release()
    return release
  }
}

/**
 * Per-account adaptive rate limiter. Manages an `AccountLimiter` per key
 * on demand. Always returns a valid limiter — callers never have to check
 * for the "missing-key" case.
 */
export class CopilotRateLimiter {
  private readonly limiters = new Map<string, AccountLimiter>()
  readonly options: CopilotRateLimiterOptions

  constructor(options: CopilotRateLimiterOptions = {}) {
    this.options = { ...options }
  }

  /** Return (creating on demand) the limiter for `key`. */
  for(key: string): AccountLimiter {
    const existing = this.limiters.get(key)
    if (existing) return existing
    const created = new AccountLimiter(key, this.options)
    this.limiters.set(key, created)
    return created
  }

  /** Return the already-created limiter for `key`, if any. */
  peek(key: string): AccountLimiter | undefined {
    return this.limiters.get(key)
  }

  /** List keys currently tracked. */
  keys(): string[] {
    return [...this.limiters.keys()]
  }

  /** Convenience: delegate `acquire` to the per-key limiter. */
  async acquire(key: string, opts?: AcquireOptions): Promise<Release> {
    return this.for(key).acquire(opts)
  }

  /** Convenience: delegate `record429` to the per-key limiter. */
  record429(key: string, now?: number): void {
    this.for(key).record429(now)
  }

  /** Current effective capacity for `key`. */
  effectiveCapacity(key: string, now?: number): number {
    return this.for(key).effectiveCapacity(now)
  }

  /** Available slots for `key`. */
  available(key: string, now?: number): number {
    return this.for(key).available(now)
  }

  /** Reject every pending waiter and drop all per-account state. */
  drain(err?: Error): void {
    for (const limiter of this.limiters.values()) limiter.drain(err)
    this.limiters.clear()
  }

  /** Whether the limiter is enabled globally. */
  get enabled(): boolean {
    return this.options.enabled !== false
  }
}

/**
 * Build a `CopilotRateLimiter` from the user's `copilot.rateLimiter.*`
 * config block. Mirrors the shape parsed in `copilotRuntimeConfig` so a
 * single object can pass through both call sites.
 */
export function copilotRateLimiterConfig(config?: {
  copilot?: {
    rateLimiter?: {
      enabled?: boolean
      slidingWindowMs?: number
      cleanWindowMs?: number
      threshold?: number
      maxConcurrent?: number
      minConcurrent?: number
      acquireTimeoutMs?: number
    }
  }
}): CopilotRateLimiterOptions {
  const raw = config?.copilot?.rateLimiter ?? {}
  const envNum = (v: string | undefined) => {
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const envBool = (v: string | undefined) => {
    if (v === undefined) return undefined
    if (v === "0" || v.toLowerCase() === "false") return false
    if (v === "1" || v.toLowerCase() === "true") return true
    return undefined
  }
  return {
    enabled: envBool(process.env.OPENCODE_COPILOT_RATE_LIMITER_ENABLED) ?? raw.enabled ?? true,
    slidingWindowMs:
      envNum(process.env.OPENCODE_COPILOT_RATE_LIMITER_WINDOW_MS) ?? raw.slidingWindowMs ?? DEFAULT_SLIDING_WINDOW_MS,
    cleanWindowMs:
      envNum(process.env.OPENCODE_COPILOT_RATE_LIMITER_CLEAN_MS) ?? raw.cleanWindowMs ?? DEFAULT_CLEAN_WINDOW_MS,
    threshold:
      envNum(process.env.OPENCODE_COPILOT_RATE_LIMITER_THRESHOLD) ?? raw.threshold ?? DEFAULT_THRESHOLD,
    maxConcurrent:
      envNum(process.env.OPENCODE_COPILOT_RATE_LIMITER_MAX) ?? raw.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    minConcurrent:
      envNum(process.env.OPENCODE_COPILOT_RATE_LIMITER_MIN) ?? raw.minConcurrent ?? DEFAULT_MIN_CONCURRENT,
    acquireTimeoutMs:
      envNum(process.env.OPENCODE_COPILOT_RATE_LIMITER_ACQUIRE_TIMEOUT_MS) ??
      raw.acquireTimeoutMs ??
      DEFAULT_ACQUIRE_TIMEOUT_MS,
  }
}
