/**
 * Observability surface for the Copilot multi-account dispatch pipeline.
 *
 * Tracks per-account dispatch counts, 429 hits, retry-after values and
 * premium consumption in a lightweight in-memory ring buffer that's safe to
 * query from the CLI (`providers stats`) and HTTP (`GET /copilot/stats`)
 * without touching the hot path. The only cost on the dispatch side is a
 * constant-time `record*` push per event.
 *
 * The counters are complementary to the persistent SQLite rate-state store
 * (`copilot-rate-state.sqlite`):
 *
 *   - `CopilotStats` holds volatile *since-boot* telemetry — dispatches,
 *     model mix, 429 density, retry-after histogram, premium stamps. It
 *     resets when the process restarts.
 *   - The SQLite store holds persistent *cooldown* state — `exhaustedUntil`,
 *     `headerless429Count`, `last429At`. It survives restarts.
 *
 * `aggregate()` merges both so operators see a unified picture.
 */

import type { RateRow, RateStore } from "./account-pool-sqlite"
import { openRateStore } from "./account-pool-sqlite"
import { rateStateFile } from "./paths"

/** One dispatch or 429 event. The ring buffer caps retention per account. */
export type CopilotStatsEvent = {
  /** Timestamp in ms since epoch. */
  at: number
  key: string
  kind: "dispatch" | "rate_limit" | "premium"
  /** Model id — only populated for `dispatch` / `premium` events. */
  model?: string
  /** `Retry-After` (ms) extracted from the 429 response, when available. */
  retryAfterMs?: number
}

/**
 * Ring-buffer size per account. 4 096 events is enough to cover a full day
 * of sustained dispatch at a reasonable cadence (one event every ~20s for
 * 24h) without ballooning memory.
 */
const RING_CAP = 4096

/**
 * Bucket of per-account counters. Derived from the ring buffer — held as a
 * running total so aggregate queries don't have to scan every event unless
 * they specify a `sinceMs` window.
 */
type AccountBucket = {
  events: CopilotStatsEvent[]
  total: {
    dispatches: number
    rateLimits: number
    premium: number
    retryAfterMsSum: number
    retryAfterCount: number
  }
  lastDispatchAt?: number
  lastRateLimitAt?: number
}

function emptyBucket(): AccountBucket {
  return {
    events: [],
    total: { dispatches: 0, rateLimits: 0, premium: 0, retryAfterMsSum: 0, retryAfterCount: 0 },
  }
}

function push(bucket: AccountBucket, event: CopilotStatsEvent) {
  bucket.events.push(event)
  while (bucket.events.length > RING_CAP) bucket.events.shift()
  if (event.kind === "dispatch") {
    bucket.total.dispatches += 1
    bucket.lastDispatchAt = event.at
  } else if (event.kind === "rate_limit") {
    bucket.total.rateLimits += 1
    bucket.lastRateLimitAt = event.at
    if (typeof event.retryAfterMs === "number" && Number.isFinite(event.retryAfterMs)) {
      bucket.total.retryAfterMsSum += event.retryAfterMs
      bucket.total.retryAfterCount += 1
    }
  } else if (event.kind === "premium") {
    bucket.total.premium += 1
  }
}

/**
 * Duration string parser for CLI `--since` and HTTP `?since=` query.
 * Accepts bare numbers (treated as ms), or `<N><unit>` where unit is one of
 * `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Case-insensitive.
 * Returns `undefined` for missing / invalid input.
 */
export function parseDuration(input: string | undefined | null): number | undefined {
  if (input === undefined || input === null) return undefined
  const s = String(input).trim()
  if (s === "") return undefined
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(s)
  if (!match) return undefined
  const n = Number(match[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  const unit = (match[2] ?? "ms").toLowerCase()
  switch (unit) {
    case "ms":
      return Math.round(n)
    case "s":
      return Math.round(n * 1000)
    case "m":
      return Math.round(n * 60_000)
    case "h":
      return Math.round(n * 3_600_000)
    case "d":
      return Math.round(n * 86_400_000)
    default:
      return undefined
  }
}

export type PerAccountStats = {
  key: string
  /** Optional pool classification (`edu`/`prod`/undefined) when we know it. */
  pool?: string
  /** Dispatches inside the `sinceMs` window (or since boot when unset). */
  dispatches: number
  /** 429s inside the window. */
  rateLimits: number
  /** Premium stamps inside the window. */
  premiumUsed: number
  /** Average `Retry-After` in ms across 429s inside the window. `undefined` when no 429 carried a header. */
  avgRetryAfterMs?: number
  /** Seconds since the most recent 429 (regardless of window). `undefined` if never. */
  lastRateLimitAgoMs?: number
  /** Seconds since the most recent dispatch (regardless of window). `undefined` if never. */
  lastDispatchAgoMs?: number
  /** `exhaustedUntil` persisted in SQLite (ms since epoch). */
  exhaustedUntil?: number
  /** Persistent headerless-429 escalator counter. */
  headerless429Count?: number
  /** `last429At` from SQLite (persistent). */
  persistentLast429At?: number
  /** `true` when the account is flagged deactivated in connections.json. */
  deactivated?: boolean
}

export type ModelInvocation = {
  model: string
  count: number
}

export type PoolHealth = {
  pool: string
  accounts: number
  deactivated: number
  inCooldown: number
}

export type AggregateStats = {
  /** Schema version bumped when the payload shape changes. */
  schemaVersion: number
  /** Wall-clock timestamp (ms) of the aggregation. */
  generatedAt: number
  /** When the stats tracker booted. */
  bootedAt: number
  /** Window (ms) from `sinceMs`; `null` when the query is since-boot. */
  windowMs: number | null
  accounts: PerAccountStats[]
  topModels: ModelInvocation[]
  pools: PoolHealth[]
  totals: {
    accounts: number
    deactivated: number
    dispatches: number
    rateLimits: number
    premium: number
  }
}

export const STATS_SCHEMA_VERSION = 1

/** Minimal shape needed from connections.json (we do not depend on connections.ts type). */
export type ConnectionsShape = {
  connections: Record<
    string,
    {
      plan?: string
      deactivated?: boolean
    }
  >
}

/** Options for one snapshot / aggregation. */
export type AggregateOptions = {
  /** Time window. When omitted, the full since-boot history is returned. */
  sinceMs?: number
  /** Pin the clock (ms). Tests pass this; runtime callers leave it unset. */
  now?: number
  /** `openRateStore` output. When omitted the caller probably supplied `rateRows`. */
  rateStore?: RateStore
  /** Rows pre-loaded from the rate store — preferred for unit tests. */
  rateRows?: RateRow[]
  /** connections.json body (plan + deactivated flags). */
  connections?: ConnectionsShape
  /** Override pool classifier — defaults to a plan-based fallback. */
  poolFor?: (key: string, plan?: string) => string | undefined
}

/**
 * In-memory stats registry. `record*` is the only side-effecting path from
 * the dispatch hot path; the `snapshot` / `aggregate` helpers are read-only.
 */
export class Stats {
  readonly bootedAt: number
  private readonly buckets = new Map<string, AccountBucket>()
  constructor(bootedAt = Date.now()) {
    this.bootedAt = bootedAt
  }

  private bucket(key: string): AccountBucket {
    let b = this.buckets.get(key)
    if (!b) {
      b = emptyBucket()
      this.buckets.set(key, b)
    }
    return b
  }

  /** Record a successful (or at least attempted) dispatch on `key` for `model`. */
  recordDispatch(key: string, model?: string, at = Date.now()): void {
    push(this.bucket(key), { at, key, kind: "dispatch", model })
  }

  /**
   * Record a 429 rate-limit hit. `retryAfterMs` should be the parsed
   * `Retry-After` header (ms) when present — omit it for headerless 429s so
   * the avg calculation only averages values the server actually suggested.
   */
  recordRateLimit(key: string, retryAfterMs?: number, at = Date.now()): void {
    push(this.bucket(key), { at, key, kind: "rate_limit", retryAfterMs })
  }

  /** Record a premium-model stamp. Mirrors `premiumState` bookkeeping. */
  recordPremium(key: string, model: string, at = Date.now()): void {
    push(this.bucket(key), { at, key, kind: "premium", model })
  }

  /** Drop every bucket. Useful for tests + explicit `providers stats --reset`. */
  reset(): void {
    this.buckets.clear()
  }

  /** Number of accounts with at least one recorded event. */
  keys(): string[] {
    return [...this.buckets.keys()]
  }

  /** Raw events for `key` (defensive copy). */
  events(key: string): CopilotStatsEvent[] {
    return [...(this.buckets.get(key)?.events ?? [])]
  }

  /**
   * Per-account snapshot without persistent-store augmentation.
   *
   * When `sinceMs` is set, counts are scanned over the ring window;
   * otherwise the running total is returned.
   */
  snapshot(opts: { sinceMs?: number; now?: number } = {}): PerAccountStats[] {
    const now = opts.now ?? Date.now()
    const cutoff = opts.sinceMs !== undefined ? now - opts.sinceMs : undefined
    const out: PerAccountStats[] = []
    for (const [key, bucket] of this.buckets) {
      if (cutoff === undefined) {
        const avg =
          bucket.total.retryAfterCount > 0
            ? Math.round(bucket.total.retryAfterMsSum / bucket.total.retryAfterCount)
            : undefined
        out.push({
          key,
          dispatches: bucket.total.dispatches,
          rateLimits: bucket.total.rateLimits,
          premiumUsed: bucket.total.premium,
          avgRetryAfterMs: avg,
          lastDispatchAgoMs: bucket.lastDispatchAt !== undefined ? now - bucket.lastDispatchAt : undefined,
          lastRateLimitAgoMs:
            bucket.lastRateLimitAt !== undefined ? now - bucket.lastRateLimitAt : undefined,
        })
        continue
      }
      let dispatches = 0
      let rateLimits = 0
      let premium = 0
      let retrySum = 0
      let retryCount = 0
      let lastDispatchAt: number | undefined
      let lastRateLimitAt: number | undefined
      for (const event of bucket.events) {
        if (event.at < cutoff) continue
        if (event.kind === "dispatch") {
          dispatches += 1
          lastDispatchAt = event.at
        } else if (event.kind === "rate_limit") {
          rateLimits += 1
          lastRateLimitAt = event.at
          if (typeof event.retryAfterMs === "number" && Number.isFinite(event.retryAfterMs)) {
            retrySum += event.retryAfterMs
            retryCount += 1
          }
        } else if (event.kind === "premium") {
          premium += 1
        }
      }
      out.push({
        key,
        dispatches,
        rateLimits,
        premiumUsed: premium,
        avgRetryAfterMs: retryCount > 0 ? Math.round(retrySum / retryCount) : undefined,
        lastDispatchAgoMs:
          lastDispatchAt !== undefined ? now - lastDispatchAt : undefined,
        lastRateLimitAgoMs:
          lastRateLimitAt !== undefined ? now - lastRateLimitAt : undefined,
      })
    }
    // Stable key-sort for deterministic CLI/JSON output.
    out.sort((a, b) => a.key.localeCompare(b.key))
    return out
  }

  /**
   * Top `n` models by dispatch count across every account inside the
   * window (or since-boot when `sinceMs` is omitted). Ties broken by name.
   */
  topModels(opts: { sinceMs?: number; now?: number; limit?: number } = {}): ModelInvocation[] {
    const now = opts.now ?? Date.now()
    const cutoff = opts.sinceMs !== undefined ? now - opts.sinceMs : undefined
    const limit = opts.limit ?? 3
    const counts = new Map<string, number>()
    for (const bucket of this.buckets.values()) {
      for (const event of bucket.events) {
        if (event.kind !== "dispatch") continue
        if (cutoff !== undefined && event.at < cutoff) continue
        if (!event.model) continue
        counts.set(event.model, (counts.get(event.model) ?? 0) + 1)
      }
    }
    const ranked = [...counts.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => (b.count - a.count) || a.model.localeCompare(b.model))
    return ranked.slice(0, Math.max(0, limit))
  }

  /**
   * Full aggregation bundle for the CLI + HTTP endpoint. Merges in
   * persistent rate-state and connections.json so the caller has a single
   * view of dispatch + cooldown health.
   */
  aggregate(opts: AggregateOptions = {}): AggregateStats {
    const now = opts.now ?? Date.now()
    const snapshots = this.snapshot({ sinceMs: opts.sinceMs, now })
    const byKey = new Map<string, PerAccountStats>()
    for (const item of snapshots) byKey.set(item.key, item)

    const rateRows = opts.rateRows ?? opts.rateStore?.loadAll() ?? []
    for (const row of rateRows) {
      const existing = byKey.get(row.key) ?? {
        key: row.key,
        dispatches: 0,
        rateLimits: 0,
        premiumUsed: 0,
      }
      existing.exhaustedUntil = row.exhaustedUntil
      existing.headerless429Count = row.headerless429Count
      existing.persistentLast429At = row.last429At
      byKey.set(row.key, existing)
    }

    const conns = opts.connections?.connections ?? {}
    for (const [key, info] of Object.entries(conns)) {
      const existing = byKey.get(key) ?? {
        key,
        dispatches: 0,
        rateLimits: 0,
        premiumUsed: 0,
      }
      if (info.deactivated) existing.deactivated = true
      existing.pool = opts.poolFor?.(key, info.plan) ?? fallbackPool(key, info.plan)
      byKey.set(key, existing)
    }
    for (const item of byKey.values()) {
      if (item.pool === undefined) item.pool = opts.poolFor?.(item.key) ?? fallbackPool(item.key)
    }

    const accounts = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))

    const poolMap = new Map<string, PoolHealth>()
    let totalDeactivated = 0
    for (const item of accounts) {
      const pool = item.pool ?? "unknown"
      let entry = poolMap.get(pool)
      if (!entry) {
        entry = { pool, accounts: 0, deactivated: 0, inCooldown: 0 }
        poolMap.set(pool, entry)
      }
      entry.accounts += 1
      if (item.deactivated) {
        entry.deactivated += 1
        totalDeactivated += 1
      }
      if (item.exhaustedUntil !== undefined && item.exhaustedUntil > now) {
        entry.inCooldown += 1
      }
    }
    const pools = [...poolMap.values()].sort((a, b) => a.pool.localeCompare(b.pool))

    const totals = accounts.reduce(
      (acc, item) => {
        acc.dispatches += item.dispatches
        acc.rateLimits += item.rateLimits
        acc.premium += item.premiumUsed
        return acc
      },
      { dispatches: 0, rateLimits: 0, premium: 0 },
    )

    return {
      schemaVersion: STATS_SCHEMA_VERSION,
      generatedAt: now,
      bootedAt: this.bootedAt,
      windowMs: opts.sinceMs ?? null,
      accounts,
      topModels: this.topModels({ sinceMs: opts.sinceMs, now, limit: 3 }),
      pools,
      totals: {
        accounts: accounts.length,
        deactivated: totalDeactivated,
        dispatches: totals.dispatches,
        rateLimits: totals.rateLimits,
        premium: totals.premium,
      },
    }
  }
}

/**
 * Plan-only pool classifier used when the caller doesn't supply a richer
 * mapping. Matches `pool-routing.ts::poolForAccount` for the common shapes
 * so CLI output lines up with `providers accounts` without us taking a hard
 * dep on the full pool-routing config.
 */
export function fallbackPool(key: string, plan?: string): string | undefined {
  if (/^github-copilot#edu-/.test(key)) return "edu"
  if (!plan) return undefined
  const normalized = plan.toLowerCase()
  if (normalized === "edu" || normalized === "free" || normalized === "individual") return "edu"
  if (["enterprise", "pro", "business", "team"].includes(normalized)) return "prod"
  return undefined
}

/**
 * Process-wide singleton. The plugin bootstrap wires dispatch + rate-limit
 * events to this instance; CLI + HTTP query through it.
 */
export const CopilotStats = new Stats()

/**
 * Read the persistent rate-state SQLite file at {@link rateStateFile}.
 * Returns `[]` when the file is missing or `bun:sqlite` isn't available
 * (test / Node runs) so callers never have to handle exceptions.
 */
export async function loadPersistedRateRows(filePath = rateStateFile): Promise<RateRow[]> {
  const store = await openRateStore(filePath).catch(() => undefined)
  if (!store) return []
  try {
    return store.loadAll()
  } finally {
    try {
      store.close()
    } catch {
      // noop — close() is best-effort for read-only queries
    }
  }
}

/**
 * Pretty-print an aggregate as a CLI-friendly table. Used by
 * `providers stats` text mode. Returned as a list of lines so the caller
 * can decide whether to pipe through `prompts.log.info` or `process.stdout`.
 */
export function renderStatsText(input: AggregateStats, now = Date.now()): string[] {
  const lines: string[] = []
  const window = input.windowMs === null ? "since boot" : `last ${formatDuration(input.windowMs)}`
  lines.push(
    `GitHub Copilot stats (${window}) — ${input.totals.accounts} account${input.totals.accounts === 1 ? "" : "s"}, ` +
      `${input.totals.dispatches} dispatch${input.totals.dispatches === 1 ? "" : "es"}, ` +
      `${input.totals.rateLimits} 429${input.totals.rateLimits === 1 ? "" : "s"}, ` +
      `${input.totals.premium} premium stamp${input.totals.premium === 1 ? "" : "s"}`,
  )
  if (input.accounts.length === 0) {
    lines.push("  (no dispatch activity recorded)")
  } else {
    lines.push(
      padRow(["key", "pool", "dispatches", "429s", "premium", "retry-avg", "last-429"], [32, 8, 11, 6, 8, 10, 12]),
    )
    for (const item of input.accounts) {
      const avg = item.avgRetryAfterMs !== undefined ? `${Math.round(item.avgRetryAfterMs / 1000)}s` : "-"
      const last = item.lastRateLimitAgoMs !== undefined ? `${ago(item.lastRateLimitAgoMs)}` : "-"
      const pool = item.pool ?? (item.deactivated ? "off" : "-")
      lines.push(
        padRow(
          [
            item.key,
            pool,
            String(item.dispatches),
            String(item.rateLimits),
            String(item.premiumUsed),
            avg,
            last,
          ],
          [32, 8, 11, 6, 8, 10, 12],
        ),
      )
    }
  }
  if (input.topModels.length > 0) {
    lines.push("")
    lines.push("Top models:")
    input.topModels.forEach((m, idx) => lines.push(`  ${idx + 1}. ${m.model} (${m.count})`))
  }
  if (input.pools.length > 0) {
    lines.push("")
    lines.push("Pools:")
    for (const pool of input.pools) {
      lines.push(
        `  ${pool.pool}: ${pool.accounts} account${pool.accounts === 1 ? "" : "s"}` +
          `, ${pool.deactivated} deactivated, ${pool.inCooldown} in cooldown`,
      )
    }
  }
  void now
  return lines
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

function ago(ms: number): string {
  return formatDuration(ms) + " ago"
}

function padRow(cells: string[], widths: number[]): string {
  return cells.map((cell, idx) => pad(cell, widths[idx] ?? 0)).join("  ")
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value
  return value + " ".repeat(width - value.length)
}
