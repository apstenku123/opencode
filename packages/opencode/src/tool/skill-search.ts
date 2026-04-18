/**
 * `skill_search` tool — port of Rust's `skills/handler.rs::SkillSearchHandler`.
 *
 * The model calls this tool with `{query, topK?}` to retrieve a list of
 * skills ranked by relevance. Retrieval strategy:
 *
 *   1. **Hybrid** (default) — blend BM25 with cosine similarity from a local
 *      TF-IDF embedding using `skills.retrieval.{bm25Weight, embeddingWeight}`
 *      (defaults 0.4 × BM25 + 0.6 × cosine). The embedding channel uses the
 *      zero-dependency TF-IDF provider — no network, deterministic.
 *   2. **BM25 only** — when `OPENCODE_EMBEDDING_PROVIDER=none` (documented
 *      escape hatch) or the embedder throws, fall through to BM25.
 *   3. **Substring fallback** — on cold-start / short queries BM25 can't
 *      score, use the substring `recommend()` scorer from `SystemPrompt`.
 *
 * The tool is auto-registered next to `skill_execute` (see `tool/registry.ts`).
 */

import { Effect } from "effect"
import z from "zod"
import { Skill } from "@/skill"
import { Config } from "@/config"
import { tfidfEmbed } from "@/embedding"
import * as Tool from "./tool"
import { SystemPrompt } from "@/session/system"

const Parameters = z.object({
  query: z.string().describe("The search query to match against skill names, descriptions, and content."),
  topK: z.number().int().positive().optional().describe("Maximum number of results to return. Defaults to 5."),
})

export const SkillSearchTool = Tool.define(
  "skill_search",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const config = yield* Config.Service

    return {
      description:
        "Search the skill library for skills matching a query. Returns matching skills ranked by hybrid BM25↔embedding relevance (default 0.4×BM25 + 0.6×cosine), with name, description, location, and score. Use this before `skill` to discover which named skill is most relevant to the current task when the prompt mentions a topic but no specific skill name.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          type ResultRow = { name: string; score: number; bm25Score: number; cosineScore: number }
          type Meta = { results: ResultRow[]; source: string }
          const query = params.query.trim()
          const topK = params.topK ?? 5
          if (!query) {
            return {
              title: "Empty query",
              output: "query must not be empty",
              metadata: { results: [] as ResultRow[], source: "empty" } satisfies Meta,
            }
          }

          // Resolve retrieval weights from config (user override) or defaults.
          const cfg = yield* config.get()
          const retrieval = cfg.skills?.retrieval
          const weights = {
            bm25Weight: retrieval?.bm25Weight,
            embeddingWeight: retrieval?.embeddingWeight,
          }

          // Embedding channel: use the local TF-IDF provider unless the user
          // explicitly opted out with `OPENCODE_EMBEDDING_PROVIDER=none`.
          const embeddingDisabled = (process.env["OPENCODE_EMBEDDING_PROVIDER"] ?? "").trim().toLowerCase() === "none"
          const embedder = embeddingDisabled
            ? undefined
            : {
                embed: (text: string) => tfidfEmbed(text),
                embedBatch: (texts: ReadonlyArray<string>) => texts.map((t) => tfidfEmbed(t)),
              }

          let source = embedder ? "hybrid" : "bm25"
          let hits = yield* skill.searchHybrid({ query, topK, weights, embedder })

          // If hybrid returned empty (e.g. embedding disabled *and* BM25
          // missed) fall back to the pure BM25 path first, then to substring.
          if (hits.length === 0) {
            const bm25 = yield* skill.search(query, topK)
            if (bm25.length > 0) {
              source = "bm25"
              hits = bm25.map((h) => ({
                skill: h.skill,
                score: h.score,
                bm25Score: h.score,
                cosineScore: 0,
              }))
            }
          }

          if (hits.length === 0) {
            // Cold-start / query-token-too-short fallback: substring scorer.
            const list = yield* skill.available()
            const fallback = SystemPrompt.recommend({ text: query, list }).slice(0, topK)
            hits = fallback.map((s, i) => ({
              skill: s,
              score: 1 - i * 0.01,
              bm25Score: 0,
              cosineScore: 0,
            }))
            source = "substring"
          }

          if (hits.length === 0) {
            return {
              title: "No matching skills",
              output: "No matching skills found.",
              metadata: { results: [] as ResultRow[], source: "none" } satisfies Meta,
            }
          }

          const lines: string[] = [`Found ${hits.length} skill(s) [source: ${source}]:`, ""]
          hits.forEach((hit, i) => {
            lines.push(`### ${i + 1}. ${hit.skill.name} (score: ${hit.score.toFixed(2)})`)
            lines.push(`**Description:** ${hit.skill.description}`)
            lines.push(`**Path:** ${hit.skill.location}`)
            lines.push("")
          })

          return {
            title: `Found ${hits.length} skill(s)`,
            output: lines.join("\n"),
            metadata: {
              results: hits.map((h) => ({
                name: h.skill.name,
                score: h.score,
                bm25Score: h.bm25Score,
                cosineScore: h.cosineScore,
              })),
              source,
            } satisfies Meta,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
