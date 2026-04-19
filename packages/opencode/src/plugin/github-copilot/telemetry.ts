/**
 * OpenTelemetry export surface for the GitHub Copilot multi-account
 * dispatch pipeline. Ported from the Rust `codex-otel` crate (see
 * `codex-rs/otel/src/events/session_telemetry.rs`), specifically the
 * `SessionTelemetry`, `RequestTelemetry`, and `SseTelemetry` traits that
 * `codex-core/src/client.rs::ApiTelemetry` wires into the API client.
 *
 * Responsibilities:
 *   1. A lazy, opt-in OTEL pipeline (Meter + OTLP/HTTP exporter) keyed on
 *      either the `copilot.telemetry` config section or the
 *      `OPENCODE_COPILOT_TELEMETRY_*` env vars. When neither is set the
 *      module is a no-op.
 *   2. Three record helpers that mirror the Rust surface:
 *        - `recordSessionTurn`   (per-turn: tokens in/out, tools invoked, cost)
 *        - `recordRequest`       (per-HTTP attempt: status, latency, retry#)
 *        - `recordSse`           (per-SSE frame: kind, duration, success)
 *   3. A bounded in-memory ring buffer that the `providers telemetry`
 *      CLI tails — no external collector required for local inspection.
 *   4. `copilot.retries.429` counter increment helper consumed by the
 *      rate-limiter / dispatch 429 branch.
 *
 * The metric namespace is `opencode.copilot.*` to avoid collision with
 * Rust's `codex.*` meters — we treat this as a parallel, opencode-side
 * observability signal.
 *
 * Metric catalog (tags in parentheses):
 *   - `opencode.copilot.api_request`          counter    (account_key, model, pool, status_code)
 *   - `opencode.copilot.api_request.duration` histogram  (account_key, model, pool, status_code)
 *   - `opencode.copilot.sse_event`            counter    (account_key, model, pool, kind, success)
 *   - `opencode.copilot.sse_event.duration`   histogram  (account_key, model, pool, kind, success)
 *   - `opencode.copilot.retries.429`          counter    (account_key, model, pool)
 *   - `opencode.copilot.session.turns`        counter    (model)
 *   - `opencode.copilot.session.tools`        counter    (model, tool)
 *   - `opencode.copilot.session.tokens.input` counter    (account_key, model)
 *   - `opencode.copilot.session.tokens.output`counter    (account_key, model)
 *   - `opencode.copilot.session.cost`         histogram  (model)
 *
 * All `recordX` helpers are safe to call when disabled — they short-circuit
 * on the singleton's `enabled` flag before touching any OTEL API.
 */

import { metrics, type Attributes, type Counter, type Histogram, type Meter } from "@opentelemetry/api"

/**
 * Attributes common to every `opencode.copilot.*` metric. Missing fields
 * are elided — OTEL rejects `undefined` but accepts empty omission, so we
 * filter at the edge.
 */
export type TelemetryTags = {
  account_key?: string
  model?: string
  pool?: string
  status_code?: number
  success?: boolean
  kind?: string
  tool?: string
}

/** Snapshot of a single telemetry event held in the in-memory ring. */
export type TelemetryRecord = {
  at: number
  kind:
    | "request"
    | "sse"
    | "session_turn"
    | "session_tokens"
    | "retry_429"
    | "tool_call"
  account_key?: string
  model?: string
  pool?: string
  status?: number
  durationMs?: number
  attempt?: number
  success?: boolean
  sseKind?: string
  inputTokens?: number
  outputTokens?: number
  cost?: number
  tool?: string
  error?: string
}

/** Per-record metric that `SessionTelemetry.record_api_request` emits. */
export type RequestTelemetry = {
  accountKey?: string
  model?: string
  pool?: string
  status?: number
  durationMs: number
  attempt?: number
  error?: string
}

/** Per-record metric for an SSE frame; mirrors Rust `SseTelemetry`. */
export type SseTelemetry = {
  accountKey?: string
  model?: string
  pool?: string
  kind?: string
  durationMs: number
  success: boolean
  error?: string
}

/** Per-turn token / cost rollup; mirrors Rust `sse_event_completed`. */
export type SessionTelemetry = {
  accountKey?: string
  model?: string
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  cost?: number
  toolsInvoked?: number
}

/** Static tool call record. */
export type ToolCallTelemetry = {
  tool: string
  model?: string
  durationMs?: number
  success?: boolean
}

/** Resolved + normalised telemetry configuration. */
export type TelemetryConfig = {
  enabled: boolean
  endpoint?: string
  headers?: Record<string, string>
  /** Ring-buffer retention (records). Default 2048. */
  bufferCap?: number
  /** OTLP export interval (ms). Default 15000. */
  exportIntervalMs?: number
}

export const METRICS = {
  apiRequestCount: "opencode.copilot.api_request",
  apiRequestDuration: "opencode.copilot.api_request.duration",
  sseEventCount: "opencode.copilot.sse_event",
  sseEventDuration: "opencode.copilot.sse_event.duration",
  retry429: "opencode.copilot.retries.429",
  sessionTurns: "opencode.copilot.session.turns",
  sessionTools: "opencode.copilot.session.tools",
  sessionInputTokens: "opencode.copilot.session.tokens.input",
  sessionOutputTokens: "opencode.copilot.session.tokens.output",
  sessionCost: "opencode.copilot.session.cost",
} as const

const DEFAULT_BUFFER_CAP = 2048
const DEFAULT_EXPORT_INTERVAL_MS = 15_000

/**
 * Env-var override loader. Explicit env wins over config; when `enabled`
 * is unset we default to "true when endpoint is set, else false". This
 * matches the Rust `OTEL_EXPORTER_OTLP_ENDPOINT` convention.
 */
export function resolveTelemetryConfig(
  cfg: Partial<TelemetryConfig> | undefined,
  env: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  const envEndpoint =
    env.OPENCODE_COPILOT_TELEMETRY_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    undefined
  const endpoint = envEndpoint ?? cfg?.endpoint ?? undefined

  const envEnabledRaw = env.OPENCODE_COPILOT_TELEMETRY_ENABLED
  let enabled: boolean
  if (envEnabledRaw !== undefined) {
    enabled = /^(1|true|yes|on)$/i.test(envEnabledRaw.trim())
  } else if (typeof cfg?.enabled === "boolean") {
    enabled = cfg.enabled
  } else {
    // Auto-enable when an endpoint is configured and ring-buffer-only mode
    // is implied when no endpoint is present but explicit enable=true.
    enabled = endpoint !== undefined
  }

  // Always-on ring buffer: even when exporter is disabled, we still fill
  // the in-memory buffer so `providers telemetry --tail` works out of the
  // box. The `enabled` flag governs OTLP export only.
  const bufferCap =
    parsePositiveInt(env.OPENCODE_COPILOT_TELEMETRY_BUFFER) ?? cfg?.bufferCap ?? DEFAULT_BUFFER_CAP
  const exportIntervalMs =
    parsePositiveInt(env.OPENCODE_COPILOT_TELEMETRY_EXPORT_INTERVAL_MS) ??
    cfg?.exportIntervalMs ??
    DEFAULT_EXPORT_INTERVAL_MS

  return {
    enabled,
    endpoint,
    headers: cfg?.headers,
    bufferCap,
    exportIntervalMs,
  }
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * In-memory bounded ring. Separated from the singleton so tests can mint a
 * fresh buffer per case.
 */
export class TelemetryRing {
  private items: TelemetryRecord[] = []
  constructor(private readonly cap = DEFAULT_BUFFER_CAP) {}
  push(record: TelemetryRecord): void {
    this.items.push(record)
    while (this.items.length > this.cap) this.items.shift()
  }
  tail(limit: number): TelemetryRecord[] {
    if (limit <= 0) return []
    if (this.items.length <= limit) return [...this.items]
    return this.items.slice(this.items.length - limit)
  }
  all(): TelemetryRecord[] {
    return [...this.items]
  }
  clear(): void {
    this.items = []
  }
  /** Drop records older than `at - windowMs`. */
  prune(windowMs: number, now: number = Date.now()): void {
    const cutoff = now - windowMs
    this.items = this.items.filter((r) => r.at >= cutoff)
  }
  size(): number {
    return this.items.length
  }
}

/** Minimal adapter so tests can plug a fake `Meter`. */
export interface MeterFactory {
  getMeter(name: string, version?: string): Meter
}

/**
 * The observability singleton. Initialised lazily the first time a record
 * helper runs; holds the buffer, resolved config, and (optionally) the
 * OTEL exporter handle. Construct explicitly for tests.
 */
export class CopilotTelemetry {
  readonly ring: TelemetryRing
  readonly config: TelemetryConfig
  private readonly meter: Meter | undefined
  private readonly counters = new Map<string, Counter>()
  private readonly histograms = new Map<string, Histogram>()
  private exporterShutdown?: () => Promise<void> | void

  constructor(
    config: TelemetryConfig,
    meter?: Meter,
    shutdown?: () => Promise<void> | void,
  ) {
    this.config = config
    this.ring = new TelemetryRing(config.bufferCap ?? DEFAULT_BUFFER_CAP)
    this.meter = meter
    this.exporterShutdown = shutdown
  }

  /**
   * Primary factory. When `enabled` is true and an endpoint is resolved
   * the method spins up a `MeterProvider` + `PeriodicExportingMetricReader`;
   * otherwise it returns a ring-only singleton with `meter` undefined so
   * `counter()` / `histogram()` become no-ops for OTEL but the buffer keeps
   * feeding `providers telemetry --tail`.
   *
   * OTEL packages are imported dynamically so a plain `bun run` without
   * OTEL deps doesn't fault; a silent fallback to the ring buffer is the
   * documented behaviour.
   */
  static async create(
    cfg: Partial<TelemetryConfig> | undefined,
    env: Record<string, string | undefined> = process.env,
  ): Promise<CopilotTelemetry> {
    const resolved = resolveTelemetryConfig(cfg, env)
    if (!resolved.enabled || !resolved.endpoint) {
      return new CopilotTelemetry(resolved)
    }
    try {
      const [{ MeterProvider, PeriodicExportingMetricReader }, { OTLPMetricExporter }, { resourceFromAttributes }] =
        await Promise.all([
          import("@opentelemetry/sdk-metrics"),
          import("@opentelemetry/exporter-metrics-otlp-http"),
          import("@opentelemetry/resources"),
        ])
      const exporter = new OTLPMetricExporter({
        url: resolved.endpoint,
        headers: resolved.headers,
      })
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: resolved.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS,
      })
      const provider = new MeterProvider({
        resource: resourceFromAttributes({
          "service.name": "opencode-copilot",
          "service.version": process.env.OPENCODE_VERSION ?? "dev",
        }),
        readers: [reader],
      })
      const meter = provider.getMeter("opencode.copilot", "1.0.0")
      return new CopilotTelemetry(resolved, meter, async () => {
        try {
          await provider.shutdown()
        } catch {
          // best-effort shutdown
        }
      })
    } catch (err) {
      // Dependency missing or exporter failed to boot — keep the buffer,
      // print once to stderr so the failure surfaces in logs.
      process.stderr.write(
        `opencode copilot telemetry: failed to init OTLP exporter (${String(err)}); falling back to in-memory buffer only\n`,
      )
      return new CopilotTelemetry({ ...resolved, enabled: false })
    }
  }

  private counter(name: string): Counter | undefined {
    if (!this.meter) return undefined
    const existing = this.counters.get(name)
    if (existing) return existing
    const c = this.meter.createCounter(name, { description: `copilot counter ${name}` })
    this.counters.set(name, c)
    return c
  }

  private histogram(name: string): Histogram | undefined {
    if (!this.meter) return undefined
    const existing = this.histograms.get(name)
    if (existing) return existing
    const h = this.meter.createHistogram(name, { description: `copilot histogram ${name}` })
    this.histograms.set(name, h)
    return h
  }

  /** Normalise a TelemetryTags into OTEL Attributes, dropping undefineds. */
  private attrs(tags: TelemetryTags): Attributes {
    const out: Attributes = {}
    if (tags.account_key !== undefined) out.account_key = tags.account_key
    if (tags.model !== undefined) out.model = tags.model
    if (tags.pool !== undefined) out.pool = tags.pool
    if (tags.status_code !== undefined) out.status_code = tags.status_code
    if (tags.success !== undefined) out.success = tags.success
    if (tags.kind !== undefined) out.kind = tags.kind
    if (tags.tool !== undefined) out.tool = tags.tool
    return out
  }

  /**
   * Record a per-HTTP-attempt telemetry sample. Mirrors Rust
   * `SessionTelemetry::record_api_request` — emits a counter on
   * `opencode.copilot.api_request` and a histogram on
   * `opencode.copilot.api_request.duration`.
   */
  recordRequest(sample: RequestTelemetry, at: number = Date.now()): void {
    const tags: TelemetryTags = {
      account_key: sample.accountKey,
      model: sample.model,
      pool: sample.pool,
      status_code: sample.status,
      success: sample.status !== undefined && sample.status >= 200 && sample.status < 300,
    }
    const attrs = this.attrs(tags)
    this.counter(METRICS.apiRequestCount)?.add(1, attrs)
    this.histogram(METRICS.apiRequestDuration)?.record(sample.durationMs, attrs)
    this.ring.push({
      at,
      kind: "request",
      account_key: sample.accountKey,
      model: sample.model,
      pool: sample.pool,
      status: sample.status,
      durationMs: sample.durationMs,
      attempt: sample.attempt,
      success: tags.success,
      error: sample.error,
    })
  }

  /** Record a per-SSE-frame sample. Mirrors Rust `log_sse_event`. */
  recordSse(sample: SseTelemetry, at: number = Date.now()): void {
    const tags: TelemetryTags = {
      account_key: sample.accountKey,
      model: sample.model,
      pool: sample.pool,
      kind: sample.kind ?? "unknown",
      success: sample.success,
    }
    const attrs = this.attrs(tags)
    this.counter(METRICS.sseEventCount)?.add(1, attrs)
    this.histogram(METRICS.sseEventDuration)?.record(sample.durationMs, attrs)
    this.ring.push({
      at,
      kind: "sse",
      account_key: sample.accountKey,
      model: sample.model,
      pool: sample.pool,
      sseKind: sample.kind,
      durationMs: sample.durationMs,
      success: sample.success,
      error: sample.error,
    })
  }

  /** Increment the 429 retry counter. Called by the 429 branch. */
  record429(accountKey: string | undefined, model: string | undefined, pool: string | undefined, at: number = Date.now()): void {
    const attrs = this.attrs({ account_key: accountKey, model, pool })
    this.counter(METRICS.retry429)?.add(1, attrs)
    this.ring.push({
      at,
      kind: "retry_429",
      account_key: accountKey,
      model,
      pool,
    })
  }

  /**
   * Record the end of a turn — tokens + optional cost. Mirrors Rust
   * `sse_event_completed`.
   */
  recordSessionTurn(sample: SessionTelemetry, at: number = Date.now()): void {
    const attrs = this.attrs({ account_key: sample.accountKey, model: sample.model })
    this.counter(METRICS.sessionTurns)?.add(1, attrs)
    if (Number.isFinite(sample.inputTokens)) {
      this.counter(METRICS.sessionInputTokens)?.add(sample.inputTokens, attrs)
    }
    if (Number.isFinite(sample.outputTokens)) {
      this.counter(METRICS.sessionOutputTokens)?.add(sample.outputTokens, attrs)
    }
    if (typeof sample.cost === "number" && Number.isFinite(sample.cost)) {
      this.histogram(METRICS.sessionCost)?.record(sample.cost, attrs)
    }
    this.ring.push({
      at,
      kind: "session_turn",
      account_key: sample.accountKey,
      model: sample.model,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cost: sample.cost,
    })
  }

  /** Record a tool invocation. Mirrors Rust `TOOL_CALL_COUNT_METRIC`. */
  recordToolCall(sample: ToolCallTelemetry, at: number = Date.now()): void {
    const attrs = this.attrs({ model: sample.model, tool: sample.tool, success: sample.success })
    this.counter(METRICS.sessionTools)?.add(1, attrs)
    this.ring.push({
      at,
      kind: "tool_call",
      model: sample.model,
      tool: sample.tool,
      durationMs: sample.durationMs,
      success: sample.success,
    })
  }

  /** Most-recent-first ordered by insertion time. */
  tail(limit = 50): TelemetryRecord[] {
    return this.ring.tail(limit)
  }

  /** Full buffer (copy) — backs `providers telemetry --json`. */
  snapshot(): TelemetryRecord[] {
    return this.ring.all()
  }

  async shutdown(): Promise<void> {
    if (this.exporterShutdown) await this.exporterShutdown()
  }

  reset(): void {
    this.ring.clear()
  }
}

/**
 * Process-wide singleton managed via lazy init. `getCopilotTelemetry`
 * returns the currently-installed instance; `initCopilotTelemetry` is
 * called once at plugin boot. Tests replace via `setCopilotTelemetry`.
 *
 * We always start with a *ring-only* default so the first `recordX` call
 * from a code path that fires before plugin boot still lands in the
 * buffer and becomes queryable.
 */
let singleton: CopilotTelemetry = new CopilotTelemetry({ enabled: false })

export function getCopilotTelemetry(): CopilotTelemetry {
  return singleton
}

export function setCopilotTelemetry(instance: CopilotTelemetry): void {
  singleton = instance
}

export async function initCopilotTelemetry(
  cfg: Partial<TelemetryConfig> | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<CopilotTelemetry> {
  const instance = await CopilotTelemetry.create(cfg, env)
  // Preserve any already-buffered records from the ring-only default so
  // early events aren't lost on init.
  const carry = singleton.snapshot()
  for (const record of carry) instance.ring.push(record)
  singleton = instance
  return instance
}

/**
 * Explicitly install a meter (for tests or for an externally-managed
 * MeterProvider in the app-server). Rebuilds the singleton with the
 * provided config + meter, carrying over the ring contents.
 */
export function installCopilotMeter(meter: Meter, cfg?: Partial<TelemetryConfig>): CopilotTelemetry {
  const resolved: TelemetryConfig = {
    enabled: true,
    endpoint: cfg?.endpoint,
    headers: cfg?.headers,
    bufferCap: cfg?.bufferCap,
    exportIntervalMs: cfg?.exportIntervalMs,
  }
  const instance = new CopilotTelemetry(resolved, meter)
  const carry = singleton.snapshot()
  for (const record of carry) instance.ring.push(record)
  singleton = instance
  return instance
}

/**
 * Expose the global OTEL `metrics` API so callers that already wire their
 * own `MeterProvider` can just call `metrics.getMeter("opencode.copilot")`
 * without going through our singleton.
 */
export function globalMeter(): Meter {
  return metrics.getMeter("opencode.copilot", "1.0.0")
}
