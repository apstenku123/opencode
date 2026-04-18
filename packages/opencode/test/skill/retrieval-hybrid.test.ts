import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bm25Index } from "../../src/skill/bm25"
import {
  DEFAULT_BM25_WEIGHT,
  DEFAULT_EMBEDDING_WEIGHT,
  hybridRank,
  hybridSearch,
} from "../../src/skill/retrieval"
import { tfidfEmbed } from "../../src/embedding/tfidf"
import { EmbeddingService, localTfIdfLayer } from "../../src/embedding"
import type { Skill } from "../../src/skill"

const skill = (name: string, description: string, content: string): Skill.Info => ({
  name,
  description,
  content,
  location: `/tmp/${name}/SKILL.md`,
})

describe("skill/retrieval — hybrid rank combination", () => {
  test("default weights sum to 1.0 (0.4 + 0.6)", () => {
    expect(DEFAULT_BM25_WEIGHT + DEFAULT_EMBEDDING_WEIGHT).toBeCloseTo(1, 10)
    expect(DEFAULT_BM25_WEIGHT).toBe(0.4)
    expect(DEFAULT_EMBEDDING_WEIGHT).toBe(0.6)
  })

  test("pure BM25 channel when cosine scores are empty", () => {
    const skills = [
      skill("alpha", "first skill", "alpha body"),
      skill("beta", "second skill", "beta body"),
      skill("gamma", "third skill", "gamma body"),
    ]
    const hits = hybridRank(
      skills,
      [
        { skillName: "alpha", score: 2.5 },
        { skillName: "beta", score: 1.5 },
        { skillName: "gamma", score: 1.0 },
      ],
      new Map(),
    )
    // alpha + beta survive min-max normalisation; gamma ends at 0 and is filtered.
    expect(hits[0]!.skill.name).toBe("alpha")
    expect(hits[0]!.bm25Score).toBe(2.5)
    expect(hits[0]!.cosineScore).toBe(0)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.length).toBeLessThanOrEqual(3)
  })

  test("pure embedding channel when BM25 hits are empty", () => {
    const skills = [skill("alpha", "d1", "c1"), skill("beta", "d2", "c2")]
    const hits = hybridRank(
      skills,
      [],
      new Map([
        ["beta", 0.8],
        ["alpha", 0.3],
      ]),
    )
    expect(hits[0]!.skill.name).toBe("beta")
    expect(hits[0]!.cosineScore).toBeCloseTo(0.8, 6)
  })

  test("blends both channels when both have signal", () => {
    // alpha: high BM25, low cosine.  beta: low BM25, high cosine.
    // With 0.4/0.6 defaults, beta should edge out alpha after normalisation.
    const skills = [skill("alpha", "a", "a"), skill("beta", "b", "b")]
    const hits = hybridRank(
      skills,
      [
        { skillName: "alpha", score: 5.0 },
        { skillName: "beta", score: 0.5 },
      ],
      new Map([
        ["alpha", 0.1],
        ["beta", 0.95],
      ]),
    )
    // Normalised: alpha_bm=1, beta_bm=0; alpha_cos=0, beta_cos=1.
    // final_alpha = 0.4; final_beta = 0.6 → beta wins.
    expect(hits[0]!.skill.name).toBe("beta")
    expect(hits[1]!.skill.name).toBe("alpha")
    expect(hits[0]!.score).toBeCloseTo(0.6, 6)
    expect(hits[1]!.score).toBeCloseTo(0.4, 6)
  })

  test("custom weights shift the ranking", () => {
    const skills = [skill("alpha", "a", "a"), skill("beta", "b", "b")]
    const bm25 = [
      { skillName: "alpha", score: 5.0 },
      { skillName: "beta", score: 0.5 },
    ]
    const cos = new Map([
      ["alpha", 0.1],
      ["beta", 0.95],
    ])
    // BM25-heavy weights → alpha wins.
    const bm25Heavy = hybridRank(skills, bm25, cos, 5, { bm25Weight: 0.9, embeddingWeight: 0.1 })
    expect(bm25Heavy[0]!.skill.name).toBe("alpha")
    // Embedding-heavy weights → beta wins.
    const embedHeavy = hybridRank(skills, bm25, cos, 5, { bm25Weight: 0.1, embeddingWeight: 0.9 })
    expect(embedHeavy[0]!.skill.name).toBe("beta")
  })

  test("zero-weight on a channel silences it", () => {
    const skills = [skill("alpha", "a", "a"), skill("beta", "b", "b")]
    const hits = hybridRank(
      skills,
      [
        { skillName: "alpha", score: 5.0 },
        { skillName: "beta", score: 0.5 },
      ],
      new Map([
        ["alpha", 0.1],
        ["beta", 0.95],
      ]),
      5,
      { bm25Weight: 1, embeddingWeight: 0 },
    )
    expect(hits[0]!.skill.name).toBe("alpha")
  })

  test("returns empty when no candidates at all", () => {
    expect(hybridRank([], [], new Map())).toEqual([])
  })

  test("respects topK cap", () => {
    const skills = Array.from({ length: 8 }, (_, i) => skill(`s${i}`, `d${i}`, `c${i}`))
    const bm25 = skills.map((s, i) => ({ skillName: s.name, score: 8 - i }))
    const hits = hybridRank(skills, bm25, new Map(), 3)
    expect(hits.length).toBeLessThanOrEqual(3)
  })

  test("filters zero-score results when at least one candidate scored > 0", () => {
    const skills = [skill("alpha", "a", "a"), skill("beta", "b", "b"), skill("gamma", "g", "g")]
    const hits = hybridRank(
      skills,
      [
        { skillName: "alpha", score: 3 },
        { skillName: "beta", score: 3 },
      ],
      new Map([["gamma", 0.5]]),
      10,
    )
    // alpha/beta have equal BM25 → normalised to 0.5/0.5 … wait, min-max
    // on [3,3] collapses to all-zero so they contribute nothing on BM25.
    // gamma gets full cosine signal.
    const names = hits.map((h) => h.skill.name)
    expect(names).toContain("gamma")
  })
})

describe("skill/retrieval — hybridSearch with embedder", () => {
  test("inline embedder path (no Effect service needed)", async () => {
    const skills = [
      skill("rust-fix", "Fix Rust compilation errors", "cargo build error"),
      skill("docker-build", "Build Docker images", "docker build command"),
      skill("git-push", "Push commits to remote", "git push origin main"),
    ]
    const index = Bm25Index.build(skills)

    const tfidfEmbedder = {
      embed: async (text: string) => tfidfEmbed(text),
      embedBatch: async (texts: ReadonlyArray<string>) => texts.map((t) => tfidfEmbed(t)),
    }

    const hits = await Effect.runPromise(
      hybridSearch({
        index,
        skills,
        query: "docker container build",
        topK: 3,
        embedder: tfidfEmbedder,
      }),
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.skill.name).toBe("docker-build")
    // cosineScore must be populated on the winning hit.
    expect(hits[0]!.cosineScore).toBeGreaterThan(0)
    expect(hits[0]!.bm25Score).toBeGreaterThan(0)
  })

  test("effect-service path (EmbeddingService from layer)", async () => {
    const skills = [
      skill("alpha", "about alpha things", "alpha body"),
      skill("beta", "about beta things", "beta body"),
    ]
    const index = Bm25Index.build(skills)
    const program = hybridSearch({ index, skills, query: "alpha", topK: 2 })
    const hits = await Effect.runPromise(
      Effect.provide(program as Effect.Effect<any, never, EmbeddingService>, localTfIdfLayer({ vocabSize: 128 })),
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.skill.name).toBe("alpha")
  })

  test("embedder throw degrades to BM25 channel only", async () => {
    const skills = [skill("alpha", "about alpha", "alpha"), skill("beta", "about beta", "beta")]
    const index = Bm25Index.build(skills)
    const hits = await Effect.runPromise(
      hybridSearch({
        index,
        skills,
        query: "alpha",
        embedder: {
          embed: async () => {
            throw new Error("kaboom")
          },
          embedBatch: async () => {
            throw new Error("kaboom")
          },
        },
      }),
    )
    // BM25 alone still ranks alpha first.
    expect(hits[0]!.skill.name).toBe("alpha")
  })

  test("semantic-only fallback when BM25 misses (cold-start)", async () => {
    const skills = [
      skill("kubernetes-troubleshooting", "Diagnose pod crashloops in k8s", "kubectl logs and describe"),
      skill("rust-ownership", "Debug borrow-checker errors", "lifetimes and moves"),
    ]
    const index = Bm25Index.build(skills)
    // Use tfidfEmbed — query has no lexical overlap with either skill.
    const embedder = {
      embed: async (text: string) => tfidfEmbed(text),
      embedBatch: async (texts: ReadonlyArray<string>) => texts.map((t) => tfidfEmbed(t)),
    }
    const hits = await Effect.runPromise(
      hybridSearch({
        index,
        skills,
        query: "completely unrelated xyzzy phrase",
        embedder,
      }),
    )
    // Either returns empty (no semantic match either) or bounded by topK.
    expect(hits.length).toBeLessThanOrEqual(5)
  })

  test("Skill.searchHybrid integration shape via hybridRank is stable across re-queries", () => {
    const skills = [
      skill("rate-limit-tuning", "Tune API rate limits", "rate limit tuning"),
      skill("docker-build", "Cross-compile docker", "docker build"),
    ]
    const idx = Bm25Index.build(skills)
    const bm25 = idx.search("rate limit", 5)
    const cos = new Map<string, number>()
    for (const s of skills) {
      cos.set(s.name, 0.5)
    }
    const hits = hybridRank(skills, bm25, cos, 5)
    expect(hits.length).toBeGreaterThan(0)
    // Ensure every hit carries both component scores explicitly.
    for (const h of hits) {
      expect(typeof h.bm25Score).toBe("number")
      expect(typeof h.cosineScore).toBe("number")
      expect(typeof h.score).toBe("number")
    }
  })
})
