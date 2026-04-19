import { describe, expect, test, beforeEach } from "bun:test"
import {
  CopilotTelemetry,
  METRICS,
  resolveTelemetryConfig,
  TelemetryRing,
  getCopilotTelemetry,
  installCopilotMeter,
  setCopilotTelemetry,
} from "@/plugin/github-copilot/telemetry"
import type { Counter, Histogram, Meter } from "@opentelemetry/api"

/**
 * Mock OTEL Meter that records every counter `.add()` and histogram
 * `.record()` into in-memory maps — lets us assert metric names + tag
 * shape without standing up a real SDK.
 */
class MockMeter implements Meter {
  readonly counters = new Map<string, Array<{ value: number; attrs: Record<string, unknown> }>>()
  readonly histograms = new Map<string, Array<{ value: number; attrs: Record<string, unknown> }>>()

  createCounter(name: string): Counter {
    const list: Array<{ value: number; attrs: Record<string, unknown> }> = []
    this.counters.set(name, list)
    return {
      add: (value: number, attrs?: Record<string, unknown>) => {
        list.push({ value, attrs: { ...(attrs ?? {}) } })
      },
    } as unknown as Counter
  }
  createHistogram(name: string): Histogram {
    const list: Array<{ value: number; attrs: Record<string, unknown> }> = []
    this.histograms.set(name, list)
    return {
      record: (value: number, attrs?: Record<string, unknown>) => {
        list.push({ value, attrs: { ...(attrs ?? {}) } })
      },
    } as unknown as Histogram
  }
  // Unused Meter surface — satisfy the type but throw on unexpected use.
  createGauge(): never {
    throw new Error("MockMeter.createGauge not supported")
  }
  createUpDownCounter(): never {
    throw new Error("MockMeter.createUpDownCounter not supported")
  }
  createObservableGauge(): never {
    throw new Error("MockMeter.createObservableGauge not supported")
  }
  createObservableCounter(): never {
    throw new Error("MockMeter.createObservableCounter not supported")
  }
  createObservableUpDownCounter(): never {
    throw new Error("MockMeter.createObservableUpDownCounter not supported")
  }
  addBatchObservableCallback(): void {}
  removeBatchObservableCallback(): void {}
}

describe("resolveTelemetryConfig", () => {
  test("env enabled true overrides config false", () => {
    const cfg = resolveTelemetryConfig({ enabled: false, endpoint: "http://x" }, {
      OPENCODE_COPILOT_TELEMETRY_ENABLED: "true",
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.endpoint).toBe("http://x")
  })

  test("env endpoint overrides config endpoint", () => {
    const cfg = resolveTelemetryConfig({ endpoint: "http://cfg" }, {
      OPENCODE_COPILOT_TELEMETRY_ENDPOINT: "http://env",
    })
    expect(cfg.endpoint).toBe("http://env")
  })

  test("falls back to OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    const cfg = resolveTelemetryConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp/v1/metrics",
    })
    expect(cfg.endpoint).toBe("http://otlp/v1/metrics")
    // auto-enable when endpoint is present and enabled is unset
    expect(cfg.enabled).toBe(true)
  })

  test("disabled when no endpoint + no explicit enable", () => {
    const cfg = resolveTelemetryConfig(undefined, {})
    expect(cfg.enabled).toBe(false)
    expect(cfg.endpoint).toBeUndefined()
  })

  test("buffer cap env override wins over config", () => {
    const cfg = resolveTelemetryConfig({ bufferCap: 100 }, {
      OPENCODE_COPILOT_TELEMETRY_BUFFER: "512",
    })
    expect(cfg.bufferCap).toBe(512)
  })

  test("export interval env override wins", () => {
    const cfg = resolveTelemetryConfig({ exportIntervalMs: 5000 }, {
      OPENCODE_COPILOT_TELEMETRY_EXPORT_INTERVAL_MS: "9000",
    })
    expect(cfg.exportIntervalMs).toBe(9000)
  })
})

describe("TelemetryRing", () => {
  test("respects cap and returns tail in insertion order", () => {
    const ring = new TelemetryRing(3)
    for (let i = 0; i < 5; i++) ring.push({ at: i, kind: "request", status: 200, durationMs: 10 })
    expect(ring.size()).toBe(3)
    const tail = ring.tail(2)
    expect(tail.length).toBe(2)
    expect(tail[0]!.at).toBe(3)
    expect(tail[1]!.at).toBe(4)
  })

  test("prune drops records older than window", () => {
    const ring = new TelemetryRing(10)
    ring.push({ at: 100, kind: "request", status: 200, durationMs: 10 })
    ring.push({ at: 500, kind: "request", status: 200, durationMs: 10 })
    ring.prune(300, 600)
    expect(ring.size()).toBe(1)
    expect(ring.tail(10)[0]!.at).toBe(500)
  })
})

describe("CopilotTelemetry", () => {
  let meter: MockMeter
  let telemetry: CopilotTelemetry

  beforeEach(() => {
    meter = new MockMeter()
    telemetry = new CopilotTelemetry(
      { enabled: true, endpoint: "http://test", bufferCap: 256, exportIntervalMs: 1000 },
      meter,
    )
  })

  test("recordRequest emits counter + histogram with expected tags", () => {
    telemetry.recordRequest({
      accountKey: "github-copilot#work",
      model: "gpt-5.4-xhigh",
      pool: "prod",
      status: 200,
      durationMs: 123,
    })
    const counter = meter.counters.get(METRICS.apiRequestCount)
    expect(counter?.length).toBe(1)
    expect(counter?.[0]!.value).toBe(1)
    expect(counter?.[0]!.attrs).toMatchObject({
      account_key: "github-copilot#work",
      model: "gpt-5.4-xhigh",
      pool: "prod",
      status_code: 200,
      success: true,
    })
    const histogram = meter.histograms.get(METRICS.apiRequestDuration)
    expect(histogram?.length).toBe(1)
    expect(histogram?.[0]!.value).toBe(123)
    // Ring buffer also captured
    expect(telemetry.snapshot().length).toBe(1)
    expect(telemetry.snapshot()[0]!.kind).toBe("request")
    expect(telemetry.snapshot()[0]!.success).toBe(true)
  })

  test("non-2xx request sets success=false", () => {
    telemetry.recordRequest({
      accountKey: "k",
      model: "m",
      status: 500,
      durationMs: 10,
    })
    const counter = meter.counters.get(METRICS.apiRequestCount)
    expect(counter?.[0]!.attrs.success).toBe(false)
    expect(telemetry.snapshot()[0]!.success).toBe(false)
  })

  test("record429 bumps retry counter without emitting request metric", () => {
    telemetry.record429("github-copilot#edu-1", "gpt-4.1", "edu")
    const retries = meter.counters.get(METRICS.retry429)
    expect(retries?.length).toBe(1)
    expect(retries?.[0]!.value).toBe(1)
    expect(retries?.[0]!.attrs).toMatchObject({
      account_key: "github-copilot#edu-1",
      model: "gpt-4.1",
      pool: "edu",
    })
    // Does NOT touch the api_request counter
    expect(meter.counters.get(METRICS.apiRequestCount)).toBeUndefined()
    expect(telemetry.snapshot()[0]!.kind).toBe("retry_429")
  })

  test("recordSse emits counter + histogram with kind and success", () => {
    telemetry.recordSse({
      accountKey: "k",
      model: "m",
      pool: "prod",
      kind: "response.completed",
      durationMs: 42,
      success: true,
    })
    const counter = meter.counters.get(METRICS.sseEventCount)
    expect(counter?.[0]!.attrs).toMatchObject({
      account_key: "k",
      model: "m",
      pool: "prod",
      kind: "response.completed",
      success: true,
    })
    expect(meter.histograms.get(METRICS.sseEventDuration)?.[0]!.value).toBe(42)
  })

  test("recordSse missing kind defaults to 'unknown' in tags", () => {
    telemetry.recordSse({ durationMs: 1, success: false })
    expect(meter.counters.get(METRICS.sseEventCount)?.[0]!.attrs.kind).toBe("unknown")
  })

  test("recordSessionTurn emits turns + tokens counters and cost histogram", () => {
    telemetry.recordSessionTurn({
      accountKey: "k",
      model: "claude-sonnet-4.7",
      inputTokens: 1000,
      outputTokens: 250,
      cost: 0.015,
    })
    expect(meter.counters.get(METRICS.sessionTurns)?.[0]!.value).toBe(1)
    expect(meter.counters.get(METRICS.sessionInputTokens)?.[0]!.value).toBe(1000)
    expect(meter.counters.get(METRICS.sessionOutputTokens)?.[0]!.value).toBe(250)
    expect(meter.histograms.get(METRICS.sessionCost)?.[0]!.value).toBe(0.015)
  })

  test("recordToolCall emits tools counter with tool + success tag", () => {
    telemetry.recordToolCall({ tool: "read", model: "m", success: true })
    const counter = meter.counters.get(METRICS.sessionTools)
    expect(counter?.[0]!.attrs).toMatchObject({ tool: "read", model: "m", success: true })
  })

  test("no-op telemetry (no meter) still fills ring buffer", () => {
    const ringOnly = new CopilotTelemetry({ enabled: false, bufferCap: 10 })
    ringOnly.recordRequest({ accountKey: "k", status: 200, durationMs: 1 })
    ringOnly.record429("k", "m", "edu")
    expect(ringOnly.snapshot().length).toBe(2)
    expect(ringOnly.snapshot()[0]!.kind).toBe("request")
    expect(ringOnly.snapshot()[1]!.kind).toBe("retry_429")
  })

  test("tail returns at most N most-recent records", () => {
    const t = new CopilotTelemetry({ enabled: false, bufferCap: 50 })
    for (let i = 0; i < 5; i++) {
      t.recordRequest({ accountKey: "k", status: 200, durationMs: i })
    }
    const tail = t.tail(3)
    expect(tail.length).toBe(3)
    expect(tail.map((r) => r.durationMs)).toEqual([2, 3, 4])
  })

  test("reset clears buffer", () => {
    telemetry.recordRequest({ accountKey: "k", status: 200, durationMs: 1 })
    expect(telemetry.snapshot().length).toBe(1)
    telemetry.reset()
    expect(telemetry.snapshot().length).toBe(0)
  })

  test("undefined tags are not emitted", () => {
    telemetry.recordRequest({ durationMs: 5, status: 200 })
    const attrs = meter.counters.get(METRICS.apiRequestCount)?.[0]!.attrs
    expect("account_key" in attrs!).toBe(false)
    expect("model" in attrs!).toBe(false)
    expect("pool" in attrs!).toBe(false)
  })
})

describe("singleton", () => {
  test("installCopilotMeter swaps the singleton meter + carries ring", () => {
    const original = getCopilotTelemetry()
    // Ensure clean start
    original.reset()
    original.recordRequest({ accountKey: "k", status: 200, durationMs: 1 })
    const initialRing = original.snapshot().length
    expect(initialRing).toBe(1)

    const meter = new MockMeter()
    const installed = installCopilotMeter(meter, { endpoint: "http://x" })
    // Ring carried over from the default singleton
    expect(installed.snapshot().length).toBe(initialRing)
    // New record hits the mock meter
    installed.recordRequest({ accountKey: "k2", status: 200, durationMs: 2 })
    expect(meter.counters.get(METRICS.apiRequestCount)?.length).toBe(1)
    expect(getCopilotTelemetry()).toBe(installed)

    // Restore original so subsequent tests don't see our mock
    setCopilotTelemetry(original)
    original.reset()
  })
})
