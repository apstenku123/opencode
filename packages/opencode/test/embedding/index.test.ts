import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cosineSimilarity, EmbeddingService, hashEmbedding, mockLayer } from "../../src/embedding"
import { openAICompatLayer } from "../../src/embedding/openai"

describe("shared EmbeddingService", () => {
  describe("cosineSimilarity", () => {
    test("identical vectors → 1", () => {
      const v = new Float32Array(8).map((_, i) => (i + 1) * 0.1)
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6)
    })

    test("orthogonal vectors → 0", () => {
      const a = new Float32Array([1, 0, 0, 0])
      const b = new Float32Array([0, 1, 0, 0])
      expect(cosineSimilarity(a, b)).toBe(0)
    })

    test("opposite vectors → -1", () => {
      const a = new Float32Array([1, 1, 1, 1])
      const b = new Float32Array([-1, -1, -1, -1])
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6)
    })

    test("zero vector → 0", () => {
      expect(cosineSimilarity([1, 1, 1], [0, 0, 0])).toBe(0)
    })

    test("length mismatch → 0", () => {
      expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    })
  })

  describe("hashEmbedding", () => {
    test("deterministic + L2-normalised", () => {
      const a = hashEmbedding("hello", 16)
      const b = hashEmbedding("hello", 16)
      expect(Array.from(a)).toEqual(Array.from(b))
      let n = 0
      for (let i = 0; i < a.length; i++) n += a[i]! * a[i]!
      expect(Math.sqrt(n)).toBeCloseTo(1, 6)
    })

    test("different texts produce different vectors", () => {
      const a = hashEmbedding("foo", 32)
      const b = hashEmbedding("bar", 32)
      const same = a.every((v, i) => Math.abs(v - b[i]!) < 1e-12)
      expect(same).toBe(false)
    })
  })

  describe("mockLayer", () => {
    test("provides EmbeddingService with deterministic vectors", async () => {
      const program = Effect.gen(function* () {
        const svc = yield* EmbeddingService
        return {
          a: yield* svc.embed("hello"),
          batch: yield* svc.embedBatch(["x", "y", "z"]),
          name: svc.providerName,
        }
      })
      const result = await Effect.runPromise(Effect.provide(program, mockLayer({ dimension: 16 })))
      expect(result.a.length).toBe(16)
      expect(result.batch.length).toBe(3)
      expect(result.name).toBe("mock")
    })

    test("custom embed override is honored", async () => {
      const layer = mockLayer({
        dimension: 4,
        embed: () => new Float32Array([0.5, 0.5, 0.5, 0.5]),
      })
      const v = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* EmbeddingService
            return yield* svc.embed("ignored")
          }),
          layer,
        ),
      )
      expect(Array.from(v)).toEqual([0.5, 0.5, 0.5, 0.5])
    })
  })

  describe("openAICompatLayer", () => {
    test("posts to /embeddings with the configured model and parses the response", async () => {
      let observedURL: string | undefined
      let observedBody: unknown
      const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        observedURL = typeof input === "string" ? input : (input as URL).toString()
        observedBody = init?.body ? JSON.parse(String(init.body)) : undefined
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as typeof fetch

      const layer = openAICompatLayer({
        apiBaseURL: "https://example.test/v1",
        apiKey: "k",
        model: "test-model",
        fetch: fakeFetch,
      })
      const v = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* EmbeddingService
            return yield* svc.embed("hello world")
          }),
          layer,
        ),
      )
      // Float32 round-trip — compare with tolerance.
      expect(v.length).toBe(3)
      expect(v[0]).toBeCloseTo(0.1, 5)
      expect(v[1]).toBeCloseTo(0.2, 5)
      expect(v[2]).toBeCloseTo(0.3, 5)
      expect(observedURL).toBe("https://example.test/v1/embeddings")
      expect((observedBody as any).model).toBe("test-model")
      expect((observedBody as any).input).toBe("hello world")
    })

    test("non-2xx response surfaces an EmbeddingError", async () => {
      const fakeFetch = (async () =>
        new Response("nope", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch
      const layer = openAICompatLayer({
        apiBaseURL: "https://example.test/v1",
        apiKey: "k",
        model: "m",
        fetch: fakeFetch,
      })
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* EmbeddingService
            return yield* svc.embed("x")
          }),
          layer,
        ),
      )
      expect(exit._tag).toBe("Failure")
    })
  })
})
