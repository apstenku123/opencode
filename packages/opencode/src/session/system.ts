import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"
import { Config } from "../config"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { SkillEnvDeps } from "@/skill/env-deps"
import type { SessionID } from "./schema"

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      return [PROMPT_GPT]
    }
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
    return [PROMPT_DEFAULT]
  }

  export function recommend(input: { text?: string; list: Skill.Info[] }) {
    const text = input.text?.toLowerCase().trim()
    if (!text) return []

    const words = text.split(/[^a-z0-9]+/).filter((part) => part.length >= 4)
    return input.list
      .map((skill) => {
        const hay = [skill.name, skill.description, skill.content].join("\n").toLowerCase()
        const score = words.reduce((sum, word) => {
          if (!hay.includes(word)) return sum
          if (skill.name.toLowerCase().includes(word)) return sum + 4
          if (skill.description.toLowerCase().includes(word)) return sum + 2
          return sum + 1
        }, 0)
        return { skill, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .map((item) => item.skill)
  }

  export interface Interface {
    readonly environment: (model: Provider.Model) => string[]
    readonly skills: (
      agent: Agent.Info,
      input?: string,
      sessionID?: SessionID,
    ) => Effect.Effect<string | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const cfg = yield* Config.Service
      const envDeps = yield* SkillEnvDeps.Service

      const api: Interface = {
        environment(model) {
          const project = Instance.project
          return [
            [
              `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
              `Here is some useful information about the environment you are running in:`,
              `<env>`,
              `  Working directory: ${Instance.directory}`,
              `  Workspace root folder: ${Instance.worktree}`,
              `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
              `  Platform: ${process.platform}`,
              `  Today's date: ${new Date().toDateString()}`,
              `</env>`,
            ].join("\n"),
          ]
        },
        skills(agent: Agent.Info, input?: string, sessionID?: SessionID) {
          return Effect.gen(function* () {
            if (Permission.disabled(["skill"], agent.permission).has("skill")) return
            const conf = yield* cfg.get()
            const list = yield* skill.available(agent)
            // BM25 first-pass: when autoskill is enabled, ask the BM25 index
            // for the top-5 matches. If it returns nothing (cold start, or a
            // query whose tokens are all corpus-absent / stopword-only) we
            // fall back to the legacy substring `recommend()` scorer so the
            // system prompt still ships with at least one hint.
            let picks: Skill.Info[] = []
            if (conf.autoskill !== false && input && input.trim().length > 0) {
              const hits = yield* skill.search(input, 5)
              picks = hits.slice(0, 3).map((h) => h.skill)
              if (picks.length === 0) {
                picks = recommend({ text: input, list }).slice(0, 3)
              }
            }

            // Env-var dependency resolution. Before any picked skill is
            // mentioned in the system prompt, walk each one's frontmatter
            // `dependencies.tools: [{type: "env_var", value}]` block and
            // prompt the user via the Question service for any missing
            // values. Answers are cached per-session (never on disk) so
            // secrets stay out of the rollout. When the call-site doesn't
            // hand us a `sessionID` (e.g. title-generation, unit tests) we
            // silently skip — there's no shell to prompt through anyway.
            if (sessionID && picks.length > 0) {
              yield* Effect.forEach(
                picks,
                (pick) =>
                  envDeps
                    .resolveSkillDependenciesForTurn({ sessionID, skill: pick })
                    .pipe(Effect.ignore),
                { concurrency: "unbounded", discard: true },
              )
            }

            return [
              "Skills provide specialized instructions and workflows for specific tasks.",
              "Use the skill tool to load a skill when a task matches its description.",
              ...(picks.length
                ? [
                    "Auto-skill hints: the following skills appear relevant to the current request.",
                    ...picks.map((skill) => `- ${skill.name}: ${skill.description}`),
                  ]
                : []),
              Skill.fmt(list, { verbose: true }),
            ].join("\n")
          })
        },
      }

      return Service.of(api)
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(SkillEnvDeps.defaultLayer),
  )
}
