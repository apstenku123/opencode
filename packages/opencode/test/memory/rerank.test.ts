import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  buildRerankPrompt,
  filterAndSort,
  mergeScores,
  parseRerankResponse,
  rerank,
  truncateForPrompt,
  RERANK_BATCH_LIMIT,
  STAGE1_WEIGHT,
  STAGE2_WEIGHT,
  DEFAULT_MIN_SCORE,
  RERANK_PROMPT_TEMPLATE,
} from "../../src/memory/rerank"
import type { ScoredSextuple } from "../../src/memory/retrieval"
import type { DefectSextuple } from "../../src/memory/schema"

const fakeRecord = (id: string, problem = `problem ${id}`): DefectSextuple =>
  ({
    id: `mem-${id}`,
    hashId: id,
    keywords: ["k"],
    problem,
    rootCause: `root ${id}`,
    solution: `sol ${id}`,
    source: { _tag: "rollout", threadID: "t", timestamp: 0 },
    timeCreated: 0,
    timeUpdated: 0,
  }) as DefectSextuple

const fakeScored = (id: string, score: number): ScoredSextuple => ({
  record: fakeRecord(id),
  score,
})

describe("memory/rerank — pure helpers", () => {
  test("STAGE1_WEIGHT + STAGE2_WEIGHT sum to 1.0", () => {
    expect(STAGE1_WEIGHT + STAGE2_WEIGHT).toBeCloseTo(1.0, 6)
  })

  test("RERANK_PROMPT_TEMPLATE contains the {scores: [...]} schema", () => {
    expect(RERANK_PROMPT_TEMPLATE).toContain('{"scores": [score_1, score_2, ..., score_n]}')
  })

  test("truncateForPrompt is a no-op for short strings", () => {
    expect(truncateForPrompt("hi", 100)).toBe("hi")
  })

  test("truncateForPrompt cuts long strings + appends ellipsis", () => {
    const long = "a".repeat(500)
    const out = truncateForPrompt(long, 280)
    expect(out.length).toBeLessThanOrEqual(280)
    expect(out.endsWith("…")).toBe(true)
  })

  test("buildRerankPrompt numbers candidates 1-indexed + substitutes query", () => {
    const prompt = buildRerankPrompt("how to fix deadlock", [fakeScored("a", 0.9), fakeScored("b", 0.8)])
    expect(prompt).toContain("how to fix deadlock")
    expect(prompt).toContain("1. Problem: problem a")
    expect(prompt).toContain("2. Problem: problem b")
    expect(prompt).not.toContain("{query}")
    expect(prompt).not.toContain("{candidates_numbered}")
  })

  test("parseRerankResponse handles direct JSON ints", () => {
    expect(parseRerankResponse('{"scores": [10, 7, 3]}', 3)).toEqual([10, 7, 3])
  })

  test("parseRerankResponse clamps + rounds floats", () => {
    expect(parseRerankResponse('{"scores": [11, -2, 4.6, 7.4]}', 4)).toEqual([10, 0, 5, 7])
  })

  test("parseRerankResponse handles fenced JSON", () => {
    expect(parseRerankResponse('```json\n{"scores": [5, 5]}\n```', 2)).toEqual([5, 5])
  })

  test("parseRerankResponse returns null on length mismatch", () => {
    expect(parseRerankResponse('{"scores": [5, 5]}', 3)).toBeNull()
  })

  test("parseRerankResponse returns null on garbage", () => {
    expect(parseRerankResponse("not json", 1)).toBeNull()
  })

  test("mergeScores applies the weighted formula when scores align", () => {
    const stage1 = [fakeScored("a", 0.9), fakeScored("b", 0.5)]
    const merged = mergeScores(stage1, [10, 0])
    expect(merged[0]!.score).toBeCloseTo(STAGE1_WEIGHT * 0.9 + STAGE2_WEIGHT * 1.0, 6)
    expect(merged[1]!.score).toBeCloseTo(STAGE1_WEIGHT * 0.5 + STAGE2_WEIGHT * 0.0, 6)
  })

  test("mergeScores preserves stage-1 cosines when rerankScores is null", () => {
    const stage1 = [fakeScored("a", 0.9), fakeScored("b", 0.5)]
    const merged = mergeScores(stage1, null)
    expect(merged.map((m) => m.score)).toEqual([0.9, 0.5])
  })

  test("mergeScores preserves stage-1 cosines on length mismatch", () => {
    const stage1 = [fakeScored("a", 0.9)]
    const merged = mergeScores(stage1, [5, 5])
    expect(merged[0]!.score).toBe(0.9)
  })

  test("filterAndSort applies minScore + descending order + topK", () => {
    const scored = [fakeScored("z", 0.5), fakeScored("a", 0.9), fakeScored("m", 0.3)]
    const out = filterAndSort(scored, 0.4, 2)
    expect(out.map((s) => s.record.hashId)).toEqual(["a", "z"])
  })

  test("filterAndSort tiebreak by hashId lexicographic", () => {
    const scored = [fakeScored("z", 0.5), fakeScored("a", 0.5)]
    const out = filterAndSort(scored, 0, 5)
    expect(out.map((s) => s.record.hashId)).toEqual(["a", "z"])
  })
})

describe("memory/rerank — rerank entry point", () => {
  test("returns no-candidates when stage1 is empty", async () => {
    const out = await Effect.runPromise(rerank({ query: "q", stage1: [] }))
    expect(out.reason).toBe("no-candidates")
    expect(out.hits).toEqual([])
  })

  test("returns no-model when bridge is omitted (uses stage-1 cosines + minScore filter)", async () => {
    const out = await Effect.runPromise(
      rerank({
        query: "q",
        stage1: [fakeScored("a", 0.9), fakeScored("b", 0.2)],
        // override the default minScore so 0.2 is filtered out (default is 0.4).
        minScore: DEFAULT_MIN_SCORE,
        topK: 5,
      }),
    )
    expect(out.reason).toBe("no-model")
    expect(out.hits).toHaveLength(1)
    expect(out.hits[0]!.record.hashId).toBe("a")
  })

  test("merges LLM scores with cosines per the weighted formula", async () => {
    const out = await Effect.runPromise(
      rerank({
        query: "q",
        stage1: [fakeScored("a", 0.5), fakeScored("b", 0.5)],
        // Reverse the cosine ordering: rerank scores 'a' low, 'b' high.
        model: () => Effect.succeed('{"scores": [0, 10]}'),
        topK: 5,
        minScore: 0,
      }),
    )
    expect(out.reason).toBe("ok")
    expect(out.hits.map((h) => h.record.hashId)).toEqual(["b", "a"])
  })

  test("falls back to stage-1 only on LLM error (and tags reason)", async () => {
    const out = await Effect.runPromise(
      rerank({
        query: "q",
        stage1: [fakeScored("a", 0.9), fakeScored("b", 0.5)],
        model: () => Effect.fail(new Error("offline")) as unknown as Effect.Effect<string | null, unknown>,
        topK: 5,
        minScore: 0.4,
      }),
    )
    expect(out.reason).toBe("llm-error")
    // Stage-1 ordering preserved; minScore drops nothing here.
    expect(out.hits.map((h) => h.record.hashId)).toEqual(["a", "b"])
  })

  test("falls back to stage-1 only on parse error", async () => {
    const out = await Effect.runPromise(
      rerank({
        query: "q",
        stage1: [fakeScored("a", 0.9)],
        model: () => Effect.succeed("garbage non-json"),
        topK: 5,
        minScore: 0,
      }),
    )
    expect(out.reason).toBe("parse-error")
    expect(out.hits).toHaveLength(1)
  })

  test("batches stage-1 candidates at RERANK_BATCH_LIMIT", async () => {
    const stage1: ScoredSextuple[] = []
    for (let i = 0; i < RERANK_BATCH_LIMIT + 5; i++) stage1.push(fakeScored(`x${String(i).padStart(3, "0")}`, 0.5))
    let calls = 0
    const out = await Effect.runPromise(
      rerank({
        query: "q",
        stage1,
        topK: 100,
        minScore: 0,
        model: () =>
          Effect.sync(() => {
            calls++
            // Always return min-len-aligned response: 20 then 5.
            const sz = calls === 1 ? RERANK_BATCH_LIMIT : 5
            return JSON.stringify({ scores: Array(sz).fill(5) })
          }),
      }),
    )
    expect(calls).toBe(2)
    expect(out.reason).toBe("ok")
    expect(out.hits.length).toBe(stage1.length)
  })
})
