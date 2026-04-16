import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"
import { Config } from "../config/config"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

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
    readonly skills: (agent: Agent.Info, input?: string) => Effect.Effect<string | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const cfg = yield* Config.Service

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
        skills(agent: Agent.Info, input?: string) {
          return Effect.gen(function* () {
            if (Permission.disabled(["skill"], agent.permission).has("skill")) return
            const conf = yield* cfg.get()
            const list = yield* skill.available(agent)
            const picks = conf.autoskill === false ? [] : recommend({ text: input, list }).slice(0, 3)
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

  export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer), Layer.provide(Config.defaultLayer))
}
