import { describe, expect, test } from "bun:test"
import { HttpRetry } from "../../src/http/retry"
import { HttpErrors } from "../../src/http/errors"

describe("HttpRetry.nextDelay", () => {
  const policy: HttpRetry.Policy = {
    maxAttempts: 4,
    baseMs: 100,
    maxMs: 10_000,
    factor: 2,
    jitter: 0,
  }

  test("deterministic exponential growth without jitter", () => {
    expect(HttpRetry.nextDelay(policy, { attempt: 1 })).toBe(100)
    expect(HttpRetry.nextDelay(policy, { attempt: 2 })).toBe(200)
    expect(HttpRetry.nextDelay(policy, { attempt: 3 })).toBe(400)
    expect(HttpRetry.nextDelay(policy, { attempt: 4 })).toBe(800)
  })

  test("caps at maxMs", () => {
    expect(HttpRetry.nextDelay({ ...policy, maxMs: 150 }, { attempt: 3 })).toBe(150)
  })

  test("retry-after always wins when present (capped by maxMs)", () => {
    expect(HttpRetry.nextDelay(policy, { attempt: 1, retryAfterMs: 5_000 })).toBe(5_000)
    expect(HttpRetry.nextDelay(policy, { attempt: 4, retryAfterMs: 999_999 })).toBe(10_000)
    expect(HttpRetry.nextDelay(policy, { attempt: 1, retryAfterMs: 0 })).toBe(0)
  })

  test("jitter bounded to [0, maxMs] and uses injected rng", () => {
    const withJitter: HttpRetry.Policy = { ...policy, jitter: 0.5 }
    // rng()==1 pushes toward upper bound (capped + spread)
    const upper = HttpRetry.nextDelay(withJitter, { attempt: 1, rng: () => 1 })
    // rng()==0 pushes toward lower bound (capped - spread)
    const lower = HttpRetry.nextDelay(withJitter, { attempt: 1, rng: () => 0 })
    expect(upper).toBe(150) // 100 + 50
    expect(lower).toBe(50)
  })
})

describe("HttpRetry.shouldRetry", () => {
  const policy: HttpRetry.Policy = { maxAttempts: 3, baseMs: 10, maxMs: 100, factor: 2, jitter: 0 }

  test("retries retryable HttpError below maxAttempts", () => {
    const err = new HttpErrors.HttpError({ kind: "rate-limited", message: "429" })
    expect(HttpRetry.shouldRetry(err, 1, policy)).toBe(true)
    expect(HttpRetry.shouldRetry(err, 2, policy)).toBe(true)
    expect(HttpRetry.shouldRetry(err, 3, policy)).toBe(false)
  })

  test("does not retry client errors", () => {
    const err = new HttpErrors.HttpError({ kind: "client", message: "400" })
    expect(HttpRetry.shouldRetry(err, 1, policy)).toBe(false)
  })

  test("does not retry auth errors", () => {
    const err = new HttpErrors.HttpError({ kind: "auth", message: "401" })
    expect(HttpRetry.shouldRetry(err, 1, policy)).toBe(false)
  })

  test("does not retry plain Error instances", () => {
    expect(HttpRetry.shouldRetry(new Error("boom"), 1, policy)).toBe(false)
  })
})

describe("HttpRetry.run", () => {
  test("succeeds on first attempt without sleeping", async () => {
    let sleeps = 0
    const out = await HttpRetry.run(
      HttpRetry.DEFAULT,
      async () => 42,
      { sleep: async () => void sleeps++ },
    )
    expect(out).toBe(42)
    expect(sleeps).toBe(0)
  })

  test("retries retryable error and eventually succeeds", async () => {
    const attempts: number[] = []
    const policy: HttpRetry.Policy = { maxAttempts: 3, baseMs: 1, maxMs: 10, factor: 2, jitter: 0 }
    const out = await HttpRetry.run(
      policy,
      async (attempt) => {
        attempts.push(attempt)
        if (attempt < 3)
          throw new HttpErrors.HttpError({ kind: "server", message: "502", status: 502 })
        return "ok"
      },
      { sleep: async () => undefined },
    )
    expect(out).toBe("ok")
    expect(attempts).toEqual([1, 2, 3])
  })

  test("stops after maxAttempts and rethrows", async () => {
    const policy: HttpRetry.Policy = { maxAttempts: 2, baseMs: 1, maxMs: 10, factor: 2, jitter: 0 }
    let calls = 0
    await expect(
      HttpRetry.run(
        policy,
        async () => {
          calls += 1
          throw new HttpErrors.HttpError({ kind: "rate-limited", message: "429" })
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toMatchObject({ kind: "rate-limited" })
    expect(calls).toBe(2)
  })

  test("honors retry-after sleep on rate-limited response", async () => {
    const policy: HttpRetry.Policy = { maxAttempts: 3, baseMs: 50, maxMs: 10_000, factor: 2, jitter: 0 }
    const slept: number[] = []
    let n = 0
    const out = await HttpRetry.run(
      policy,
      async () => {
        n += 1
        if (n === 1)
          throw new HttpErrors.HttpError({ kind: "rate-limited", message: "429", retryAfterMs: 1234 })
        return "ok"
      },
      { sleep: async (ms) => void slept.push(ms) },
    )
    expect(out).toBe("ok")
    expect(slept).toEqual([1234])
  })

  test("propagates non-HttpError immediately", async () => {
    let calls = 0
    await expect(
      HttpRetry.run(
        HttpRetry.DEFAULT,
        async () => {
          calls += 1
          throw new Error("programmer bug")
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("programmer bug")
    expect(calls).toBe(1)
  })
})
