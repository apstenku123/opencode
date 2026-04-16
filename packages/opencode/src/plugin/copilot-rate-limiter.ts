/**
 * Adaptive rate limiter for GitHub Copilot API requests.
 *
 * Implements a sliding window 429 tracker with dual-knob control:
 * - Concurrency limit (semaphore)
 * - Inter-request delay
 *
 * Matches the behavior in codex_git's copilot_rate_limiter.rs.
 */

const WINDOW_DURATION_MS = 10 * 60 * 1000 // 10 minutes
const BACKOFF_THRESHOLD = 0.2 // 20% 429 rate triggers backoff
const SPEEDUP_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes clean before speedup
const MIN_INTERVAL_MS = 1000 // Minimum 1 second between requests
const DEFAULT_INTERVAL_MS = 5000 // Default 5 seconds
const MAX_CONCURRENT = 1 // Default max concurrent requests

// Tiered RPM system matching codex_git's rate_limit_stats.rs
const RPM_TIERS = [
  { rpm: 2, afterMinutes: 0 }, // Tier 0: just after 429
  { rpm: 3, afterMinutes: 5 }, // Tier 1
  { rpm: 5, afterMinutes: 10 }, // Tier 2
  { rpm: 8, afterMinutes: 15 }, // Tier 3
] as const

// Headerless 429 escalating fallback delays (matching codex_git client.rs:197-199)
const HEADERLESS_429_FALLBACK_DELAYS_MS = [
  11 * 60 * 1000, // 11 minutes
  21 * 60 * 1000, // 21 minutes
  41 * 60 * 1000, // 41 minutes
]

interface RequestRecord {
  timestamp: number
  was429: boolean
}

export class CopilotRateLimiter {
  private records: RequestRecord[] = []
  private maxConcurrent = MAX_CONCURRENT
  private currentConcurrent = 0
  private intervalMs = DEFAULT_INTERVAL_MS
  private lastRequestTime = 0
  private last429Time = 0
  private lastSpeedupCheck = 0
  private headerless429Count = 0
  private penaltyUntil = 0
  private autoTune: boolean

  constructor(options?: { autoTune?: boolean; intervalMs?: number; maxConcurrent?: number }) {
    this.autoTune = options?.autoTune ?? true
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT
  }

  /**
   * Get the current delay before the next request can be sent.
   */
  getDelay(): number {
    const now = Date.now()

    // Check penalty mode first
    if (this.penaltyUntil > now) {
      return this.penaltyUntil - now
    }

    // Check tiered RPM if in recovery
    if (this.last429Time > 0) {
      const minutesSince429 = (now - this.last429Time) / 60000
      let currentRpm: number = RPM_TIERS[0].rpm
      for (const tier of RPM_TIERS) {
        if (minutesSince429 >= tier.afterMinutes) {
          currentRpm = tier.rpm
        }
      }
      const tierInterval = (60 / currentRpm) * 1000
      const elapsed = now - this.lastRequestTime
      return Math.max(0, tierInterval - elapsed)
    }

    // Normal interval
    const elapsed = now - this.lastRequestTime
    return Math.max(0, this.intervalMs - elapsed)
  }

  /**
   * Wait for the rate limiter to allow a request, then acquire a slot.
   */
  async acquire(): Promise<void> {
    // Wait for concurrency slot
    while (this.currentConcurrent >= this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Wait for interval
    const delay = this.getDelay()
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    this.currentConcurrent++
    this.lastRequestTime = Date.now()
  }

  /**
   * Release a slot after request completes.
   */
  release(): void {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1)
  }

  /**
   * Record a successful response.
   */
  recordSuccess(): void {
    const now = Date.now()
    this.records.push({ timestamp: now, was429: false })
    this.pruneOldRecords(now)
    this.headerless429Count = 0 // Reset on success

    // Try speedup if auto-tuning
    if (this.autoTune && this.last429Time > 0) {
      const timeSinceLast429 = now - this.last429Time
      if (timeSinceLast429 >= SPEEDUP_COOLDOWN_MS && now - this.lastSpeedupCheck >= SPEEDUP_COOLDOWN_MS) {
        this.lastSpeedupCheck = now
        this.intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(this.intervalMs * 0.75))
        this.maxConcurrent = Math.min(this.maxConcurrent + 1, 3)
      }
    }
  }

  /**
   * Record a 429 response with optional retry-after.
   */
  record429(retryAfterMs?: number): void {
    const now = Date.now()
    this.records.push({ timestamp: now, was429: true })
    this.last429Time = now
    this.pruneOldRecords(now)

    if (retryAfterMs && retryAfterMs > 0) {
      this.penaltyUntil = now + retryAfterMs
    } else {
      // Headerless 429 - escalating fallback
      const idx = Math.min(this.headerless429Count, HEADERLESS_429_FALLBACK_DELAYS_MS.length - 1)
      this.penaltyUntil = now + HEADERLESS_429_FALLBACK_DELAYS_MS[idx]
      this.headerless429Count++
    }

    // Auto-tune: check 429 rate in window
    if (this.autoTune) {
      const rate = this.get429Rate()
      if (rate >= BACKOFF_THRESHOLD) {
        // Double delay, halve concurrency
        this.intervalMs = Math.min(this.intervalMs * 2, 60000)
        this.maxConcurrent = Math.max(1, Math.floor(this.maxConcurrent / 2))
      }
    }
  }

  /**
   * Parse retry-after from response headers.
   */
  parseRetryAfter(headers: Headers | Record<string, string>): number | undefined {
    const get = (name: string): string | null => {
      if (headers instanceof Headers) return headers.get(name)
      return (headers as Record<string, string>)[name] ?? null
    }

    // Check retry-after-ms first (milliseconds)
    const retryAfterMs = get("retry-after-ms")
    if (retryAfterMs) {
      const ms = parseFloat(retryAfterMs)
      if (!isNaN(ms) && ms > 0) return ms
    }

    // Check retry-after (seconds or HTTP date)
    const retryAfter = get("retry-after")
    if (retryAfter) {
      const seconds = parseFloat(retryAfter)
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000
      const date = Date.parse(retryAfter)
      if (!isNaN(date)) return Math.max(0, date - Date.now())
    }

    return undefined
  }

  /**
   * Get the 429 rate in the current sliding window.
   */
  private get429Rate(): number {
    if (this.records.length === 0) return 0
    const total429 = this.records.filter((r) => r.was429).length
    return total429 / this.records.length
  }

  private pruneOldRecords(now: number): void {
    const cutoff = now - WINDOW_DURATION_MS
    this.records = this.records.filter((r) => r.timestamp >= cutoff)
  }

  /**
   * Get current state for diagnostics.
   */
  getState(): {
    intervalMs: number
    maxConcurrent: number
    currentConcurrent: number
    penaltyUntil: number
    last429Time: number
    windowSize: number
    rate429: number
  } {
    return {
      intervalMs: this.intervalMs,
      maxConcurrent: this.maxConcurrent,
      currentConcurrent: this.currentConcurrent,
      penaltyUntil: this.penaltyUntil,
      last429Time: this.last429Time,
      windowSize: this.records.length,
      rate429: this.get429Rate(),
    }
  }
}

/** Singleton rate limiter instance */
let instance: CopilotRateLimiter | undefined

export function getCopilotRateLimiter(): CopilotRateLimiter {
  if (!instance) {
    instance = new CopilotRateLimiter()
  }
  return instance
}
