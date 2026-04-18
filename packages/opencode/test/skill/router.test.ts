/**
 * Unit tests for the Memento-style skill router.
 *
 * Covers all three kinds (`bm25` / `rrf` / `boltzmann`), the pure helpers
 * (RRF, utility blend, dot product, Boltzmann softmax, inverse-CDF
 * sampler), and the `SkillRouter` config clamping / mode filter.
 */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TEMPERATURE,
  RRF_K,
  UTILITY_BONUS,
  applyUtilityWeighting,
  boltzmannRoute,
  buildRoutedRanking,
  dotProduct,
  reciprocalRankFusion,
  route,
  routeBm25,
  routeBoltzmann,
  routeRrf,
  sampleSkill,
  skillExecutionMode,
  type RoutedSkill,
} from "@/skill/router"
import type { Info as SkillInfo } from "@/skill"

const mkSkill = (name: string, overrides?: Partial<SkillInfo>): SkillInfo => ({
  name,
  description: overrides?.description ?? `${name} description`,
  location: overrides?.location ?? `/tmp/${name}/SKILL.md`,
  content: overrides?.content ?? "",
  dependencies: overrides?.dependencies,
})

describe("skill/router — helpers", () => {
  test("reciprocalRankFusion gives higher rank a larger 1/(k+rank) contribution", () => {
    const bm25 = [
      ["a", 10] as const,
      ["b", 5] as const,
    ]
    const embed = [
      ["c", 0.8] as const,
      ["a", 0.7] as const,
    ]
    const fused = reciprocalRankFusion(bm25, embed, {
      bm25Weight: 0.4,
      embeddingWeight: 0.6,
    })
    // `a` appears in both lists at rank 1 and rank 2 ⇒ highest fused score.
    expect(fused[0]![0]).toBe("a")
  })

  test("reciprocalRankFusion `k = RRF_K` (Cormack)", () => {
    // Sanity — the constant export is stable and matches the paper.
    expect(RRF_K).toBe(60)
  })

  test("applyUtilityWeighting mixes utility in proportion to weight", () => {
    const fused = [
      ["a", 1.0] as const,
      ["b", 1.0] as const,
    ]
    const utility = new Map<string, number>([
      ["a", 0.0],
      ["b", 1.0],
    ])
    const weighted = applyUtilityWeighting(fused, utility, 0.5)
    const [nameA, finalA] = weighted[0]!
    const [nameB, finalB] = weighted[1]!
    expect(nameA).toBe("a")
    expect(nameB).toBe("b")
    // (1-0.5)*1 + 0.5*0 = 0.5; (1-0.5)*1 + 0.5*1 = 1.0
    expect(finalA).toBeCloseTo(0.5, 6)
    expect(finalB).toBeCloseTo(1.0, 6)
  })

  test("dotProduct truncates to the shorter slice", () => {
    expect(dotProduct([1, 2, 3], [4, 5])).toBeCloseTo(1 * 4 + 2 * 5, 6)
    expect(dotProduct([], [4, 5])).toBe(0)
  })
})

describe("skill/router — Boltzmann math", () => {
  test("boltzmannRoute produces a valid probability distribution", () => {
    const probs = boltzmannRoute({
      queryEmbedding: [1, 0, 0],
      skillEmbeddings: [
        ["a", [0.9, 0.1, 0]],
        ["b", [0.1, 0.9, 0]],
        ["c", [0, 0, 0.9]],
      ],
      temperature: DEFAULT_TEMPERATURE,
      utilityTable: new Map(),
    })
    const sum = probs.reduce((acc, [, p]) => acc + p, 0)
    expect(sum).toBeCloseTo(1, 6)
    expect(probs[0]![0]).toBe("a") // highest dot product
  })

  test("boltzmannRoute utility bonus biases Q-values", () => {
    // Two skills with identical embedding similarity — utility tie-breaks.
    const probs = boltzmannRoute({
      queryEmbedding: [1],
      skillEmbeddings: [
        ["a", [0.5]],
        ["b", [0.5]],
      ],
      temperature: 1.0,
      utilityTable: new Map([["b", 1.0]]),
    })
    const [first] = probs
    expect(first![0]).toBe("b")
    // With τ=1 and utility bonus UTILITY_BONUS*1 added to `b` but not `a`,
    // P(b)/P(a) = exp(UTILITY_BONUS / 1)  =  exp(0.5) ≈ 1.648.
    const ratio = probs.find(([n]) => n === "b")![1] / probs.find(([n]) => n === "a")![1]
    expect(ratio).toBeCloseTo(Math.exp(UTILITY_BONUS), 3)
  })

  test("boltzmannRoute temperature controls spread", () => {
    const hot = boltzmannRoute({
      queryEmbedding: [1],
      skillEmbeddings: [
        ["a", [1]],
        ["b", [0]],
      ],
      temperature: 10.0,
      utilityTable: new Map(),
    })
    const cold = boltzmannRoute({
      queryEmbedding: [1],
      skillEmbeddings: [
        ["a", [1]],
        ["b", [0]],
      ],
      temperature: 0.01,
      utilityTable: new Map(),
    })
    // Cold: P(a) close to 1; Hot: closer to 0.5.
    const hotA = hot.find(([n]) => n === "a")![1]
    const coldA = cold.find(([n]) => n === "a")![1]
    expect(coldA).toBeGreaterThan(hotA)
    expect(coldA).toBeGreaterThan(0.99)
    expect(hotA).toBeLessThan(0.8)
  })

  test("boltzmannRoute returns empty for empty input", () => {
    expect(boltzmannRoute({
      queryEmbedding: [1],
      skillEmbeddings: [],
      utilityTable: new Map(),
    })).toEqual([])
  })

  test("sampleSkill picks deterministically from a distribution", () => {
    const dist: ReadonlyArray<readonly [string, number]> = [
      ["a", 0.7],
      ["b", 0.2],
      ["c", 0.1],
    ]
    const pick = sampleSkill(dist)
    expect(pick).toBeDefined()
    expect(["a", "b", "c"]).toContain(pick as string)
    // Deterministic: same input → same output.
    expect(sampleSkill(dist)).toBe(pick as string)
  })

  test("sampleSkill returns undefined for empty distribution", () => {
    expect(sampleSkill([])).toBeUndefined()
  })
})

describe("skill/router — kinds", () => {
  const library = new Map<string, SkillInfo>([
    ["alpha", mkSkill("alpha")],
    ["beta", mkSkill("beta")],
    ["gamma", mkSkill("gamma")],
  ])

  test("routeBm25 preserves BM25 order", () => {
    const results = routeBm25(
      {
        bm25Results: [
          ["beta", 5.0] as const,
          ["alpha", 3.0] as const,
        ],
        skillLibrary: library,
      },
      { maxCandidates: 5 },
    )
    expect(results.map((r) => r.skill.name)).toEqual(["beta", "alpha"])
    expect(results[0]!.bm25Score).toBe(5)
    expect(results[0]!.embeddingScore).toBe(0)
  })

  test("routeRrf merges BM25 + embedding results by rank", () => {
    const results = routeRrf(
      {
        query: "whatever",
        bm25Results: [
          ["alpha", 10] as const,
          ["beta", 5] as const,
        ],
        embeddingResults: [
          ["gamma", 0.9] as const,
          ["alpha", 0.8] as const,
        ],
        skillLibrary: library,
        utilityTable: new Map(),
      },
      { minScoreThreshold: 0 },
    )
    // `alpha` appears in both lists at rank 1 / rank 2 → highest fused score.
    expect(results[0]!.skill.name).toBe("alpha")
  })

  test("routeBoltzmann falls back to RRF when embedding list is empty", () => {
    const results = routeBoltzmann(
      {
        query: "whatever",
        bm25Results: [
          ["alpha", 10] as const,
          ["beta", 5] as const,
        ],
        embeddingResults: [],
        skillLibrary: library,
        utilityTable: new Map(),
      },
      { minScoreThreshold: 0 },
    )
    expect(results.length).toBe(2)
    expect(results[0]!.skill.name).toBe("alpha")
  })

  test("routeBoltzmann uses softmax when embeddings are present", () => {
    const results = routeBoltzmann(
      {
        query: "whatever",
        bm25Results: [],
        embeddingResults: [
          ["alpha", 0.9] as const,
          ["beta", 0.1] as const,
        ],
        skillLibrary: library,
        utilityTable: new Map(),
      },
      { minScoreThreshold: 0, temperature: 0.1 },
    )
    expect(results[0]!.skill.name).toBe("alpha")
    // finalScore is a probability in [0,1].
    expect(results[0]!.finalScore).toBeGreaterThan(0)
    expect(results[0]!.finalScore).toBeLessThanOrEqual(1)
    const totalProb = results.reduce((acc, r) => acc + r.finalScore, 0)
    expect(totalProb).toBeLessThanOrEqual(1.0001)
  })

  test("route dispatches on kind", () => {
    const base = {
      query: "q",
      bm25Results: [["alpha", 10] as const],
      embeddingResults: [] as Array<readonly [string, number]>,
      skillLibrary: library,
      utilityTable: new Map<string, number>(),
    }
    expect(route({ ...base, kind: "bm25" })[0]!.skill.name).toBe("alpha")
    expect(route({ ...base, kind: "rrf" }, { minScoreThreshold: 0 })[0]!.skill.name).toBe("alpha")
    expect(route({ ...base, kind: "boltzmann" }, { minScoreThreshold: 0 })[0]!.skill.name).toBe("alpha")
  })

  test("config caps & thresholds apply", () => {
    const many = new Map<string, SkillInfo>()
    const bm25: Array<readonly [string, number]> = []
    for (let i = 0; i < 20; i++) {
      const name = `s${i}`
      many.set(name, mkSkill(name))
      bm25.push([name, 20 - i] as const)
    }
    const results = routeBm25(
      { bm25Results: bm25, skillLibrary: many },
      { maxCandidates: 3 },
    )
    expect(results.length).toBe(3)
  })
})

describe("skill/router — mode filter", () => {
  const plans = mkSkill("planner", {
    content: `---
name: planner
execution_mode: knowledge
---
body`,
  })
  const runner = mkSkill("runner", {
    content: `---
name: runner
execution_mode: playbook
---
body`,
  })
  const noMode = mkSkill("neutral", { content: `---\nname: neutral\n---\nbody` })

  test("skillExecutionMode parses frontmatter", () => {
    expect(skillExecutionMode(plans)).toBe("knowledge")
    expect(skillExecutionMode(runner)).toBe("playbook")
    expect(skillExecutionMode(noMode)).toBeUndefined()
  })

  test("modeFilter drops skills of the wrong mode", () => {
    const lib = new Map([
      ["planner", plans],
      ["runner", runner],
      ["neutral", noMode],
    ])
    const results = routeBm25(
      {
        bm25Results: [
          ["planner", 1] as const,
          ["runner", 1] as const,
          ["neutral", 1] as const,
        ],
        skillLibrary: lib,
      },
      { modeFilter: "knowledge" },
    )
    expect(results.map((r) => r.skill.name)).toEqual(["planner"])
  })
})

describe("skill/router — buildRoutedRanking", () => {
  const skills: SkillInfo[] = [
    mkSkill("apple", { content: "fruit red orange juice" }),
    mkSkill("banana", { content: "fruit yellow soft peel" }),
    mkSkill("carrot", { content: "vegetable orange root" }),
  ]

  test("BM25 kind walks only BM25 channel", () => {
    const out: RoutedSkill[] = buildRoutedRanking({
      skills,
      query: "orange fruit",
      kind: "bm25",
    })
    expect(out.length).toBeGreaterThan(0)
    for (const r of out) expect(r.embeddingScore).toBe(0)
  })

  test("RRF kind uses both channels when cosine scores supplied", () => {
    const cosine = new Map<string, number>([
      ["banana", 0.95],
      ["apple", 0.3],
    ])
    const out: RoutedSkill[] = buildRoutedRanking({
      skills,
      query: "orange",
      cosineScores: cosine,
      kind: "rrf",
      config: { minScoreThreshold: 0 },
    })
    expect(out.length).toBeGreaterThan(0)
    // Both channels fire: BM25 picks carrot (lexical 'orange'), embedding
    // picks banana (semantic). RRF fusion must keep both present in the
    // final list.
    const names = out.map((r) => r.skill.name)
    expect(names).toContain("banana")
    expect(names).toContain("carrot")
  })

  test("Boltzmann kind with empty cosine degrades to RRF", () => {
    const out = buildRoutedRanking({
      skills,
      query: "fruit",
      kind: "boltzmann",
      config: { minScoreThreshold: 0 },
    })
    expect(out.length).toBeGreaterThan(0)
  })
})
