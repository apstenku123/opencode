import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { collectEnvVarDependencies, SkillEnvDeps } from "../../src/skill/env-deps"
import { Question } from "../../src/question"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

describe("skill/env-deps", () => {
  test("collects only env_var entries with non-empty values", () => {
    const deps = collectEnvVarDependencies([
      {
        name: "skill-a",
        dependencies: {
          tools: [
            { type: "env_var", value: "API_KEY", description: "API token" },
            { type: "env_var", value: "" }, // dropped
          ],
        },
      },
      {
        name: "skill-b",
        dependencies: {
          tools: [{ type: "env_var", value: "OTHER" }],
        },
      },
    ])
    expect(deps).toEqual([
      { skillName: "skill-a", name: "API_KEY", description: "API token" },
      { skillName: "skill-b", name: "OTHER", description: undefined },
    ])
  })

  test("dedupes by env-var name across multiple skills", () => {
    const deps = collectEnvVarDependencies([
      { name: "a", dependencies: { tools: [{ type: "env_var", value: "GH_TOKEN" }] } },
      { name: "b", dependencies: { tools: [{ type: "env_var", value: "GH_TOKEN" }] } },
    ])
    expect(deps.length).toBe(1)
    expect(deps[0].name).toBe("GH_TOKEN")
  })

  test("returns empty when no skill declares dependencies", () => {
    const deps = collectEnvVarDependencies([{ name: "a" }, { name: "b", dependencies: { tools: [] } }])
    expect(deps).toEqual([])
  })
})

describe("skill/env-deps - service", () => {
  const layer = Layer.mergeAll(
    SkillEnvDeps.layer.pipe(Layer.provide(Question.layer.pipe(Layer.provide(Bus.layer)))),
    CrossSpawnSpawner.defaultLayer,
  )

  test("resolveSkillDependenciesForTurn pulls values from process.env", async () => {
    const prev = process.env["OPENCODE_TEST_ENV_SAMPLE"]
    process.env["OPENCODE_TEST_ENV_SAMPLE"] = "hello-world"
    try {
      const sessionID = SessionID.make("ses_env_deps_test")
      const resolved = await Effect.runPromise(
        provideTmpdirInstance((_dir) =>
          Effect.gen(function* () {
            const svc = yield* SkillEnvDeps.Service
            return yield* svc.resolveSkillDependenciesForTurn({
              sessionID,
              skill: {
                name: "env-demo",
                description: "demo",
                location: "/tmp/demo/SKILL.md",
                content: "",
                dependencies: {
                  tools: [{ type: "env_var", value: "OPENCODE_TEST_ENV_SAMPLE" }],
                },
              },
            })
          }),
        ).pipe(Effect.provide(layer), Effect.scoped),
      )
      expect(resolved["OPENCODE_TEST_ENV_SAMPLE"]).toBe("hello-world")
    } finally {
      if (prev === undefined) delete process.env["OPENCODE_TEST_ENV_SAMPLE"]
      else process.env["OPENCODE_TEST_ENV_SAMPLE"] = prev
      await Instance.disposeAll()
    }
  })

  test("skills with no dependencies return an empty map", async () => {
    try {
      const sessionID = SessionID.make("ses_env_deps_empty")
      const resolved = await Effect.runPromise(
        provideTmpdirInstance((_dir) =>
          Effect.gen(function* () {
            const svc = yield* SkillEnvDeps.Service
            return yield* svc.resolveSkillDependenciesForTurn({
              sessionID,
              skill: {
                name: "no-deps",
                description: "demo",
                location: "/tmp/demo/SKILL.md",
                content: "",
              },
            })
          }),
        ).pipe(Effect.provide(layer), Effect.scoped),
      )
      expect(resolved).toEqual({})
    } finally {
      await Instance.disposeAll()
    }
  })
})
