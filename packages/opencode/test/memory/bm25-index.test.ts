/**
 * BM25 sextuple index + hybrid ranker unit tests.
 *
 * Keep these pure — no DB, no Effect layers. Integration with the storage
 * layer is exercised separately in `retrieval.test.ts` via the live layer.
 */

import { describe, expect, test } from "bun:test"

import {
  Bm25MemoryIndex,
  sextupleDocText,
  tokenize,
  tokenizeSextuple,
} from "../../src/memory/bm25-index"
import {
  DEFAULT_BM25_WEIGHT,
  DEFAULT_EMBEDDING_WEIGHT,
  blendHybridScores,
  rankByBm25,
  rankByHybrid,
} from "../../src/memory/retrieval"
import type { DefectSextuple } from "../../src/memory/schema"

function fakeRecord(overrides: Partial<DefectSextuple>): DefectSextuple {
  return {
    id: overrides.hashId ? `mem-${overrides.hashId}` : "mem-x",
    hashId: "x",
    keywords: ["k"],
    problem: "p",
    rootCause: "r",
    solution: "s",
    source: { _tag: "rollout", threadID: "t", timestamp: 0 } as DefectSextuple["source"],
    timeCreated: 0,
    timeUpdated: 0,
    ...overrides,
  } as DefectSextuple
}

describe("memory/bm25-index — tokenizer", () => {
  test("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Hello, World! 123")).toEqual(["hello", "world", "123"])
  })

  test("drops stopwords and <2-char tokens", () => {
    expect(tokenize("the a and an by for")).toEqual([])
    expect(tokenize("x y z")).toEqual([])
  })

  test("sextuple doc text concatenates all fields with doubled keywords", () => {
    const record = fakeRecord({
      hashId: "h1",
      keywords: ["alpha", "beta"],
      problem: "race condition",
      rootCause: "shared mutable state",
      solution: "use lock",
    })
    const doc = sextupleDocText(record)
    expect(doc).toContain("race condition")
    expect(doc).toContain("shared mutable state")
    expect(doc).toContain("use lock")
    // keywords should appear twice for the boost.
    const count = doc.split("alpha").length - 1
    expect(count).toBe(2)
  })

  test("tokenizeSextuple surfaces every field's tokens", () => {
    const record = fakeRecord({
      keywords: ["deadlock"],
      problem: "deadlock on shutdown",
      rootCause: "mutex order inverted",
      solution: "acquire locks in order",
    })
    const tokens = tokenizeSextuple(record)
    expect(tokens).toContain("deadlock")
    expect(tokens).toContain("shutdown")
    expect(tokens).toContain("mutex")
    expect(tokens).toContain("acquire")
  })
})

describe("memory/bm25-index — Bm25MemoryIndex", () => {
  test("empty index returns []", () => {
    const idx = Bm25MemoryIndex.build([])
    expect(idx.size()).toBe(0)
    expect(idx.search("anything", 5)).toEqual([])
  })

  test("ranks records containing query terms higher", () => {
    const records = [
      fakeRecord({
        hashId: "deadlock",
        keywords: ["deadlock", "mutex"],
        problem: "deadlock on shutdown",
        rootCause: "mutex order inverted",
        solution: "acquire locks in order",
      }),
      fakeRecord({
        hashId: "timeout",
        keywords: ["timeout", "http"],
        problem: "timeout in network call",
        rootCause: "no retry budget",
        solution: "add exponential backoff",
      }),
      fakeRecord({
        hashId: "offbyone",
        keywords: ["loop", "boundary"],
        problem: "off-by-one in loop",
        rootCause: "wrong terminal condition",
        solution: "use strict less-than",
      }),
    ]
    const idx = Bm25MemoryIndex.build(records)
    const hits = idx.search("deadlock mutex", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.hashId).toBe("deadlock")
  })

  test("empty query yields []", () => {
    const idx = Bm25MemoryIndex.build([
      fakeRecord({ hashId: "h", problem: "something", rootCause: "x", solution: "y" }),
    ])
    expect(idx.search("", 5)).toEqual([])
    expect(idx.search("   ", 5)).toEqual([])
  })

  test("filter out zero-scoring docs, deterministic hash tiebreak", () => {
    const a = fakeRecord({ hashId: "zzz", problem: "alpha problem", rootCause: "x", solution: "y" })
    const b = fakeRecord({ hashId: "aaa", problem: "alpha problem", rootCause: "x", solution: "y" })
    const idx = Bm25MemoryIndex.build([a, b])
    const hits = idx.search("alpha", 5)
    expect(hits.length).toBe(2)
    // equal score → lexicographic hashId asc
    expect(hits[0]!.hashId).toBe("aaa")
    expect(hits[1]!.hashId).toBe("zzz")
  })
})

describe("memory/retrieval — rankByBm25", () => {
  test("returns [] for empty records or query", () => {
    expect(rankByBm25("deadlock", [], 5)).toEqual([])
    expect(rankByBm25("", [fakeRecord({})], 5)).toEqual([])
  })

  test("annotates bm25Score on the scored result", () => {
    const records = [
      fakeRecord({ hashId: "r1", problem: "deadlock", rootCause: "x", solution: "y" }),
    ]
    const hits = rankByBm25("deadlock", records, 5)
    expect(hits[0]!.record.hashId).toBe("r1")
    expect(hits[0]!.bm25Score).toBeDefined()
    expect(hits[0]!.bm25Score).toBeGreaterThan(0)
    expect(hits[0]!.score).toBe(hits[0]!.bm25Score!)
  })
})

describe("memory/retrieval — rankByHybrid blend math", () => {
  test("default weights sum to 1.0 (0.4 + 0.6)", () => {
    expect(DEFAULT_BM25_WEIGHT + DEFAULT_EMBEDDING_WEIGHT).toBeCloseTo(1, 10)
    expect(DEFAULT_BM25_WEIGHT).toBe(0.4)
    expect(DEFAULT_EMBEDDING_WEIGHT).toBe(0.6)
  })

  test("blendHybridScores falls through when only one channel has signal", () => {
    const out1 = blendHybridScores([1, 0.5, 0], [0, 0, 0], { bm25: 0.4, embed: 0.6 })
    expect(out1).toEqual([1, 0.5, 0])
    const out2 = blendHybridScores([0, 0, 0], [0.1, 0.9, 0.5], { bm25: 0.4, embed: 0.6 })
    expect(out2).toEqual([0.1, 0.9, 0.5])
  })

  test("blendHybridScores weighted sum when both channels live", () => {
    const out = blendHybridScores([1, 0], [0, 1], { bm25: 0.4, embed: 0.6 })
    // w_bm25=0.4/1.0=0.4, w_embed=0.6/1.0=0.6
    expect(out[0]).toBeCloseTo(0.4, 6)
    expect(out[1]).toBeCloseTo(0.6, 6)
  })

  test("zero-weight silences a channel", () => {
    const out = blendHybridScores([1, 0], [0, 1], { bm25: 1, embed: 0 })
    expect(out).toEqual([1, 0])
  })

  test("both dead weights → all zeros", () => {
    expect(blendHybridScores([0, 0], [0, 0], { bm25: 0.4, embed: 0.6 })).toEqual([0, 0])
  })

  test("rankByHybrid returns [] when no records supplied", () => {
    expect(rankByHybrid([], [], new Map(), 5)).toEqual([])
  })

  test("rankByHybrid returns [] when no candidates surface in either channel", () => {
    const records = [fakeRecord({ hashId: "r1" }), fakeRecord({ hashId: "r2" })]
    expect(rankByHybrid(records, [], new Map(), 5)).toEqual([])
  })

  test("rankByHybrid blends BM25 + cosine with default weights", () => {
    const records = [fakeRecord({ hashId: "alpha" }), fakeRecord({ hashId: "beta" })]
    // alpha: strong BM25, weak cosine; beta: weak BM25, strong cosine.
    const hits = rankByHybrid(
      records,
      [
        { hashId: "alpha", score: 5.0 },
        { hashId: "beta", score: 0.5 },
      ],
      new Map([
        ["alpha", 0.1],
        ["beta", 0.95],
      ]),
      5,
    )
    // 0.4 * bm25_norm + 0.6 * embed_norm; normalisation yields 0.4 vs 0.6.
    expect(hits[0]!.record.hashId).toBe("beta")
    expect(hits[1]!.record.hashId).toBe("alpha")
    expect(hits[0]!.score).toBeCloseTo(0.6, 6)
    expect(hits[1]!.score).toBeCloseTo(0.4, 6)
    // annotations propagate.
    expect(hits[0]!.bm25Score).toBeCloseTo(0.5, 6)
    expect(hits[0]!.cosineScore).toBeCloseTo(0.95, 6)
  })

  test("rankByHybrid custom weights flip ordering", () => {
    const records = [fakeRecord({ hashId: "alpha" }), fakeRecord({ hashId: "beta" })]
    const bm25 = [
      { hashId: "alpha", score: 5.0 },
      { hashId: "beta", score: 0.5 },
    ]
    const cos = new Map([
      ["alpha", 0.1],
      ["beta", 0.95],
    ])
    const bm25Heavy = rankByHybrid(records, bm25, cos, 5, 0, {
      bm25Weight: 0.9,
      embeddingWeight: 0.1,
    })
    expect(bm25Heavy[0]!.record.hashId).toBe("alpha")
    const embedHeavy = rankByHybrid(records, bm25, cos, 5, 0, {
      bm25Weight: 0.1,
      embeddingWeight: 0.9,
    })
    expect(embedHeavy[0]!.record.hashId).toBe("beta")
  })

  test("rankByHybrid pure-BM25 fallback when cosineScores empty", () => {
    const records = [
      fakeRecord({ hashId: "a" }),
      fakeRecord({ hashId: "b" }),
      fakeRecord({ hashId: "c" }),
    ]
    const hits = rankByHybrid(
      records,
      [
        { hashId: "a", score: 3.0 },
        { hashId: "b", score: 2.0 },
        { hashId: "c", score: 1.0 },
      ],
      new Map(),
      5,
    )
    // BM25-only via min-max norm → a=1, b=0.5, c=0. Zero-score filtered when
    // at least one positive exists.
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0]!.record.hashId).toBe("a")
  })

  test("rankByHybrid pure-embedding fallback when bm25 empty", () => {
    const records = [fakeRecord({ hashId: "a" }), fakeRecord({ hashId: "b" })]
    const hits = rankByHybrid(
      records,
      [],
      new Map([
        ["a", 0.3],
        ["b", 0.9],
      ]),
      5,
    )
    expect(hits[0]!.record.hashId).toBe("b")
    expect(hits[0]!.cosineScore).toBeCloseTo(0.9, 6)
  })

  test("rankByHybrid honours topK cap", () => {
    const records = Array.from({ length: 6 }, (_, i) => fakeRecord({ hashId: `r${i}` }))
    const bm25 = records.map((r, i) => ({ hashId: r.hashId, score: 6 - i }))
    const hits = rankByHybrid(records, bm25, new Map(), 3)
    expect(hits.length).toBeLessThanOrEqual(3)
  })

  test("rankByHybrid enforces minScore floor", () => {
    const records = [
      fakeRecord({ hashId: "a" }),
      fakeRecord({ hashId: "b" }),
      fakeRecord({ hashId: "c" }),
    ]
    const hits = rankByHybrid(
      records,
      [
        { hashId: "a", score: 3.0 },
        { hashId: "b", score: 2.0 },
        { hashId: "c", score: 1.0 },
      ],
      new Map(),
      5,
      0.4,
    )
    // Normalised: a=1, b=0.5, c=0. MinScore 0.4 drops c (always) and keeps a+b.
    const names = hits.map((h) => h.record.hashId)
    expect(names).not.toContain("c")
    expect(names).toContain("a")
  })
})
