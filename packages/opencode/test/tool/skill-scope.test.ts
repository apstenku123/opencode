import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { skillScope } from "../../src/tool/skill"

describe("tool/skill - skillScope", () => {
  test("auto-skills dir maps to 'auto'", () => {
    const loc = path.join(Global.Path.data, "skills", "auto", "demo.md")
    expect(skillScope(loc)).toBe("auto")
  })

  test("user data dir (non-auto) maps to 'global'", () => {
    const loc = path.join(Global.Path.data, "some-pkg", "SKILL.md")
    expect(skillScope(loc)).toBe("global")
  })

  test("workspace project path maps to 'project'", () => {
    expect(skillScope("/tmp/repo/.opencode/skill/demo/SKILL.md")).toBe("project")
  })
})
