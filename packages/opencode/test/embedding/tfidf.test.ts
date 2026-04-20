import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DEFAULT_TFIDF_VOCAB_SIZE, LocalTfIdfCorpus, tfidfEmbed } from "../../src/embedding/tfidf"
import { cosineSimilarity, EmbeddingService, localTfIdfLayer } from "../../src/embedding"
import { autoEmbeddingLayer, resolveEmbeddingProvider } from "../../src/embedding"
import { defaultLayer as MemoryDefaultLayer, Memory } from "../../src/memory"

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

describe("LocalTfIdfCorpus", () => {
  test("upsert + query returns cosine-sorted hits", () => {
    const corpus = new LocalTfIdfCorpus({ vocabSize: 128 })
    corpus.upsert("git-commit", "Create a git commit with a descriptive message")
    corpus.upsert("docker-build", "Build a Docker container image")
    corpus.upsert("git-push", "Push git commits to a remote repository")
    expect(corpus.size()).toBe(3)

    const hits = corpus.query("git commit message", 3)
    expect(hits.length).toBe(3)
    expect(hits[0]!.id).toBe("git-commit")
    // Ordering stable: scores descending, then by id.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
    }
  })

  test("upsert overwrites the stored vector", () => {
    const corpus = new LocalTfIdfCorpus({ vocabSize: 128 })
    corpus.upsert("x", "original description about cats")
    corpus.upsert("x", "completely new description about rockets and space")
    const hits = corpus.query("rockets space launch", 5)
    expect(hits.some((h) => h.id === "x" && h.score > 0)).toBe(true)
    expect(corpus.getText("x")).toContain("rockets")
  })

  test("remove drops the document", () => {
    const corpus = new LocalTfIdfCorpus({ vocabSize: 64 })
    corpus.upsert("ephemeral", "temporary skill")
    expect(corpus.remove("ephemeral")).toBe(true)
    expect(corpus.remove("ephemeral")).toBe(false)
    expect(corpus.query("temporary", 5)).toEqual([])
  })

  test("query on empty corpus returns empty list", () => {
    const corpus = new LocalTfIdfCorpus({ vocabSize: 64 })
    expect(corpus.query("anything", 5)).toEqual([])
  })

  test("query with zero-vector input returns empty list", () => {
    const corpus = new LocalTfIdfCorpus({ vocabSize: 64 })
    corpus.upsert("a", "hello world")
    // Query made of non-alphanumeric characters tokenises to zero tokens.
    expect(corpus.query("!!!---   ", 5)).toEqual([])
  })

  test("persist to JSON and reload yields identical query results", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tfidf-corpus-"))
    const file = path.join(dir, "corpus.json")
    try {
      const corpus = new LocalTfIdfCorpus({ vocabSize: 128 })
      corpus.upsert("persistent", "this skill persists across reloads")
      corpus.upsert("volatile", "this skill is unrelated to the other one")
      await corpus.save(file)

      const reloaded = await LocalTfIdfCorpus.load(file)
      expect(reloaded).not.toBeNull()
      expect(reloaded!.size()).toBe(2)
      expect(reloaded!.ids().sort()).toEqual(["persistent", "volatile"])

      const beforeHits = corpus.query("persists reloads", 5)
      const afterHits = reloaded!.query("persists reloads", 5)
      expect(afterHits.map((h) => h.id)).toEqual(beforeHits.map((h) => h.id))
      for (let i = 0; i < beforeHits.length; i++) {
        expect(afterHits[i]!.score).toBeCloseTo(beforeHits[i]!.score, 5)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("load on missing file returns null (cold-start sentinel)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tfidf-corpus-"))
    try {
      const result = await LocalTfIdfCorpus.load(path.join(dir, "does-not-exist.json"))
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("vocabSize mismatch on load throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tfidf-corpus-"))
    const file = path.join(dir, "corpus.json")
    try {
      const corpus = new LocalTfIdfCorpus({ vocabSize: 128 })
      corpus.upsert("x", "hello")
      await corpus.save(file)
      await expect(LocalTfIdfCorpus.load(file, { vocabSize: 64 })).rejects.toThrow(/vocabSize mismatch/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("saveEffect + loadEffect round-trip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tfidf-corpus-"))
    const file = path.join(dir, "corpus.json")
    try {
      const corpus = new LocalTfIdfCorpus({ vocabSize: 64 })
      corpus.upsert("a", "effect-driven serialisation path")
      await Effect.runPromise(corpus.saveEffect(file))
      const maybe = await Effect.runPromise(LocalTfIdfCorpus.loadEffect(file))
      expect(maybe).not.toBeNull()
      expect(maybe!.size()).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("embedding provider resolver", () => {
  const ORIGINAL = process.env["OPENCODE_EMBEDDING_PROVIDER"]
  function setProvider(v: string | undefined) {
    if (v === undefined) delete process.env["OPENCODE_EMBEDDING_PROVIDER"]
    else process.env["OPENCODE_EMBEDDING_PROVIDER"] = v
  }

  test("defaults to auto", () => {
    setProvider(undefined)
    expect(resolveEmbeddingProvider()).toBe("auto")
    setProvider(ORIGINAL)
  })

  test("honours `local` / `tfidf` values", () => {
    setProvider("local")
    expect(resolveEmbeddingProvider()).toBe("local")
    setProvider("TFIDF")
    expect(resolveEmbeddingProvider()).toBe("local")
    setProvider(ORIGINAL)
  })

  test("honours `api` / `openai` values", () => {
    setProvider("api")
    expect(resolveEmbeddingProvider()).toBe("api")
    setProvider("OpenAI")
    expect(resolveEmbeddingProvider()).toBe("api")
    setProvider(ORIGINAL)
  })

  test("autoEmbeddingLayer with provider=local returns tfidf", async () => {
    setProvider("local")
    try {
      const layer = autoEmbeddingLayer()
      const name = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* EmbeddingService
            return svc.providerName
          }),
          layer,
        ),
      )
      expect(name).toBe("tfidf")
    } finally {
      setProvider(ORIGINAL)
    }
  })

  test("autoEmbeddingLayer with no apiConfig falls back to tfidf under `auto`", async () => {
    setProvider(undefined)
    const layer = autoEmbeddingLayer()
    const name = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* EmbeddingService
          return svc.providerName
        }),
        layer,
      ),
    )
    expect(name).toBe("tfidf")
    setProvider(ORIGINAL)
  })

  test("autoEmbeddingLayer with apiConfig uses api under `auto`", async () => {
    setProvider(undefined)
    const fakeFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0, 0.5, 0.5] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const layer = autoEmbeddingLayer({
      apiConfig: {
        apiBaseURL: "https://example.test/v1",
        apiKey: "k",
        model: "m",
        fetch: fakeFetch,
      },
    })
    const name = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* EmbeddingService
          return svc.providerName
        }),
        layer,
      ),
    )
    expect(name).toBe("api")
    setProvider(ORIGINAL)
  })

  test("autoEmbeddingLayer with provider=api and no config throws", () => {
    setProvider("api")
    try {
      expect(() => autoEmbeddingLayer()).toThrow(/requires an apiConfig/)
    } finally {
      setProvider(ORIGINAL)
    }
  })

  test("MemoryDefaultLayer uses the provider-aware embedding layer", async () => {
    setProvider("local")
    try {
      const name = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Memory
          const svc = yield* Effect.service(EmbeddingService)
          return svc.providerName
        }).pipe(Effect.provide(MemoryDefaultLayer)),
      )
      expect(name).toBe("tfidf")
    } finally {
      setProvider(ORIGINAL)
    }
  })
})
