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

  export const Info = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z
      .array(z.string())
      .optional()
      .describe("URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)"),
    retrieval: Retrieval.optional().describe("Hybrid BM25 ↔ embedding retrieval weights"),
  })

  export type Info = z.infer<typeof Info>
}
