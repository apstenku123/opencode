/**
 * `skill_search` tool — port of Rust's `skills/handler.rs::SkillSearchHandler`.
 *
 * The model calls this tool with `{query, topK?}` to retrieve a list of
 * skills ranked by relevance. We delegate to `Skill.Service.search` (BM25
 * over the live registry); on cold start or short queries that BM25 cannot
 * score, we fall back to the substring `recommend()` already used by the
 * system prompt so the tool always returns *something* useful.
 *
 * The tool is auto-registered next to `skill_execute` (see `tool/registry.ts`).
 */

import { Effect } from "effect"
import z from "zod"
import { Skill } from "@/skill"
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

    return {
      description:
        "Search the skill library for skills matching a query. Returns matching skills ranked by BM25 relevance, with name, description, location, and score. Use this before `skill` to discover which named skill is most relevant to the current task when the prompt mentions a topic but no specific skill name.",
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const query = params.query.trim()
          const topK = params.topK ?? 5
          if (!query) {
            return {
              title: "Empty query",
              output: "query must not be empty",
              metadata: { results: [] as { name: string; score: number }[] },
            }
          }

          let hits = yield* skill.search(query, topK)
          let source = "bm25"
          if (hits.length === 0) {
            // Cold-start / query-token-too-short fallback: substring scorer.
            const list = yield* skill.available()
            const fallback = SystemPrompt.recommend({ text: query, list }).slice(0, topK)
            hits = fallback.map((s, i) => ({ skill: s, score: 1 - i * 0.01 }))
            source = "substring"
          }

          if (hits.length === 0) {
            return {
              title: "No matching skills",
              output: "No matching skills found.",
              metadata: { results: [] as { name: string; score: number }[] },
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
              results: hits.map((h) => ({ name: h.skill.name, score: h.score })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
