import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DEFAULT_TFIDF_VOCAB_SIZE, tfidfEmbed } from "../../src/embedding/tfidf"
import { cosineSimilarity, EmbeddingService, localTfIdfLayer } from "../../src/embedding"

describe("local TF-IDF embedding", () => {
  test("non-empty input produces a unit-norm vector of `vocabSize` dims", () => {
    const v = tfidfEmbed("hello world", DEFAULT_TFIDF_VOCAB_SIZE)
    expect(v.length).toBe(DEFAULT_TFIDF_VOCAB_SIZE)
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!
    norm = Math.sqrt(norm)
    expect(norm).toBeCloseTo(1, 6)
    expect(v.some((x) => x !== 0)).toBe(true)
  })

  test("empty input → zero vector", () => {
    const v = tfidfEmbed("", 64)
    expect(v.length).toBe(64)
    expect(v.every((x) => x === 0)).toBe(true)
  })

  test("identical text → identical vector (deterministic)", () => {
    const a = tfidfEmbed("rust programming language")
    const b = tfidfEmbed("rust programming language")
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  test("different texts → different vectors and similarity < 1", () => {
    const a = tfidfEmbed("rust programming language", 384)
    const b = tfidfEmbed("french cooking recipes", 384)
    const same = a.every((v, i) => Math.abs(v - b[i]!) < 1e-9)
    expect(same).toBe(false)
    expect(cosineSimilarity(a, b)).toBeLessThan(0.99)
  })

  test("vocabSize=0 falls back to default 384", () => {
    const v = tfidfEmbed("anything", 0)
    expect(v.length).toBe(DEFAULT_TFIDF_VOCAB_SIZE)
  })

  test("repeated tokens stay unit-norm after log-TF + L2 normalize", () => {
    const once = tfidfEmbed("rust", 256)
    const many = tfidfEmbed("rust rust rust rust", 256)
    const normOnce = Math.sqrt(Array.from(once).reduce((s, x) => s + x * x, 0))
    const normMany = Math.sqrt(Array.from(many).reduce((s, x) => s + x * x, 0))
    expect(normOnce).toBeCloseTo(1, 5)
    expect(normMany).toBeCloseTo(1, 5)
  })

  test("layer exposes the EmbeddingService contract", async () => {
    const layer = localTfIdfLayer({ vocabSize: 64 })
    const program = Effect.gen(function* () {
      const svc = yield* EmbeddingService
      const single = yield* svc.embed("hello world")
      const batch = yield* svc.embedBatch(["foo", "bar"])
      return { single, batch, name: svc.providerName }
    })
    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.single.length).toBe(64)
    expect(result.batch.length).toBe(2)
    expect(result.batch[0]!.length).toBe(64)
    expect(result.name).toBe("tfidf")
  })
})
