import z from "zod"

export namespace ConfigSkills {
  /**
   * Hybrid retrieval weights for the `skill_search` tool. When both
   * channels are available (BM25 + embedding) the final ranking is
   * `bm25Weight * bm25_norm + embeddingWeight * cosine_norm`. Each channel
   * is min-max normalised to `[0, 1]` over the candidate pool so the
   * weights are directly comparable.
   */
  export const Retrieval = z.object({
    bm25Weight: z
      .number()
      .min(0)
      .optional()
      .describe("Weight applied to the BM25 channel in hybrid retrieval. Defaults to 0.4."),
    embeddingWeight: z
      .number()
      .min(0)
      .optional()
      .describe("Weight applied to the embedding cosine channel in hybrid retrieval. Defaults to 0.6."),
  })
  export type Retrieval = z.infer<typeof Retrieval>

  /**
   * Router kind for `Skill.Service.search`. `"bm25"` (default) preserves
   * parity with the pre-Memento BM25-only path; `"rrf"` enables Reciprocal
   * Rank Fusion over BM25 + embedding results; `"boltzmann"` enables the
   * Memento Eq. 4 softmax policy. Utility-weight blending applies in both
   * the RRF and Boltzmann paths.
   */
  export const Router = z.object({
    kind: z
      .enum(["bm25", "rrf", "boltzmann"])
      .optional()
      .describe("Which router to dispatch to. Defaults to 'bm25' for strict parity."),
    utilityWeight: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Utility-rate weight applied to fused scores. Defaults to 0.3."),
    temperature: z
      .number()
      .positive()
      .optional()
      .describe("Boltzmann softmax temperature τ. Defaults to 0.1 (exploitative)."),
    minScoreThreshold: z
      .number()
      .min(0)
      .optional()
      .describe("Minimum final score retained. Defaults to 0.1."),
    maxCandidates: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum number of routed skills returned. Defaults to 5."),
  })
  export type Router = z.infer<typeof Router>

  export const Info = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z
      .array(z.string())
      .optional()
      .describe("URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)"),
    retrieval: Retrieval.optional().describe("Hybrid BM25 ↔ embedding retrieval weights"),
    router: Router.optional().describe("Memento skill router configuration"),
    builtin: z
      .boolean()
      .optional()
      .describe("When true, registers the 8 bundled built-in skills at startup. Defaults to false."),
  })

  export type Info = z.infer<typeof Info>
}
