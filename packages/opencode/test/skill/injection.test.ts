import { describe, expect, test } from "bun:test"
import { parseSkillMentions, detectImplicitInvocation } from "../../src/skill/injection"
import type { Skill } from "../../src/skill"

const skill = (name: string, description = "", content = ""): Skill.Info => ({
  name,
  description,
  content,
  location: `/tmp/skills/${name}/SKILL.md`,
})

describe("skill/injection - parseSkillMentions", () => {
  const skills = [skill("rust-fix"), skill("docker-build"), skill("read-only")]

  test("matches bare $name mentions", () => {
    const mentions = parseSkillMentions("Please run $rust-fix on this file.", skills)
    expect(mentions.map((m) => m.skill.name)).toEqual(["rust-fix"])
    expect(mentions[0].hadExplicitPath).toBe(false)
  })

  test("matches markdown-link [$name](path) mentions", () => {
    const mentions = parseSkillMentions(
      "Use [$docker-build](skill:///tmp/skills/docker-build/SKILL.md) to ship.",
      skills,
    )
    expect(mentions[0].skill.name).toBe("docker-build")
    expect(mentions[0].hadExplicitPath).toBe(true)
  })

  test("ignores common env vars sharing a sigil prefix", () => {
    const mentions = parseSkillMentions("set $PATH and $HOME", skills)
    expect(mentions).toEqual([])
  })

  test("dedupes duplicates by first occurrence, ignores unknown names", () => {
    const mentions = parseSkillMentions("$rust-fix $rust-fix $unknown $docker-build", skills)
    expect(mentions.map((m) => m.skill.name)).toEqual(["rust-fix", "docker-build"])
  })

  test("empty text → empty list", () => {
    expect(parseSkillMentions("", skills)).toEqual([])
  })
})

describe("skill/injection - detectImplicitInvocation", () => {
  const docker = skill(
    "docker-cross-build",
    "Build cross images",
    "---\nname: docker-cross-build\ntriggers:\n  - docker buildx\n  - cross-platform image\n---\n\nbody",
  )
  const skillsList = [docker]

  test("detects script-run under <skill_dir>/scripts", () => {
    const skillDir = "/tmp/skills/docker-cross-build"
    const inv = detectImplicitInvocation(
      [{ toolName: "bash", input: { command: `bash ${skillDir}/scripts/build.sh` } }],
      skillsList,
    )
    expect(inv.length).toBe(1)
    expect(inv[0].reason).toBe("scripts-dir")
  })

  test("detects skill-doc reads via cat/head/etc", () => {
    const inv = detectImplicitInvocation(
      [{ toolName: "bash", input: { command: `cat /tmp/skills/docker-cross-build/SKILL.md` } }],
      skillsList,
    )
    expect(inv.length).toBe(1)
    expect(inv[0].reason).toBe("skill-doc")
  })

  test("detects trigger phrase in tool args", () => {
    const inv = detectImplicitInvocation(
      [{ toolName: "bash", input: { command: "docker buildx create --use" } }],
      skillsList,
    )
    expect(inv.length).toBe(1)
    expect(inv[0].reason).toBe("trigger")
  })

  test("no false-positives on plain commands", () => {
    const inv = detectImplicitInvocation(
      [{ toolName: "bash", input: { command: "ls -la" } }],
      skillsList,
    )
    expect(inv).toEqual([])
  })

  test("dedupes a skill that matches multiple signals", () => {
    const inv = detectImplicitInvocation(
      [
        { toolName: "bash", input: { command: "docker buildx ls" } },
        { toolName: "bash", input: { command: "cat /tmp/skills/docker-cross-build/SKILL.md" } },
      ],
      skillsList,
    )
    expect(inv.length).toBe(1)
  })
})
