/**
 * HTTP retry-race orchestrator — TypeScript port of
 * `codex-rs/core/src/client_retry_race.rs`.
 *
 * # What it does
 *
 * When a GitHub Copilot (or similar upstream) request stalls — the POST is
 * accepted but no SSE byte arrives for tens of seconds — the retry-race
 * sidesteps the hang by launching *duplicate* attempts against different
 * accounts/proxies after a stagger delay.  The first attempt to produce a
 * response wins, and every sibling attempt is aborted via `AbortController`.
 *
 * Shape (paraphrased from the Rust reference):
 *
 *   1. Fire attempt 1 at `t=0`.
 *   2. If no winner within `staggerMs`, fire attempt 2.  Do NOT cancel the
 *      first — it may still win if the upstream unblocks.
 *   3. Keep layering attempts up to `concurrentLimit` in-flight requests,
 *      then up to `maxAttempts` total.
 *   4. The first attempt whose promise resolves successfully is the winner;
 *      all siblings receive `AbortSignal.aborted = true` and their pending
 *      `Promise` resolves to `Canceled`.
 *   5. If an attempt REJECTS, that single failure does not abort the race —
 *      other attempts keep running.  The race only surfaces a rejection
 *      when every attempt has finished without a single success (and the
 *      cycle budget has elapsed).
 *   6. After `totalDeadlineMs` milliseconds without a winner, the race
 *      fails with `RetryRaceExhaustedError`.
 *
 * # Contrast with the Rust port
 *
 * The Rust version drives a `ResponseStream` over `tokio::broadcast`, with
 * structured lifecycle events (`Sent`, `Waiting`, `FirstByte`, `Succeeded`,
 * `Failed`, `Canceled`, `Exhausted`).  The TypeScript port retains the same
 * event names and shapes but emits them through a lightweight `Set`-of-
 * callbacks observer bus — no broadcast channels, no stream-wrapping.  The
 * generic `raceFetch<T>` races arbitrary `Promise<T>` producers; the caller
 * (typically `copilot.ts::dispatchWithRace`) is responsible for issuing
 * fetches with the supplied `AbortSignal`.
 *
 * # Configuration
 *
 * The Rust defaults (40s first stagger, 60s abort, max 3 parallel, max 2
 * cycles) are overloaded for TypeScript consumption as
 * `{ enabled, staggerMs, concurrentLimit, maxAttempts, totalDeadlineMs }`.
 * Defaults match the Rust `HttpRetryRaceConfig::default()` so behaviour is
 * identical across language boundaries.
 */

/**
 * Runtime configuration for the retry-race.  Matches the Rust
 * `HttpRetryRaceConfig` defaults so wire consumers see identical behaviour
 * across the Rust / TS client boundary.
 */
export type HttpRetryRaceConfig = {
  /**
   * Master switch.  When `false`, `raceFetch` behaves as a straight
   * single-shot (`attempts[0]()`) — no stagger, no cancellation, no bus
   * events.  Defaults to `false`.
   */
  enabled: boolean
  /**
   * Delay before spawning the second parallel attempt.  Further attempts
   * follow at the same cadence.  Mirrors Rust `first_retry_after_ms`.
   * Default: 40_000 ms.
   */
  staggerMs: number
  /**
   * Maximum number of concurrent in-flight attempts.  Clamped to
   * `[1, maxAttempts]`.  Mirrors Rust `max_parallel`.  Default: 3.
   */
  concurrentLimit: number
  /**
   * Absolute cap on the total number of attempts fired during one race.
   * Mirrors Rust `max_parallel * max_cycles`.  Default: 6 (3 × 2).
   */
  maxAttempts: number
  /**
   * Hard wall-clock after which the whole race fails with
   * `RetryRaceExhaustedError`.  Mirrors Rust
   * `abort_after_ms * max_cycles`.  Default: 120_000 ms (60s × 2).
   */
  totalDeadlineMs: number
  /**
   * Size of the observation ring buffer inside `HttpAttemptBus`.
   * Observers that join after older events were pushed out still see the
   * most recent `eventBusCapacity` events.  Mirrors Rust `broadcast`
   * channel capacity (64).  Default: 64.
   */
  eventBusCapacity: number
}

/** Default config — values identical to Rust `HttpRetryRaceConfig::default()`. */
export const DEFAULT_HTTP_RETRY_RACE_CONFIG: HttpRetryRaceConfig = {
  enabled: false,
  staggerMs: 40_000,
  concurrentLimit: 3,
  maxAttempts: 6,
  totalDeadlineMs: 120_000,
  eventBusCapacity: 64,
}

/** Lifecycle events for a single attempt.  Mirrors Rust `HttpAttemptEvent`. */
export type HttpAttemptEvent =
  | { type: "sent"; attempt: number }
  | { type: "firstByte"; attempt: number }
  | { type: "succeeded"; attempt: number }
  | { type: "failed"; attempt: number; error: Error }
  | { type: "canceled"; attempt: number; reason: "raced-sibling-won" | "parent-canceled" | "budget-exceeded" }
  | { type: "exhausted"; attempts: number; totalElapsedMs: number }

/** Single observation as emitted onto the `HttpAttemptBus`. */
export type HttpAttemptObservation = {
  requestId: string
  startedAt: number
  event: HttpAttemptEvent
}

export type HttpAttemptObserver = (obs: HttpAttemptObservation) => void

/**
 * Ring-buffered event bus — lightweight TS analogue of the Rust
 * `HttpAttemptBus` (`tokio::sync::broadcast`).  Observers subscribe via
 * `addObserver` and receive every subsequent `emit(...)` call.  Past events
 * are retained in a FIFO ring buffer (capacity = `HttpRetryRaceConfig
 * .eventBusCapacity`) so late subscribers can replay the most recent
 * history via `snapshot()`.
 */
export class HttpAttemptBus {
  readonly capacity: number
  private readonly observers = new Set<HttpAttemptObserver>()
  private readonly buffer: HttpAttemptObservation[] = []

  constructor(capacity = DEFAULT_HTTP_RETRY_RACE_CONFIG.eventBusCapacity) {
    this.capacity = Math.max(1, Math.trunc(capacity))
  }

  /** Emit an observation to every subscriber; retain it in the ring buffer. */
  emit(obs: HttpAttemptObservation): void {
    this.buffer.push(obs)
    if (this.buffer.length > this.capacity) this.buffer.shift()
    for (const observer of this.observers) {
      try {
        observer(obs)
      } catch {
        // Silently swallow observer exceptions so a single bad consumer
        // can't break orchestration — mirrors the Rust broadcast `_ = send`
        // silent-drop semantics.
      }
    }
  }

  /**
   * Subscribe to future observations.  Returns a disposer that unsubscribes.
   * Disposer is idempotent (safe to call multiple times).
   */
  addObserver(observer: HttpAttemptObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  /** Snapshot of the retained ring-buffer observations. */
  snapshot(): HttpAttemptObservation[] {
    return [...this.buffer]
  }

  /** Current subscriber count — test-only observability. */
  observerCount(): number {
    return this.observers.size
  }
}

/** Signals that every attempt rejected and the race deadline elapsed. */
export class RetryRaceExhaustedError extends Error {
  readonly kind = "RetryRaceExhausted" as const
  readonly attempts: number
  readonly elapsedMs: number
  readonly errors: Error[]
  constructor(attempts: number, elapsedMs: number, errors: Error[]) {
    const last = errors[errors.length - 1]
    super(
      `retry-race exhausted after ${attempts} attempts in ${elapsedMs}ms` +
        (last ? ` (last error: ${last.message})` : ""),
    )
    this.name = "RetryRaceExhaustedError"
    this.attempts = attempts
    this.elapsedMs = elapsedMs
    this.errors = errors
  }
}

/** Argument passed to each attempt factory — mirrors `AbortController` + id. */
export type RaceAttemptContext = {
  attempt: number
  signal: AbortSignal
}

export type RaceAttempt<T> = (ctx: RaceAttemptContext) => Promise<T>

export type RaceFetchOptions = {
  /** Bus to emit observations onto.  Defaults to a disabled (no-op) bus. */
  bus?: HttpAttemptBus
  /** Caller correlation id.  Generated when omitted. */
  requestId?: string
  /** Upstream abort signal (e.g. parent turn cancelled). */
  signal?: AbortSignal
}

const DISABLED_BUS = new HttpAttemptBus(1)

function genRequestId(): string {
  // crypto.randomUUID is available on Bun/Node >= 18.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Stagger-launch attempts from `attempts` and return the first to resolve.
 *
 * @param attempts Ordered list of attempt factories.  Capped at `cfg.maxAttempts`.
 * @param cfg Race configuration.
 * @param options Optional bus / requestId / parent signal.
 */
export async function raceFetch<T>(
  attempts: Array<RaceAttempt<T>>,
  cfg: HttpRetryRaceConfig,
  options: RaceFetchOptions = {},
): Promise<T> {
  if (attempts.length === 0) {
    throw new TypeError("raceFetch: attempts must contain at least one factory")
  }
  const bus = options.bus ?? DISABLED_BUS
  const requestId = options.requestId ?? genRequestId()

  // Disabled path — honour the bus contract (no events), no stagger, single
  // shot exactly like the Rust `!enabled` bypass.
  if (!cfg.enabled) {
    const singleCtrl = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) singleCtrl.abort(options.signal.reason)
      else options.signal.addEventListener("abort", () => singleCtrl.abort(options.signal!.reason), { once: true })
    }
    return await attempts[0]({ attempt: 1, signal: singleCtrl.signal })
  }

  // Sanitize config.  `concurrentLimit` must be ≥1 and ≤`maxAttempts`.
  const maxAttempts = Math.min(
    Math.max(1, Math.trunc(cfg.maxAttempts)),
    attempts.length,
  )
  const concurrentLimit = Math.min(
    Math.max(1, Math.trunc(cfg.concurrentLimit)),
    maxAttempts,
  )
  const staggerMs = Math.max(0, cfg.staggerMs)
  const totalDeadlineMs = Math.max(0, cfg.totalDeadlineMs)

  const startedAt = Date.now()
  const emit = (event: HttpAttemptEvent) => bus.emit({ requestId, startedAt, event })

  type InFlight = {
    attempt: number
    controller: AbortController
    settled: boolean
    promise: Promise<
      | { kind: "ok"; attempt: number; value: T }
      | { kind: "err"; attempt: number; error: Error }
    >
  }

  const inFlight: InFlight[] = []
  const errors: Error[] = []
  let spawnedCount = 0

  const spawn = (index: number): InFlight => {
    const attempt = index + 1
    const controller = new AbortController()
    // Propagate parent-signal cancellation down to each attempt.
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason)
      else {
        options.signal.addEventListener(
          "abort",
          () => controller.abort(options.signal!.reason),
          { once: true },
        )
      }
    }
    const factory = attempts[index]
    // Forward-declare the entry so the async IIFE can flip `settled` once
    // the attempt resolves/rejects without TS complaining about TDZ use.
    const entry: InFlight = {
      attempt,
      controller,
      settled: false,
      // Placeholder promise; replaced synchronously below.
      promise: undefined as unknown as InFlight["promise"],
    }
    entry.promise = (async () => {
      try {
        const value = await factory({ attempt, signal: controller.signal })
        entry.settled = true
        return { kind: "ok" as const, attempt, value }
      } catch (err) {
        entry.settled = true
        const error = err instanceof Error ? err : new Error(String(err))
        return { kind: "err" as const, attempt, error }
      }
    })()
    emit({ type: "sent", attempt })
    spawnedCount += 1
    return entry
  }

  // Launch the first attempt immediately.
  inFlight.push(spawn(0))

  // Cancellation hook — aborts every still-in-flight attempt with a single
  // `reason`.  Used on winner-selection, parent-cancel, and exhaustion.
  const cancelAll = (
    reason: "raced-sibling-won" | "parent-canceled" | "budget-exceeded",
    except?: number,
  ) => {
    for (const entry of inFlight) {
      if (entry.settled) continue
      if (except !== undefined && entry.attempt === except) continue
      entry.controller.abort(new Error(`retry-race:${reason}`))
      emit({ type: "canceled", attempt: entry.attempt, reason })
    }
  }

  // Parent-signal watcher: cancels the whole race on upstream abort.
  let parentAbortHandler: (() => void) | undefined
  if (options.signal) {
    if (options.signal.aborted) {
      cancelAll("parent-canceled")
      const reason = options.signal.reason instanceof Error ? options.signal.reason : new Error("parent-canceled")
      throw reason
    }
    parentAbortHandler = () => cancelAll("parent-canceled")
    options.signal.addEventListener("abort", parentAbortHandler, { once: true })
  }

  const raceDeadlineAt = startedAt + totalDeadlineMs

  try {
    // Main loop: race each stagger tick against the earliest in-flight
    // promise.  If a stagger tick fires and we have headroom, spawn the
    // next attempt; otherwise continue polling without spawning.
    while (inFlight.some((e) => !e.settled) || spawnedCount < maxAttempts) {
      const now = Date.now()
      const remainingDeadline = raceDeadlineAt - now
      if (remainingDeadline <= 0) {
        cancelAll("budget-exceeded")
        const elapsed = Date.now() - startedAt
        emit({ type: "exhausted", attempts: spawnedCount, totalElapsedMs: elapsed })
        throw new RetryRaceExhaustedError(spawnedCount, elapsed, errors)
      }
      const liveCount = inFlight.filter((e) => !e.settled).length
      const canSpawnMore = spawnedCount < maxAttempts && liveCount < concurrentLimit
      const nextStaggerMs = canSpawnMore ? staggerMs : remainingDeadline

      let timerHandle: ReturnType<typeof setTimeout> | undefined
      const timer = new Promise<{ kind: "timer" }>((resolve) => {
        timerHandle = setTimeout(() => resolve({ kind: "timer" }), nextStaggerMs)
      })
      const active = inFlight.filter((e) => !e.settled)
      const winner = active.length
        ? Promise.race([...active.map((e) => e.promise.then((r) => ({ kind: "settle" as const, r }))), timer])
        : timer

      const outcome = (await winner) as
        | { kind: "timer" }
        | {
            kind: "settle"
            r:
              | { kind: "ok"; attempt: number; value: T }
              | { kind: "err"; attempt: number; error: Error }
          }
      if (timerHandle) clearTimeout(timerHandle)

      if (outcome.kind === "timer") {
        // Stagger fired — spawn the next attempt if we have headroom.
        if (canSpawnMore) inFlight.push(spawn(spawnedCount))
        continue
      }

      // An in-flight attempt settled.
      if (outcome.r.kind === "ok") {
        const { attempt, value } = outcome.r
        emit({ type: "firstByte", attempt })
        emit({ type: "succeeded", attempt })
        cancelAll("raced-sibling-won", attempt)
        return value
      }
      // A single attempt rejected — surface a `failed` event and let the
      // race continue.  Siblings may still win; if every attempt rejects
      // and we still have headroom, spawn another.
      errors.push(outcome.r.error)
      emit({ type: "failed", attempt: outcome.r.attempt, error: outcome.r.error })
      // If no attempts are live and we've already spawned the max, fall
      // through to the deadline check on the next loop iteration.
    }

    // Every attempt finished rejecting before the deadline.  Surface the
    // deterministic `RetryRaceExhaustedError` with the collected errors.
    const elapsed = Date.now() - startedAt
    emit({ type: "exhausted", attempts: spawnedCount, totalElapsedMs: elapsed })
    throw new RetryRaceExhaustedError(spawnedCount, elapsed, errors)
  } finally {
    if (options.signal && parentAbortHandler) {
      options.signal.removeEventListener("abort", parentAbortHandler)
    }
  }
}

/**
 * Extractor for the `copilot.httpRetryRace.*` config block.  Mirrors
 * `copilotRateLimiterConfig` in shape so a single merged `resolvedCfg`
 * object can drive both call sites.  Environment-variable overrides
 * (`OPENCODE_COPILOT_HTTP_RETRY_RACE_*`) take precedence, then config,
 * then defaults.
 */
export function httpRetryRaceConfig(config?: {
  copilot?: {
    httpRetryRace?: {
      enabled?: boolean
      staggerMs?: number
      concurrentLimit?: number
      maxAttempts?: number
      totalDeadlineMs?: number
      eventBusCapacity?: number
    }
  }
}): HttpRetryRaceConfig {
  const raw = config?.copilot?.httpRetryRace ?? {}
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
    enabled: envBool(process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED) ?? raw.enabled ?? DEFAULT_HTTP_RETRY_RACE_CONFIG.enabled,
    staggerMs:
      envNum(process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_STAGGER_MS) ??
      raw.staggerMs ??
      DEFAULT_HTTP_RETRY_RACE_CONFIG.staggerMs,
    concurrentLimit:
      envNum(process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_CONCURRENT_LIMIT) ??
      raw.concurrentLimit ??
      DEFAULT_HTTP_RETRY_RACE_CONFIG.concurrentLimit,
    maxAttempts:
      envNum(process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_MAX_ATTEMPTS) ??
      raw.maxAttempts ??
      DEFAULT_HTTP_RETRY_RACE_CONFIG.maxAttempts,
    totalDeadlineMs:
      envNum(process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_TOTAL_DEADLINE_MS) ??
      raw.totalDeadlineMs ??
      DEFAULT_HTTP_RETRY_RACE_CONFIG.totalDeadlineMs,
    eventBusCapacity:
      envNum(process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_EVENT_BUS_CAPACITY) ??
      raw.eventBusCapacity ??
      DEFAULT_HTTP_RETRY_RACE_CONFIG.eventBusCapacity,
  }
}
