import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  BLACKBIRD_API_VERSION,
  BLACKBIRD_BASE_URL,
  BlackBird,
  BlackBirdError,
  chunks,
  chunksForFile,
  codeSearch,
  embed,
  formatSearchResults,
  isRepoIndexed,
  normalizeEmbedding,
} from "@/plugin/github-copilot/blackbird"
import {
  ChunksResponseSchema,
  CodeSearchResponseSchema,
  EmbeddingsResponseSchema,
} from "@/plugin/github-copilot/blackbird-schema"
import { AccountPool } from "@/plugin/github-copilot/account-pool"
import { empty, isDeactivated, upsert } from "@/plugin/github-copilot/connections"
import type { State } from "@/plugin/github-copilot/connections"
import { Effect } from "effect"

const orig = globalThis.fetch
afterEach(() => {
  globalThis.fetch = orig
  delete process.env.OPENCODE_COPILOT_PROXY_ENVELOPE
})

function stateWithProxy(key: string, proxyUrl?: string, proxyToken?: string): State {
  return upsert(empty(), key, { proxyUrl, proxyToken })
}

describe("blackbird-schema", () => {
  test("ChunksResponseSchema parses chunks with optional line_range", () => {
    const parsed = ChunksResponseSchema.parse({
      chunks: [{ text: "fn main() {}", path: "main.rs", line_range: { start: 1, end: 3 } }],
    })
    expect(parsed.chunks).toHaveLength(1)
    expect(parsed.chunks[0]!.line_range?.start).toBe(1)
  })

  test("EmbeddingsResponseSchema parses embedding arrays", () => {
    const parsed = EmbeddingsResponseSchema.parse({
      embeddings: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [-1, 1] }],
    })
    expect(parsed.embeddings).toHaveLength(2)
    expect(parsed.embeddings[1]!.embedding).toHaveLength(2)
  })

  test("CodeSearchResponseSchema parses results with embedding_model", () => {
    const parsed = CodeSearchResponseSchema.parse({
      results: [
        {
          location: { path: "src/lib.rs" },
          chunk: { text: "pub fn search()", line_range: { start: 10, end: 20 } },
        },
      ],
      embedding_model: "metis-1024-I16-Binary",
    })
    expect(parsed.results).toHaveLength(1)
    expect(parsed.embedding_model).toBe("metis-1024-I16-Binary")
  })
})

describe("blackbird helpers", () => {
  test("normalizeEmbedding produces a unit vector", () => {
    const v = [3, 4]
    normalizeEmbedding(v)
    expect(v[0]).toBeCloseTo(0.6, 6)
    expect(v[1]).toBeCloseTo(0.8, 6)
  })

  test("normalizeEmbedding leaves a zero vector alone", () => {
    const v = [0, 0, 0]
    normalizeEmbedding(v)
    expect(v).toEqual([0, 0, 0])
  })

  test("formatSearchResults renders path:range\\nbody", () => {
    const formatted = formatSearchResults([
      {
        location: { path: "src/main.rs" },
        chunk: { text: "fn main() {}", line_range: { start: 1, end: 3 } },
      },
      { location: { path: "lib.rs" }, chunk: { text: "pub mod foo;" } },
    ])
    expect(formatted).toContain("src/main.rs:1-3\nfn main() {}")
    expect(formatted).toContain("lib.rs\npub mod foo;")
  })

  test("constants match the Rust reference", () => {
    expect(BLACKBIRD_BASE_URL).toBe("https://api.github.com")
    expect(BLACKBIRD_API_VERSION).toBe("2025-05-01")
    expect(BlackBird.BASE_URL).toBe("https://api.github.com")
    expect(BlackBird.API_VERSION).toBe("2025-05-01")
  })
})

describe("blackbird client — happy path", () => {
  test("chunks posts to /chunks with BlackBird headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock((url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            chunks: [{ text: "chunk body", path: "foo.ts", line_range: { start: 1, end: 5 } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch

    const result = await chunks(
      { token: "ghotok" },
      { documents: [{ path: "foo.ts", content: "console.log(1)" }] },
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe("chunk body")
    expect(calls[0]!.url).toBe("https://api.github.com/chunks")
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer ghotok")
    expect(headers["X-GitHub-Api-Version"]).toBe("2025-05-01")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers["X-GitHub-Request-ID"]).toBeTruthy()
  })

  test("chunksForFile wraps single document", async () => {
    const calls: Array<{ body: string }> = []
    globalThis.fetch = mock((_url: unknown, init: unknown) => {
      calls.push({ body: String((init as RequestInit).body) })
      return Promise.resolve(new Response(JSON.stringify({ chunks: [] }), { status: 200 }))
    }) as unknown as typeof fetch
    await chunksForFile("a.ts", "hello", { token: "t" })
    const body = JSON.parse(calls[0]!.body)
    expect(body).toEqual({ documents: [{ path: "a.ts", content: "hello" }] })
  })

  test("embed batches inputs in groups of 64 and flattens results", async () => {
    const seen: Array<{ count: number }> = []
    globalThis.fetch = mock((_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body))
      seen.push({ count: body.inputs.length })
      const embeddings = body.inputs.map((_: string, idx: number) => ({
        embedding: [idx, idx + 1],
      }))
      return Promise.resolve(new Response(JSON.stringify({ embeddings }), { status: 200 }))
    }) as unknown as typeof fetch
    const inputs = Array.from({ length: 130 }, (_, i) => `s${i}`)
    const out = await embed({ token: "t" }, inputs)
    // 130 inputs → batches of 64, 64, 2.
    expect(seen.map((s) => s.count)).toEqual([64, 64, 2])
    expect(out).toHaveLength(130)
  })

  test("embed sends model name (default metis-1024-I16-Binary)", async () => {
    const bodies: string[] = []
    globalThis.fetch = mock((_url: unknown, init: unknown) => {
      bodies.push(String((init as RequestInit).body))
      return Promise.resolve(
        new Response(JSON.stringify({ embeddings: [{ embedding: [1] }] }), { status: 200 }),
      )
    }) as unknown as typeof fetch
    await embed({ token: "t" }, ["hello"])
    expect(JSON.parse(bodies[0]!)).toEqual({ inputs: ["hello"], model: "metis-1024-I16-Binary" })
  })

  test("codeSearch builds scoping_query, sets include_embeddings and limit, plus search headers", async () => {
    const captured: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
    globalThis.fetch = mock((url: unknown, init: unknown) => {
      const req = init as RequestInit
      captured.push({
        url: String(url),
        body: JSON.parse(String(req.body)),
        headers: req.headers as Record<string, string>,
      })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                location: { path: "src/lib.rs" },
                chunk: { text: "pub fn foo()", line_range: { start: 5, end: 10 } },
              },
            ],
            embedding_model: "metis-1024-I16-Binary",
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const results = await codeSearch(
      { token: "t" },
      { owner: "foo", repo: "bar", query: "matrix multiply", maxResults: 5 },
    )
    expect(results).toHaveLength(1)
    expect(captured[0]!.url).toBe("https://api.github.com/embeddings/code/search")
    expect(captured[0]!.body).toEqual({
      prompt: "matrix multiply",
      scoping_query: "repo:foo/bar",
      include_embeddings: false,
      limit: 5,
    })
    expect(captured[0]!.headers["X-Client-Application"]).toBe("sweagentd")
    expect(captured[0]!.headers["X-Client-Features"]).toBe("blackbird_tool")
  })

  test("isRepoIndexed returns the flag on 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ semantic_code_search_ok: true }), { status: 200 }),
      ),
    ) as unknown as typeof fetch
    expect(await isRepoIndexed({ token: "t" }, "foo", "bar")).toBe(true)
  })

  test("isRepoIndexed returns false on 404", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("not found", { status: 404 })),
    ) as unknown as typeof fetch
    expect(await isRepoIndexed({ token: "t" }, "foo", "bar")).toBe(false)
  })
})

describe("blackbird client — triage", () => {
  async function captureError(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise
      return undefined
    } catch (err) {
      return err
    }
  }

  test("401 throws BlackBirdError{authError} and marks account deactivated", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("bad token", { status: 401 })),
    ) as unknown as typeof fetch
    const state = stateWithProxy("github-copilot#edu")
    let written: State | undefined
    const err = await captureError(
      chunks(
        {
          token: "t",
          state,
          key: "github-copilot#edu",
          writeState: (s) => {
            written = s
          },
        },
        { documents: [{ path: "f.ts", content: "x" }] },
      ),
    )
    expect(err).toBeInstanceOf(BlackBirdError)
    expect((err as BlackBirdError).authError).toBe(true)
    expect((err as BlackBirdError).status).toBe(401)
    expect(written).toBeDefined()
    expect(isDeactivated(written!, "github-copilot#edu")).toBe(true)
  })

  test("403 is also treated as an auth error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    ) as unknown as typeof fetch
    const err = await captureError(embed({ token: "t" }, ["x"]))
    expect(err).toBeInstanceOf(BlackBirdError)
    expect((err as BlackBirdError).authError).toBe(true)
    expect((err as BlackBirdError).status).toBe(403)
  })

  test("429 routes through AccountPool.recordExhaustion", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("rate limited", { status: 429, headers: { "retry-after": "42" } }),
      ),
    ) as unknown as typeof fetch
    const pool = new AccountPool({
      accounts: [{ key: "github-copilot", label: "primary", primary: true }],
    })
    const state = stateWithProxy("github-copilot")
    const err = await captureError(
      chunks(
        { token: "t", state, key: "github-copilot", pool },
        { documents: [{ path: "f.ts", content: "x" }] },
      ),
    )
    expect(err).toBeInstanceOf(BlackBirdError)
    expect((err as BlackBirdError).rateLimited).toBe(true)
    expect((err as BlackBirdError).retryAfterSec).toBe(42)
    // After recordExhaustion the pool should have an exhaustedUntil stamped
    // for this key.
    expect(pool.runtime.rate["github-copilot"]?.exhaustedUntil).toBeGreaterThan(Date.now())
  })

  test("5xx surfaces BlackBirdError{networkError}", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("boom", { status: 502 })),
    ) as unknown as typeof fetch
    const err = await captureError(embed({ token: "t" }, ["x"]))
    expect(err).toBeInstanceOf(BlackBirdError)
    expect((err as BlackBirdError).networkError).toBe(true)
    expect((err as BlackBirdError).status).toBe(502)
  })

  test("fetch rejection surfaces BlackBirdError{status:0,networkError}", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch
    const err = await captureError(embed({ token: "t" }, ["x"]))
    expect(err).toBeInstanceOf(BlackBirdError)
    expect((err as BlackBirdError).status).toBe(0)
    expect((err as BlackBirdError).networkError).toBe(true)
  })
})

describe("blackbird client — proxy integration", () => {
  test("per-account proxy URL rewrites the request URL", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = mock((url: unknown, init: unknown) => {
      calls.push({ url: String(url), headers: (init as RequestInit).headers as Record<string, string> })
      return Promise.resolve(new Response(JSON.stringify({ chunks: [] }), { status: 200 }))
    }) as unknown as typeof fetch
    const state = stateWithProxy("github-copilot", "https://proxy.example", "ptok")
    await chunks(
      { token: "t", state, key: "github-copilot" },
      { documents: [{ path: "f.ts", content: "x" }] },
    )
    expect(calls[0]!.url.startsWith("https://proxy.example")).toBe(true)
    expect(calls[0]!.headers["x-copilot-proxy-token"]).toBe("ptok")
  })

  test("envelope proxy wraps the request as POST /fetch", async () => {
    process.env.OPENCODE_COPILOT_PROXY_ENVELOPE = "1"
    const envelopes: Array<{ url: string; envelope: any }> = []
    globalThis.fetch = mock((url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body))
      envelopes.push({ url: String(url), envelope: body })
      // Return the proxy-envelope format: { status_code, headers, body }.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status_code: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              results: [
                { location: { path: "lib.rs" }, chunk: { text: "pub fn foo()" } },
              ],
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch
    const state = stateWithProxy("github-copilot", "https://proxy.example", "ptok")
    const results = await codeSearch(
      { token: "t", state, key: "github-copilot" },
      { owner: "o", repo: "r", query: "foo" },
    )
    expect(results).toHaveLength(1)
    expect(envelopes[0]!.url).toBe("https://proxy.example/fetch")
    // Inner envelope targets the real BlackBird endpoint with JSON body.
    expect(envelopes[0]!.envelope.url).toBe("https://api.github.com/embeddings/code/search")
    expect(envelopes[0]!.envelope.method).toBe("POST")
    expect(envelopes[0]!.envelope.headers["X-GitHub-Api-Version"]).toBe("2025-05-01")
  })
})

describe("BlackBird.* Effect wrappers", () => {
  test("BlackBird.embed returns an Effect<Embedding[]>", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ embeddings: [{ embedding: [0.5, 0.5] }] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    const out = await Effect.runPromise(BlackBird.embed({ token: "t" }, ["hi"]))
    expect(out).toHaveLength(1)
    expect(out[0]!.embedding).toEqual([0.5, 0.5])
  })

  test("BlackBird.chunks yields parsed chunks", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ chunks: [{ text: "body", path: "f.ts" }] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    const out = await Effect.runPromise(BlackBird.chunks("f.ts", "hello", { token: "t" }))
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe("body")
  })

  test("BlackBird.codeSearch propagates BlackBirdError on auth failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 401 })),
    ) as unknown as typeof fetch
    let thrown: unknown
    try {
      await Effect.runPromise(
        BlackBird.codeSearch({ token: "t" }, { owner: "o", repo: "r", query: "q" }),
      )
    } catch (err) {
      thrown = err
    }
    // Effect wraps thrown errors; unwrap the cause chain until we reach
    // the BlackBirdError.
    let root: unknown = thrown
    while (root && typeof root === "object" && !(root instanceof BlackBirdError) && "cause" in (root as any)) {
      root = (root as any).cause
    }
    expect(root).toBeInstanceOf(BlackBirdError)
    expect((root as BlackBirdError).authError).toBe(true)
  })

  test("BlackBird.repoIndexed returns a boolean Effect", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ semantic_code_search_ok: true }), { status: 200 }),
      ),
    ) as unknown as typeof fetch
    const indexed = await Effect.runPromise(BlackBird.repoIndexed({ token: "t" }, "o", "r"))
    expect(indexed).toBe(true)
  })
})
