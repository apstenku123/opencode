import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  cosineSimilarity,
  layer as memoryFacadeLayer,
  Memory,
  memoryRetrievalLayer,
  memoryStorageLayer,
  MemoryRetrieval,
  MemoryStorage,
  mockEmbeddingLayer,
  rankByCosine,
  type DefectSextuple,
} from "../../src/memory"
import { hashEmbedding } from "../../src/memory/embedding"
import { Database } from "../../src/storage"
import { testEffect } from "../lib/effect"
import type { DefectSextupleInput } from "../../src/memory/schema"

beforeEach(() => {
  const db = Database.Client()
  db.run(/*sql*/ `DELETE FROM memory_sextuple`)
})

const retrievalLayer = Layer.provideMerge(memoryRetrievalLayer, memoryStorageLayer)

const it = testEffect(retrievalLayer)

// --------------------------------------------------------------------------
// Pure-kernel tests (no DB)
// --------------------------------------------------------------------------

describe("memory/retrieval — pure kernels", () => {
  test("cosineSimilarity of identical unit vectors is 1", () => {
    const v = Float32Array.of(1, 0, 0)
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6)
  })

  test("cosineSimilarity of orthogonal vectors is 0", () => {
    expect(cosineSimilarity(Float32Array.of(1, 0), Float32Array.of(0, 1))).toBeCloseTo(0, 6)
  })

  test("cosineSimilarity of opposite unit vectors is -1", () => {
    expect(cosineSimilarity(Float32Array.of(1, 0), Float32Array.of(-1, 0))).toBeCloseTo(-1, 6)
  })

  test("cosineSimilarity returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity(Float32Array.of(1, 0), Float32Array.of(1, 0, 0))).toBe(0)
  })

  test("cosineSimilarity returns 0 for zero-length or zero-norm vectors", () => {
    expect(cosineSimilarity(new Float32Array(), new Float32Array())).toBe(0)
    expect(cosineSimilarity(Float32Array.of(0, 0), Float32Array.of(1, 1))).toBe(0)
  })

  test("cosineSimilarity is scale-invariant", () => {
    const a = Float32Array.of(1, 2, 3)
    const b = Float32Array.of(2, 4, 6)
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
  })

  const fakeRecord = (hashId: string, embedding: Float32Array): DefectSextuple =>
    ({
      id: `mem-${hashId}`,
      hashId,
      keywords: ["k"],
      problem: "p",
      rootCause: "r",
      solution: "s",
      source: { _tag: "rollout", threadID: "t", timestamp: 0 },
      embedding,
      timeCreated: 0,
      timeUpdated: 0,
    }) as DefectSextuple

  test("rankByCosine returns top-K sorted by score desc", () => {
    const query = Float32Array.of(1, 0, 0)
    const records = [
      fakeRecord("a", Float32Array.of(0, 1, 0)), // cosine = 0
      fakeRecord("b", Float32Array.of(1, 0, 0)), // cosine = 1
      fakeRecord("c", Float32Array.of(0.6, 0.8, 0)), // cosine = 0.6
      fakeRecord("d", Float32Array.of(-1, 0, 0)), // cosine = -1
    ]
    const out = rankByCosine(query, records, 3)
    expect(out.map((r) => r.record.hashId)).toEqual(["b", "c", "a"])
    expect(out[0]!.score).toBeCloseTo(1, 6)
    expect(out[2]!.score).toBeCloseTo(0, 6)
  })

  test("rankByCosine skips records without embeddings", () => {
    const query = Float32Array.of(1, 0)
    const records: DefectSextuple[] = [
      fakeRecord("a", Float32Array.of(1, 0)),
      { ...fakeRecord("b", Float32Array.of(1, 0)), embedding: undefined },
    ]
    const out = rankByCosine(query, records, 10)
    expect(out).toHaveLength(1)
    expect(out[0]!.record.hashId).toBe("a")
  })

  test("rankByCosine enforces minScore filter", () => {
    const query = Float32Array.of(1, 0)
    const records = [
      fakeRecord("hi", Float32Array.of(1, 0)), // 1
      fakeRecord("lo", Float32Array.of(0, 1)), // 0
    ]
    const out = rankByCosine(query, records, 10, 0.5)
    expect(out).toHaveLength(1)
    expect(out[0]!.record.hashId).toBe("hi")
  })

  test("rankByCosine is deterministic on score ties (lexicographic hashId)", () => {
    const query = Float32Array.of(1, 0)
    const records = [
      fakeRecord("zzz", Float32Array.of(1, 0)),
      fakeRecord("aaa", Float32Array.of(1, 0)),
      fakeRecord("mmm", Float32Array.of(1, 0)),
    ]
    const out = rankByCosine(query, records, 10)
    expect(out.map((r) => r.record.hashId)).toEqual(["aaa", "mmm", "zzz"])
  })

  test("rankByCosine with topK=0 returns every passing record", () => {
    const query = Float32Array.of(1, 0)
    const records = [fakeRecord("a", Float32Array.of(1, 0)), fakeRecord("b", Float32Array.of(0, 1))]
    expect(rankByCosine(query, records, 0)).toHaveLength(2)
  })
})

// --------------------------------------------------------------------------
// Integrated retrieval (DB + mock embedding)
// --------------------------------------------------------------------------

const sample = (problem: string, keywords: string[], projectID?: string): DefectSextupleInput => ({
  keywords,
  problem,
  // Make rootCause/solution derived from the problem so two distinct sample()
  // calls also hash to distinct hashIds (the hash covers all three fields).
  rootCause: `root cause for: ${problem}`,
  solution: `solution for: ${problem}`,
  source: { _tag: "rollout", threadID: "t1", timestamp: 0 },
  projectID,
})

it.live("retrieve returns top-K scored sextuples from embedded records", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const retrieval = yield* MemoryRetrieval

    const records: DefectSextupleInput[] = [
      sample("deadlock on shutdown", ["deadlock", "mutex"]),
      sample("timeout in network call", ["timeout", "http"]),
      sample("off-by-one in loop", ["loop", "boundary"]),
    ]
    const stored: { hashId: string; keywords: string[] }[] = []
    for (const r of records) {
      const { record } = yield* storage.store(r)
      const vec = hashEmbedding(record.keywords.join(" ") + " [PROBLEM] " + record.problem, 32)
      yield* storage.updateEmbedding(record.hashId, vec)
      stored.push({ hashId: record.hashId, keywords: [...record.keywords] })
    }

    // Querying with the exact embedding key of record[0] should rank it first.
    // Use minScore=-1 so negative-cosine records aren't filtered (mock
    // hash-seeded embeddings land uniformly on the unit sphere, so some
    // pairs will genuinely score below 0).
    const queryVec = hashEmbedding("deadlock mutex [PROBLEM] deadlock on shutdown", 32)
    const results = yield* retrieval.retrieve({ queryEmbedding: queryVec, topK: 3, minScore: -1 })
    expect(results).toHaveLength(3)
    expect(results[0]!.record.hashId).toBe(stored[0]!.hashId)
    expect(results[0]!.score).toBeCloseTo(1, 5)
    // Other records should have strictly lower scores.
    expect(results[1]!.score).toBeLessThan(results[0]!.score)
  }),
)

it.live("retrieve scopes by projectID", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const retrieval = yield* MemoryRetrieval

    const a = yield* storage.store(sample("p-a", ["k"], "proj-A"))
    const b = yield* storage.store(sample("p-b", ["k"], "proj-B"))
    const vec = hashEmbedding("k [PROBLEM] p-a", 32)
    yield* storage.updateEmbedding(a.record.hashId, vec)
    yield* storage.updateEmbedding(b.record.hashId, vec)

    const scoped = yield* retrieval.retrieve({ queryEmbedding: vec, projectID: "proj-A", topK: 5 })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.record.projectID).toBe("proj-A")
  }),
)

it.live("retrieve respects topK and minScore", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const retrieval = yield* MemoryRetrieval
    // Two records with identical embedding → identical (max) score.
    const x = yield* storage.store(sample("x", ["k"]))
    const y = yield* storage.store(sample("y", ["k"]))
    const vec = Float32Array.of(1, 0, 0, 0)
    yield* storage.updateEmbedding(x.record.hashId, vec)
    yield* storage.updateEmbedding(y.record.hashId, vec)

    const top1 = yield* retrieval.retrieve({ queryEmbedding: vec, topK: 1 })
    expect(top1).toHaveLength(1)
    expect(top1[0]!.score).toBeCloseTo(1, 5)

    const floored = yield* retrieval.retrieve({
      queryEmbedding: Float32Array.of(0, 1, 0, 0),
      topK: 5,
      minScore: 0.5,
    })
    expect(floored).toHaveLength(0)
  }),
)

// --------------------------------------------------------------------------
// Facade: Memory.add / Memory.retrieve end-to-end with mock embedder
// --------------------------------------------------------------------------

const facadeDeps = Layer.mergeAll(
  memoryStorageLayer,
  Layer.provide(memoryRetrievalLayer, memoryStorageLayer),
  mockEmbeddingLayer({ dimension: 16 }),
)
const facadeLayer = Layer.provide(memoryFacadeLayer, facadeDeps)

const itFacade = testEffect(facadeLayer)

itFacade.live("Memory.add stores + embeds + retrieves by text end-to-end", () =>
  Effect.gen(function* () {
    const memory = yield* Memory

    const inputs = [
      sample("deadlock on shutdown", ["deadlock", "mutex"]),
      sample("timeout in network call", ["timeout", "http"]),
      sample("off-by-one in loop", ["loop", "boundary"]),
    ]
    const results = []
    for (const i of inputs) results.push(yield* memory.add(i))
    for (const r of results) expect(r.inserted && r.embedded).toBe(true)

    const hits = yield* memory.retrieve({
      queryText: "deadlock mutex [PROBLEM] deadlock on shutdown",
      topK: 3,
      // See note in "retrieve returns top-K scored sextuples" — mock hash
      // embeddings can produce negative cosines; keep those in the top-K.
      minScore: -1,
    })
    expect(hits).toHaveLength(3)
    expect(hits[0]!.record.problem).toBe("deadlock on shutdown")
    expect(hits[0]!.score).toBeCloseTo(1, 5)
  }),
)

itFacade.live("Memory.add is idempotent on re-insert (hash dedup)", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const first = yield* memory.add(sample("p", ["k"]))
    const second = yield* memory.add(sample("p", ["k"]))
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.record.hashId).toBe(first.record.hashId)
  }),
)
