/**
 * Skill env-var dependency resolution.
 *
 * Port of `codex-rs/core/src/skills/env_var_dependencies.rs`. The `Skill.Info`
 * frontmatter may declare `dependencies.tools: [{type:"env_var", value, description}]`.
 * Before injecting a skill into a turn we:
 *
 *   1. Collect all `env_var` deps across the explicitly mentioned skills.
 *   2. Skip any whose value is already in the per-session cache.
 *   3. Skip any present in the process env (`process.env`).
 *   4. Prompt the user for the rest via the Question service.
 *   5. Cache answers for the lifetime of the session.
 *
 * The cache is keyed by `sessionID`. There is no on-disk persistence —
 * answers are intentionally ephemeral so secrets never hit the rollout.
 */

import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect"
import { Question } from "@/question"
import type { SessionID } from "@/session/schema"
import { Log } from "@/util"
import z from "zod"
import type { Info as SkillInfo } from "./index"

const log = Log.create({ service: "skill.env-deps" })

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const EnvVarDependency = z.object({
  type: z.literal("env_var"),
  value: z.string(),
  description: z.string().optional(),
})
export type EnvVarDependency = z.infer<typeof EnvVarDependency>

export const SkillDependencies = z.object({
  tools: z.array(EnvVarDependency).optional(),
})
export type SkillDependencies = z.infer<typeof SkillDependencies>

export interface SkillDependencyInfo {
  skillName: string
  /** The env-var name. */
  name: string
  description?: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Walk the skills' frontmatter dependency lists and dedupe by env-var name.
 * Mirrors Rust's `collect_env_var_dependencies`.
 */
export function collectEnvVarDependencies(
  skills: { name: string; dependencies?: SkillDependencies }[],
): SkillDependencyInfo[] {
  const out: SkillDependencyInfo[] = []
  const seen = new Set<string>()
  for (const skill of skills) {
    const tools = skill.dependencies?.tools ?? []
    for (const tool of tools) {
      if (tool.type !== "env_var") continue
      if (!tool.value) continue
      if (seen.has(tool.value)) continue
      seen.add(tool.value)
      out.push({
        skillName: skill.name,
        name: tool.value,
        description: tool.description,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Read-only view of the cached env vars for `sessionID`. New entries land
   * here as the user answers prompts.
   */
  readonly snapshot: (sessionID: SessionID) => Effect.Effect<Record<string, string>>
  /**
   * Resolve every dependency reachable from `skill` for the given session,
   * prompting the user for any value not already cached or present in
   * `process.env`. Returns the final per-session map. Safe to call multiple
   * times in a turn — already-resolved keys short-circuit.
   */
  readonly resolveSkillDependenciesForTurn: (input: {
    sessionID: SessionID
    skill: SkillInfo & { dependencies?: SkillDependencies }
  }) => Effect.Effect<Record<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillEnvDeps") {}

type State = {
  /** sessionID -> { envVarName -> value } */
  bySession: Map<SessionID, Map<string, string>>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const question = yield* Question.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("SkillEnvDeps.state")(function* () {
        return { bySession: new Map() }
      }),
    )

    const cacheFor = (s: State, sessionID: SessionID) => {
      let inner = s.bySession.get(sessionID)
      if (!inner) {
        inner = new Map()
        s.bySession.set(sessionID, inner)
      }
      return inner
    }

    const snapshot = Effect.fn("SkillEnvDeps.snapshot")(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      const inner = s.bySession.get(sessionID)
      if (!inner) return {} as Record<string, string>
      return Object.fromEntries(inner.entries())
    })

    const resolveSkillDependenciesForTurn = Effect.fn("SkillEnvDeps.resolve")(function* (input: {
      sessionID: SessionID
      skill: SkillInfo & { dependencies?: SkillDependencies }
    }) {
      const s = yield* InstanceState.get(state)
      const cache = cacheFor(s, input.sessionID)
      const deps = collectEnvVarDependencies([{ name: input.skill.name, dependencies: input.skill.dependencies }])
      if (deps.length === 0) return Object.fromEntries(cache.entries())

      const missing: SkillDependencyInfo[] = []
      for (const dep of deps) {
        if (cache.has(dep.name)) continue
        const fromEnv = process.env[dep.name]
        if (typeof fromEnv === "string" && fromEnv.length > 0) {
          cache.set(dep.name, fromEnv)
          continue
        }
        missing.push(dep)
      }

      if (missing.length === 0) return Object.fromEntries(cache.entries())

      // Build prompts and ask. Each missing dep becomes one question.
      const prompts: Question.Info[] = missing.map((dep) => {
        const requirement = dep.description
          ? `The skill "${dep.skillName}" requires "${dep.name}" to be set (${dep.description}).`
          : `The skill "${dep.skillName}" requires "${dep.name}" to be set.`
        return {
          question: `${requirement} Provide a value (stored in memory for this session only).`,
          header: "Skill env var",
          options: [],
          custom: true,
          multiple: false,
        } as Question.Info
      })

      const answers = yield* question
        .ask({ sessionID: input.sessionID, questions: prompts })
        .pipe(
          Effect.catch((err) => {
            log.warn("user dismissed skill dependency prompt", { skill: input.skill.name, err })
            return Effect.succeed([] as readonly Question.Answer[])
          }),
        )

      missing.forEach((dep, i) => {
        const ans = answers[i]
        if (!ans) return
        const value = ans.find((entry) => entry.length > 0)
        if (!value) return
        cache.set(dep.name, value)
      })

      return Object.fromEntries(cache.entries())
    })

    return Service.of({ snapshot, resolveSkillDependenciesForTurn })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Question.defaultLayer))

export * as SkillEnvDeps from "./env-deps"
