/**
 * Tests for the dedicated LLM polish layer. These exercise the polish
 * path without going through the 4-signal gate, complementing the
 * existing coverage in `refining.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { polishCandidate, polishCandidates, type PolishOptions } from "@/memory/refining-llm"
import type { RefiningCandidate, SuccessScore } from "@/memory/refining"

const candidate: RefiningCandidate = {
  keywords: ["mutex", "deadlock"],
  problem: "Service deadlocks on shutdown when logger and timer race.",
  rootCause: "Out-of-order lock acquisition between logger and timer modules.",
  solution: "Unify lock ordering so both acquire the logger lock first.",
}

const score: SuccessScore = {
  objective: 1,
  sentiment: 1,
  circles: 1,
  momentum: 1,
  total: 1,
}

const makeModel = (response: string | null, options?: { delay?: number }): PolishOptions => ({
  model: () =>
    Effect.gen(function* () {
      if (options?.delay) yield* Effect.sleep(options.delay)
      return response
    }),
})

describe("memory/refining-llm — polishCandidate", () => {
  test("returns polished candidate on successful JSON response", async () => {
    const options = makeModel(
      JSON.stringify({
        keywords: ["shutdown", "mutex", "deadlock"],
        problem: "Service deadlocked at shutdown due to concurrent mutex acquisition.",
        root_cause: "Logger acquired timer mutex before its own; timer did the inverse.",
        solution: "Unified lock ordering: every consumer acquires the logger lock first.",
      }),
    )
    const out = await Effect.runPromise(polishCandidate({ candidate, score, options }))
    expect(out.path).toBe("polished")
    expect(out.candidate.problem.startsWith("Service deadlocked")).toBe(true)
    expect(out.candidate.keywords).toContain("shutdown")
  })

  test("falls back to original on parse failure", async () => {
    const options = makeModel("not valid json at all")
    const out = await Effect.runPromise(polishCandidate({ candidate, score, options }))
    expect(out.path).toBe("kept-verbatim")
    expect(out.candidate).toEqual(candidate)
    expect(out.reason).toContain("parse")
  })

  test("falls back to original when model returns null", async () => {
    const options = makeModel(null)
    const out = await Effect.runPromise(polishCandidate({ candidate, score, options }))
    expect(out.path).toBe("kept-verbatim")
    expect(out.candidate).toEqual(candidate)
  })

  test("honours per-call timeout", async () => {
    const options: PolishOptions = {
      model: () =>
        Effect.gen(function* () {
          yield* Effect.sleep(5000)
          return "never arrives"
        }),
      timeoutMs: 20,
    }
    const out = await Effect.runPromise(polishCandidate({ candidate, score, options }))
    expect(out.path).toBe("kept-verbatim")
    expect(out.reason).toContain("unavailable")
  })

  test("tolerates fenced JSON code blocks", async () => {
    const options = makeModel(
      "Sure, here you go:\n```json\n" +
        JSON.stringify({
          keywords: ["a", "b"],
          problem: "p",
          root_cause: "r",
          solution: "s",
        }) +
        "\n```\nHope this helps.",
    )
    const out = await Effect.runPromise(polishCandidate({ candidate, score, options }))
    expect(out.path).toBe("polished")
    expect(out.candidate.keywords).toEqual(["a", "b"])
  })
})

describe("memory/refining-llm — polishCandidates batch", () => {
  test("polishes all items concurrently and preserves order", async () => {
    const options = makeModel(
      JSON.stringify({
        keywords: ["kw"],
        problem: "problem one",
        root_cause: "root",
        solution: "sol",
      }),
    )
    const items = [1, 2, 3].map((n) => ({
      candidate: { ...candidate, problem: `original ${n}` },
      score,
    }))
    const out = await Effect.runPromise(polishCandidates({ items, options, concurrency: 2 }))
    expect(out.length).toBe(3)
    for (const r of out) {
      expect(r.path).toBe("polished")
      expect(r.candidate.problem).toBe("problem one")
    }
  })
})
