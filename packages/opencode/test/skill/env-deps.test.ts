import { describe, expect, test } from "bun:test"
import { collectEnvVarDependencies } from "../../src/skill/env-deps"

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
