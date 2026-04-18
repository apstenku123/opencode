import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { EffectLogger } from "@/effect"
import { Global } from "@/global"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"

/**
 * Derive the best-effort scope label for a skill, matching the Rust
 * `handler.rs` output header (`(scope: <scope>)`):
 *
 *   - `global`    — lives under the user's global config home (`~/.claude`,
 *     `~/.agents`, or `Global.Path.data/skills`)
 *   - `auto`      — lives under the autoskill hot-insert directory
 *   - `project`   — any other path
 *
 * The Rust reference uses richer metadata (source enums) that we don't track
 * in TS yet; until the schema catches up, these three buckets match the
 * Rust user-facing strings for the vast majority of in-the-wild skills.
 */
export function skillScope(location: string): "global" | "auto" | "project" {
  const normalized = path.resolve(location)
  const autoRoot = path.join(Global.Path.data, "skills", "auto") + path.sep
  if (normalized.startsWith(autoRoot)) return "auto"
  const homeRoots = [
    path.join(Global.Path.home, ".claude") + path.sep,
    path.join(Global.Path.home, ".agents") + path.sep,
    path.join(Global.Path.data) + path.sep,
  ]
  if (homeRoots.some((root) => normalized.startsWith(root))) return "global"
  return "project"
}

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return () =>
      Effect.gen(function* () {
        const list = yield* skill.available().pipe(Effect.provide(EffectLogger.layer))

        const description =
          list.length === 0
            ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
            : [
                "Load a specialized skill that provides domain-specific instructions and workflows.",
                "",
                "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
                "",
                "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
                "",
                'Tool output includes a `<skill_content name="...">` block with the loaded content.',
                "",
                "The following skills provide specialized sets of instructions for particular tasks",
                "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
                "",
                Skill.fmt(list, { verbose: false }),
              ].join("\n")

        return {
          description,
          parameters: Parameters,
          execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const info = yield* skill.get(params.name)
              if (!info) {
                const all = yield* skill.all()
                const available = all.map((item) => item.name).join(", ")
                throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
              }

              yield* ctx.ask({
                permission: "skill",
                patterns: [params.name],
                always: [params.name],
                metadata: {},
              })

              const dir = path.dirname(info.location)
              const base = pathToFileURL(dir).href
              const limit = 10
              const files = yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
                Stream.filter((file) => !file.includes("SKILL.md")),
                Stream.map((file) => path.resolve(dir, file)),
                Stream.take(limit),
                Stream.runCollect,
                Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
              )

              const scope = skillScope(info.location)
              return {
                title: `Loaded skill: ${info.name}`,
                output: [
                  `<skill_content name="${info.name}">`,
                  `# Skill: ${info.name} (scope: ${scope})`,
                  `**Path:** ${info.location}`,
                  "",
                  info.content.trim(),
                  "",
                  `Base directory for this skill: ${base}`,
                  "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
                  "Note: file list is sampled.",
                  "",
                  "<skill_files>",
                  files,
                  "</skill_files>",
                  "</skill_content>",
                ].join("\n"),
                metadata: {
                  name: info.name,
                  dir,
                  scope,
                },
              }
            }).pipe(Effect.orDie),
        }
      })
  }),
)
