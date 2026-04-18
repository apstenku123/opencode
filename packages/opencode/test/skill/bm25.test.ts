import { describe, expect, test } from "bun:test"
import { Bm25Index, tokenize } from "../../src/skill/bm25"
import type { Skill } from "../../src/skill"

const skill = (name: string, description: string, content: string): Skill.Info => ({
  name,
  description,
  content,
  location: `/tmp/${name}/SKILL.md`,
})

describe("skill/bm25", () => {
  test("tokenize lowercases and strips stopwords + short tokens", () => {
    expect(tokenize("The quick brown fox a")).toEqual(["quick", "brown", "fox"])
  })

  test("ranks an exact-name match highest", () => {
    const idx = Bm25Index.build([
      skill("rate-limit-tuning", "Tune rate limits", "Steps for tuning copilot rate limit"),
      skill("docker-cross-build", "Cross-compile docker images", "Steps for docker buildx"),
      skill("rust-fix", "Fix compilation issues", "Steps for cargo build errors"),
    ])
    const hits = idx.search("rate limit tuning", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].skillName).toBe("rate-limit-tuning")
  })

  test("returns empty when no token in the corpus", () => {
    const idx = Bm25Index.build([skill("alpha", "first skill", "content alpha")])
    const hits = idx.search("nonexistent terms here", 5)
    expect(hits).toEqual([])
  })

  test("returns empty for stopword-only / short queries", () => {
    const idx = Bm25Index.build([skill("alpha", "first", "content")])
    const hits = idx.search("a the of", 5)
    expect(hits).toEqual([])
  })

  test("respects topK cap", () => {
    const idx = Bm25Index.build(
      Array.from({ length: 10 }, (_, i) =>
        skill(`skill-${i}`, `Description ${i} contains the term magic`, `Body magic ${i}`),
      ),
    )
    const hits = idx.search("magic term", 3)
    expect(hits.length).toBeLessThanOrEqual(3)
  })

  test("triggers in frontmatter contribute to ranking", () => {
    const trig = skill(
      "with-trigger",
      "no useful description",
      "---\nname: with-trigger\ntriggers:\n  - special-needle\n---\n\nbody",
    )
    const other = skill("plain", "ordinary skill", "ordinary body")
    const idx = Bm25Index.build([trig, other])
    const hits = idx.search("special-needle", 5)
    expect(hits[0].skillName).toBe("with-trigger")
  })
})
