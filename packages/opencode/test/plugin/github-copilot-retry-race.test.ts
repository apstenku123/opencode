import { describe, expect, test } from "bun:test"
import {
  DEFAULT_HTTP_RETRY_RACE_CONFIG,
  HttpAttemptBus,
  RetryRaceExhaustedError,
  httpRetryRaceConfig,
  raceFetch,
  type HttpAttemptEvent,
  type HttpAttemptObservation,
  type HttpRetryRaceConfig,
} from "@/plugin/github-copilot/retry-race"

const FAST_CFG: HttpRetryRaceConfig = {
  enabled: true,
  staggerMs: 20,
  concurrentLimit: 3,
  maxAttempts: 6,
  totalDeadlineMs: 800,
  eventBusCapacity: 64,
}

function collectObservations(bus: HttpAttemptBus): HttpAttemptObservation[] {
  return bus.snapshot()
}

function eventsForAttempt(observations: HttpAttemptObservation[], attempt: number): HttpAttemptEvent[] {
  return observations
    .filter((o) => {
      const ev = o.event
      if (ev.type === "exhausted") return attempt === 0
      return ev.attempt === attempt
    })
    .map((o) => o.event)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

describe("HttpRetryRaceConfig defaults", () => {
  test("opencode-fork tuned defaults", () => {
    // See `retry-race.ts` — these defaults diverge from the Rust
    // `HttpRetryRaceConfig::default()` to trade a lower quota burn for
    // still-meaningful p99 tail latency reduction.
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.enabled).toBe(true)
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.staggerMs).toBe(20_000)
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.concurrentLimit).toBe(2)
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.maxAttempts).toBe(3)
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.totalDeadlineMs).toBe(150_000)
    expect(DEFAULT_HTTP_RETRY_RACE_CONFIG.eventBusCapacity).toBe(64)
  })
})

describe("HttpAttemptBus", () => {
  test("emits to every subscriber and retains ring buffer", () => {
    const bus = new HttpAttemptBus(4)
    const received: HttpAttemptObservation[] = []
    const off = bus.addObserver((obs) => received.push(obs))
    for (let i = 0; i < 6; i++) {
      bus.emit({ requestId: "r", startedAt: 0, event: { type: "sent", attempt: i } })
    }
    expect(received.length).toBe(6)
    // Ring buffer retained only the last 4 events.
    expect(bus.snapshot().length).toBe(4)
    off()
    // Disposer actually removes the subscription.
    bus.emit({ requestId: "r", startedAt: 0, event: { type: "sent", attempt: 99 } })
    expect(received.length).toBe(6)
  })

  test("observer exceptions do not break the bus", () => {
    const bus = new HttpAttemptBus(2)
    bus.addObserver(() => {
      throw new Error("bad observer")
    })
    let seen = 0
    bus.addObserver(() => {
      seen += 1
    })
    bus.emit({ requestId: "r", startedAt: 0, event: { type: "sent", attempt: 1 } })
    expect(seen).toBe(1)
  })
})

describe("raceFetch — disabled path", () => {
  test("returns attempts[0] without stagger or events", async () => {
    const bus = new HttpAttemptBus(8)
    const spawned: number[] = []
    const attempts = [
      async ({ attempt }: { attempt: number }) => {
        spawned.push(attempt)
        return "ok-1"
      },
      async ({ attempt }: { attempt: number }) => {
        spawned.push(attempt)
        return "ok-2"
      },
    ]
    const result = await raceFetch(attempts, { ...FAST_CFG, enabled: false }, { bus })
    expect(result).toBe("ok-1")
    expect(spawned).toEqual([1])
    expect(bus.snapshot().length).toBe(0)
  })
})

describe("raceFetch — single success", () => {
  test("fires only attempt 1 when it resolves before stagger", async () => {
    const bus = new HttpAttemptBus(32)
    const spawned: number[] = []
    const attempts = [
      async ({ attempt }: { attempt: number }) => {
        spawned.push(attempt)
        await delay(5)
        return "winner-1"
      },
      async () => {
        throw new Error("should never run")
      },
    ]
    const result = await raceFetch(attempts, FAST_CFG, { bus })
    expect(result).toBe("winner-1")
    expect(spawned).toEqual([1])
    const obs = collectObservations(bus)
    expect(eventsForAttempt(obs, 1)).toEqual([
      { type: "sent", attempt: 1 },
      { type: "firstByte", attempt: 1 },
      { type: "succeeded", attempt: 1 },
    ])
    // Attempt 2 was never spawned.
    expect(obs.filter((o) => o.event.type === "sent" && o.event.attempt === 2).length).toBe(0)
  })
})

describe("raceFetch — first stalls, second wins", () => {
  test("second attempt resolves first and cancels the slow first", async () => {
    const bus = new HttpAttemptBus(64)
    const aborts: Record<number, boolean> = {}
    const attempts = [
      async ({ attempt, signal }: { attempt: number; signal: AbortSignal }) => {
        try {
          await delay(5_000, signal) // Stall longer than the whole race.
          return `slow-${attempt}`
        } catch (err) {
          aborts[attempt] = true
          throw err
        }
      },
      async ({ attempt, signal }: { attempt: number; signal: AbortSignal }) => {
        await delay(5, signal)
        return `fast-${attempt}`
      },
    ]
    const result = await raceFetch(attempts, FAST_CFG, { bus })
    expect(result).toBe("fast-2")
    // Give the abort a microtask tick to settle on the slow attempt.
    await new Promise((r) => setTimeout(r, 10))
    expect(aborts[1]).toBe(true)
    const obs = collectObservations(bus)
    // Attempt 1: sent + canceled. Attempt 2: sent + firstByte + succeeded.
    expect(obs.some((o) => o.event.type === "sent" && o.event.attempt === 1)).toBe(true)
    expect(obs.some((o) => o.event.type === "sent" && o.event.attempt === 2)).toBe(true)
    expect(obs.some((o) => o.event.type === "succeeded" && o.event.attempt === 2)).toBe(true)
    expect(
      obs.some((o) => o.event.type === "canceled" && o.event.attempt === 1 && o.event.reason === "raced-sibling-won"),
    ).toBe(true)
  })
})

describe("raceFetch — all fail", () => {
  test("surfaces RetryRaceExhaustedError with collected errors", async () => {
    const bus = new HttpAttemptBus(64)
    const attempts = [
      async () => {
        await delay(5)
        throw new Error("err-1")
      },
      async () => {
        await delay(5)
        throw new Error("err-2")
      },
      async () => {
        await delay(5)
        throw new Error("err-3")
      },
    ]
    const cfg: HttpRetryRaceConfig = { ...FAST_CFG, maxAttempts: 3, totalDeadlineMs: 500 }
    await expect(raceFetch(attempts, cfg, { bus })).rejects.toBeInstanceOf(RetryRaceExhaustedError)
    const obs = collectObservations(bus)
    // At least one failed observation per attempt.
    for (const n of [1, 2, 3]) {
      expect(obs.some((o) => o.event.type === "failed" && o.event.attempt === n)).toBe(true)
    }
    // Exhausted emitted once.
    expect(obs.filter((o) => o.event.type === "exhausted").length).toBe(1)
  })
})

describe("raceFetch — max-attempts exhausted", () => {
  test("caps at cfg.maxAttempts even when more factories are supplied", async () => {
    const bus = new HttpAttemptBus(64)
    const spawned: number[] = []
    const attempts = Array.from({ length: 10 }, () => async ({ attempt }: { attempt: number }) => {
      spawned.push(attempt)
      await delay(10_000) // Always stall.
      return "never"
    })
    const cfg: HttpRetryRaceConfig = { ...FAST_CFG, maxAttempts: 3, concurrentLimit: 3, totalDeadlineMs: 300 }
    await expect(raceFetch(attempts, cfg, { bus })).rejects.toBeInstanceOf(RetryRaceExhaustedError)
    // Only 3 spawned — even though 10 factories were supplied.
    expect(spawned.length).toBe(3)
    expect(spawned.sort()).toEqual([1, 2, 3])
  })
})

describe("raceFetch — cancel after winner", () => {
  test("siblings receive aborted signal once the first winner settles", async () => {
    const bus = new HttpAttemptBus(32)
    const abortReasons: Record<number, unknown> = {}
    const attempts = [
      async ({ attempt, signal }: { attempt: number; signal: AbortSignal }) => {
        try {
          await delay(2_000, signal)
          return "never"
        } catch (err) {
          abortReasons[attempt] = err
          throw err
        }
      },
      async ({ attempt, signal }: { attempt: number; signal: AbortSignal }) => {
        try {
          await delay(2_000, signal)
          return "never"
        } catch (err) {
          abortReasons[attempt] = err
          throw err
        }
      },
      async ({ attempt, signal }: { attempt: number; signal: AbortSignal }) => {
        await delay(10, signal)
        return `winner-${attempt}`
      },
    ]
    const result = await raceFetch(attempts, FAST_CFG, { bus })
    expect(result).toBe("winner-3")
    // Flush microtasks so the abort handlers resolve.
    await new Promise((r) => setTimeout(r, 20))
    expect(abortReasons[1]).toBeInstanceOf(Error)
    expect(abortReasons[2]).toBeInstanceOf(Error)
    expect((abortReasons[1] as Error).message).toContain("retry-race:raced-sibling-won")
    const obs = collectObservations(bus)
    // Two cancellations for the losing attempts.
    const canceled = obs.filter(
      (o) => o.event.type === "canceled" && o.event.reason === "raced-sibling-won",
    )
    expect(canceled.length).toBe(2)
    expect(canceled.map((o) => (o.event as any).attempt).sort()).toEqual([1, 2])
  })
})

describe("raceFetch — parent-signal cancellation", () => {
  test("propagates parent-signal abort to every in-flight attempt", async () => {
    const bus = new HttpAttemptBus(32)
    const ctrl = new AbortController()
    const attempts = [
      async ({ signal }: { signal: AbortSignal }) => {
        await delay(5_000, signal)
        return "never"
      },
      async ({ signal }: { signal: AbortSignal }) => {
        await delay(5_000, signal)
        return "never"
      },
    ]
    const promise = raceFetch(attempts, FAST_CFG, { bus, signal: ctrl.signal })
    // Give the stagger a tick to spawn attempt 2.
    await new Promise((r) => setTimeout(r, 40))
    ctrl.abort(new Error("parent-turn-canceled"))
    await expect(promise).rejects.toThrow()
    const obs = collectObservations(bus)
    expect(
      obs.some((o) => o.event.type === "canceled" && o.event.reason === "parent-canceled"),
    ).toBe(true)
  })
})

describe("raceFetch — unhealthy responses do not win", () => {
  test("ignores a fast non-2xx Response and returns a later healthy Response", async () => {
    const bus = new HttpAttemptBus(32)
    const result = await raceFetch<Response>(
      [
        async ({ signal }) => {
          await delay(5, signal)
          return new Response("rate limited", { status: 429 })
        },
        async ({ signal }) => {
          await delay(35, signal)
          return new Response("ok", { status: 200 })
        },
      ],
      FAST_CFG,
      { bus },
    )
    expect(result.status).toBe(200)
    const obs = collectObservations(bus)
    const firstFailure = obs.find((o) => o.event.type === "failed" && o.event.attempt === 1)
    expect(firstFailure).toBeDefined()
    if (firstFailure?.event.type === "failed") {
      expect(firstFailure.event.error.message).toContain("429")
    }
    expect(obs.some((o) => o.event.type === "succeeded" && o.event.attempt === 2)).toBe(true)
  })
})

describe("httpRetryRaceConfig extractor", () => {
  test("returns defaults when nothing is configured", () => {
    const cfg = httpRetryRaceConfig({})
    expect(cfg).toEqual(DEFAULT_HTTP_RETRY_RACE_CONFIG)
  })

  test("picks up explicit copilot.httpRetryRace.* values", () => {
    const cfg = httpRetryRaceConfig({
      copilot: {
        httpRetryRace: {
          enabled: true,
          staggerMs: 25_000,
          concurrentLimit: 2,
          maxAttempts: 4,
          totalDeadlineMs: 90_000,
          eventBusCapacity: 128,
        },
      },
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.staggerMs).toBe(25_000)
    expect(cfg.concurrentLimit).toBe(2)
    expect(cfg.maxAttempts).toBe(4)
    expect(cfg.totalDeadlineMs).toBe(90_000)
    expect(cfg.eventBusCapacity).toBe(128)
  })

  test("env overrides beat config block", () => {
    const prev = process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_STAGGER_MS
    process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_STAGGER_MS = "5000"
    try {
      const cfg = httpRetryRaceConfig({ copilot: { httpRetryRace: { staggerMs: 40_000 } } })
      expect(cfg.staggerMs).toBe(5_000)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_STAGGER_MS
      else process.env.OPENCODE_COPILOT_HTTP_RETRY_RACE_STAGGER_MS = prev
    }
  })
})
