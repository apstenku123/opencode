import { describe, expect, test } from "bun:test"
import { HttpErrors } from "../../src/http/errors"

describe("HttpErrors.classifyStatus", () => {
  test("returns undefined for 2xx", () => {
    expect(HttpErrors.classifyStatus(200)).toBeUndefined()
    expect(HttpErrors.classifyStatus(204)).toBeUndefined()
    expect(HttpErrors.classifyStatus(299)).toBeUndefined()
  })
  test("401/403 map to auth", () => {
    expect(HttpErrors.classifyStatus(401)).toBe("auth")
    expect(HttpErrors.classifyStatus(403)).toBe("auth")
  })
  test("429 maps to rate-limited", () => {
    expect(HttpErrors.classifyStatus(429)).toBe("rate-limited")
  })
  test("5xx maps to server", () => {
    expect(HttpErrors.classifyStatus(500)).toBe("server")
    expect(HttpErrors.classifyStatus(503)).toBe("server")
    expect(HttpErrors.classifyStatus(599)).toBe("server")
  })
  test("other 4xx maps to client", () => {
    expect(HttpErrors.classifyStatus(400)).toBe("client")
    expect(HttpErrors.classifyStatus(404)).toBe("client")
    expect(HttpErrors.classifyStatus(422)).toBe("client")
  })
})

describe("HttpErrors.parseRetryAfter", () => {
  test("parses numeric seconds", () => {
    expect(HttpErrors.parseRetryAfter("5")).toBe(5_000)
    expect(HttpErrors.parseRetryAfter("0")).toBe(0)
    expect(HttpErrors.parseRetryAfter("0.5")).toBe(500)
  })
  test("parses HTTP-date relative to now", () => {
    const now = Date.parse("2026-04-17T12:00:00Z")
    const future = new Date(now + 30_000).toUTCString()
    expect(HttpErrors.parseRetryAfter(future, now)).toBe(30_000)
  })
  test("returns 0 for past dates", () => {
    const now = Date.parse("2026-04-17T12:00:00Z")
    const past = new Date(now - 30_000).toUTCString()
    expect(HttpErrors.parseRetryAfter(past, now)).toBe(0)
  })
  test("returns undefined for null/empty/garbage", () => {
    expect(HttpErrors.parseRetryAfter(null)).toBeUndefined()
    expect(HttpErrors.parseRetryAfter("")).toBeUndefined()
    expect(HttpErrors.parseRetryAfter("   ")).toBeUndefined()
    expect(HttpErrors.parseRetryAfter("garbage-xyz")).toBeUndefined()
  })
  test("rejects negative seconds", () => {
    expect(HttpErrors.parseRetryAfter("-5")).toBeUndefined()
  })
})

describe("HttpErrors.HttpError", () => {
  test("branch helpers match the kind", () => {
    const auth = new HttpErrors.HttpError({ kind: "auth", message: "401" })
    expect(auth.isAuthError()).toBe(true)
    expect(auth.isRateLimited()).toBe(false)
    expect(auth.isNetworkError()).toBe(false)
    expect(auth.isRetryable()).toBe(false)

    const rate = new HttpErrors.HttpError({ kind: "rate-limited", message: "429", retryAfterMs: 1000 })
    expect(rate.isRateLimited()).toBe(true)
    expect(rate.isRetryable()).toBe(true)

    const net = new HttpErrors.HttpError({ kind: "network", message: "ENETUNREACH" })
    expect(net.isNetworkError()).toBe(true)
    expect(net.isRetryable()).toBe(true)

    const server = new HttpErrors.HttpError({ kind: "server", message: "502", status: 502 })
    expect(server.isNetworkError()).toBe(true)
    expect(server.isRetryable()).toBe(true)

    const client = new HttpErrors.HttpError({ kind: "client", message: "400", status: 400 })
    expect(client.isNetworkError()).toBe(false)
    expect(client.isRetryable()).toBe(false)
  })
})

describe("HttpErrors.fromResponse", () => {
  test("captures status, retry-after, and snippet", () => {
    const res = new Response("payload", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "12" },
    })
    const err = HttpErrors.fromResponse(res, "payload")
    expect(err.kind).toBe("rate-limited")
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBe(12_000)
    expect(err.bodySnippet).toBe("payload")
    expect(err.headers?.["retry-after"]).toBe("12")
  })
})

describe("HttpErrors.fromTransport", () => {
  test("flags timeout kind when requested", () => {
    const err = HttpErrors.fromTransport(new Error("boom"), { timeout: true })
    expect(err.kind).toBe("timeout")
    expect(err.isNetworkError()).toBe(true)
  })
  test("plain transport error", () => {
    const err = HttpErrors.fromTransport(new Error("ENETUNREACH"))
    expect(err.kind).toBe("transport")
    expect(err.message).toBe("ENETUNREACH")
  })
})
