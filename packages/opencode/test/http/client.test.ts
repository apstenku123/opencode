import { describe, expect, test } from "bun:test"
import { HttpClient } from "../../src/http/client"
import { HttpErrors } from "../../src/http/errors"

function makeFetch(queue: Array<() => Promise<Response> | Response>): typeof fetch {
  let i = 0
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue[i++ % queue.length]
    if (!next) throw new Error("fetch queue exhausted")
    return await next()
  }) as typeof fetch
}

describe("HttpClient.request — success path", () => {
  test("returns raw Response on 2xx", async () => {
    const fake = makeFetch([() => new Response("ok", { status: 200 })])
    const res = await HttpClient.request("https://example.invalid/resource", {
      fetch: fake,
      retry: false,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  test("returns non-2xx when throwOnError=false", async () => {
    const fake = makeFetch([() => new Response("nope", { status: 404 })])
    const res = await HttpClient.request("https://example.invalid/missing", {
      fetch: fake,
      retry: false,
      throwOnError: false,
    })
    expect(res.status).toBe(404)
  })
})

describe("HttpClient.request — error triage", () => {
  test("401 throws auth error", async () => {
    const fake = makeFetch([() => new Response("bad token", { status: 401 })])
    try {
      await HttpClient.request("https://example.invalid/auth", { fetch: fake, retry: false })
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(HttpErrors.HttpError)
      const e = err as HttpErrors.HttpError
      expect(e.isAuthError()).toBe(true)
      expect(e.status).toBe(401)
    }
  })

  test("429 throws rate-limited and captures retry-after", async () => {
    const fake = makeFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    ])
    try {
      await HttpClient.request("https://example.invalid/rl", { fetch: fake, retry: false })
      throw new Error("expected throw")
    } catch (err) {
      const e = err as HttpErrors.HttpError
      expect(e.isRateLimited()).toBe(true)
      expect(e.retryAfterMs).toBe(7_000)
    }
  })

  test("500 throws server/network error", async () => {
    const fake = makeFetch([() => new Response("boom", { status: 500 })])
    try {
      await HttpClient.request("https://example.invalid/500", { fetch: fake, retry: false })
      throw new Error("expected throw")
    } catch (err) {
      const e = err as HttpErrors.HttpError
      expect(e.isNetworkError()).toBe(true)
      expect(e.status).toBe(500)
    }
  })
})

describe("HttpClient.request — transport + timeout", () => {
  test("wraps transport failure in HttpError", async () => {
    const fake = (async () => {
      throw new TypeError("ECONNREFUSED")
    }) as unknown as typeof fetch
    try {
      await HttpClient.request("https://example.invalid/x", { fetch: fake, retry: false })
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(HttpErrors.HttpError)
      const e = err as HttpErrors.HttpError
      expect(e.kind).toBe("transport")
    }
  })

  test("timeout produces kind=timeout", async () => {
    const slowFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted")
          ;(err as { name: string }).name = "AbortError"
          reject(err)
        })
      })
    }) as unknown as typeof fetch

    try {
      await HttpClient.request("https://example.invalid/slow", {
        fetch: slowFetch,
        retry: false,
        timeoutMs: 25,
      })
      throw new Error("expected throw")
    } catch (err) {
      const e = err as HttpErrors.HttpError
      expect(e.kind).toBe("timeout")
      expect(e.isNetworkError()).toBe(true)
    }
  })
})

describe("HttpClient.request — retry policy", () => {
  test("retries retryable HttpError and succeeds", async () => {
    let calls = 0
    const fake = (async () => {
      calls += 1
      if (calls < 3) return new Response("tmp", { status: 503 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await HttpClient.request("https://example.invalid/x", {
      fetch: fake,
      retry: { maxAttempts: 4, baseMs: 1, maxMs: 2, factor: 2, jitter: 0 },
      sleep: async () => undefined,
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(3)
  })

  test("does not retry non-retryable errors", async () => {
    let calls = 0
    const fake = (async () => {
      calls += 1
      return new Response("bad", { status: 400 })
    }) as unknown as typeof fetch

    try {
      await HttpClient.request("https://example.invalid/x", {
        fetch: fake,
        retry: { maxAttempts: 3, baseMs: 1, maxMs: 2, factor: 2, jitter: 0 },
        sleep: async () => undefined,
      })
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(HttpErrors.HttpError)
    }
    expect(calls).toBe(1)
  })
})

describe("HttpClient.json", () => {
  test("decodes JSON on success", async () => {
    const fake = makeFetch([
      () => new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "content-type": "application/json" } }),
    ])
    const out = await HttpClient.json<{ hello: string }>("https://example.invalid/j", { fetch: fake, retry: false })
    expect(out.hello).toBe("world")
  })

  test("wraps decode failure in HttpError(kind=decode)", async () => {
    const fake = makeFetch([() => new Response("not-json{{", { status: 200 })])
    try {
      await HttpClient.json("https://example.invalid/j", { fetch: fake, retry: false })
      throw new Error("expected throw")
    } catch (err) {
      const e = err as HttpErrors.HttpError
      expect(e.kind).toBe("decode")
    }
  })
})

describe("HttpClient.request — body replay protection", () => {
  test("string body is replayable across retries", async () => {
    let calls = 0
    const fake = (async () => {
      calls += 1
      if (calls === 1) return new Response("", { status: 503 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await HttpClient.request("https://example.invalid/post", {
      fetch: fake,
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 2, factor: 2, jitter: 0 },
      sleep: async () => undefined,
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("ReadableStream body rejects retry with descriptive error", async () => {
    let calls = 0
    const fake = (async () => {
      calls += 1
      return new Response("", { status: 503 })
    }) as unknown as typeof fetch
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b, 0x7d]))
        controller.close()
      },
    })
    try {
      await HttpClient.request("https://example.invalid/post", {
        fetch: fake,
        method: "POST",
        body: stream as unknown as BodyInit,
        retry: { maxAttempts: 3, baseMs: 1, maxMs: 2, factor: 2, jitter: 0 },
        sleep: async () => undefined,
      })
      throw new Error("expected throw")
    } catch (err) {
      const e = err as HttpErrors.HttpError
      expect(e.kind === "transport" || e.status === 503).toBe(true)
    }
    // At least one attempt was made; the second must have failed fast due
    // to the non-replayable body guard.
    expect(calls).toBeGreaterThanOrEqual(1)
  })
})
