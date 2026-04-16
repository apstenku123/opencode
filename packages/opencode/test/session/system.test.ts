import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const run = Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(build!)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

          const first = await Effect.runPromise(run)
          const second = await Effect.runPromise(run)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("recommend returns matching skills for request text", () => {
    const list = [
      {
        name: "timer",
        description: "Manage timers and recurring checks.",
        location: "/tmp/timer/SKILL.md",
        content: "Create or manage timers.",
      },
      {
        name: "kb",
        description: "Work with durable history and knowledge retrieval.",
        location: "/tmp/kb/SKILL.md",
        content: "Knowledge base and history analytics.",
      },
      {
        name: "shell",
        description: "Run shell commands.",
        location: "/tmp/shell/SKILL.md",
        content: "Plain shell usage.",
      },
    ]

    expect(SystemPrompt.recommend({ text: "set a recurring timer and check history kb", list }).map((x) => x.name)).toEqual([
      "timer",
      "kb",
    ])
  })

  test("recommend prefers stronger name and description matches", () => {
    const list = [
      {
        name: "shell",
        description: "Run shell commands.",
        location: "/tmp/shell/SKILL.md",
        content: "Plain shell usage.",
      },
      {
        name: "timer",
        description: "Manage timers and recurring checks.",
        location: "/tmp/timer/SKILL.md",
        content: "Create or manage timers with repeated checks.",
      },
      {
        name: "timelines",
        description: "Inspect time-based history views.",
        location: "/tmp/timelines/SKILL.md",
        content: "Timeline rendering only.",
      },
    ]

    expect(SystemPrompt.recommend({ text: "set a recurring timer", list }).map((x) => x.name)).toEqual([
      "timer",
    ])
  })

  test("recommend returns empty list when request text is missing", () => {
    const list = [
      {
        name: "timer",
        description: "Manage timers and recurring checks.",
        location: "/tmp/timer/SKILL.md",
        content: "Create or manage timers.",
      },
    ]

    expect(SystemPrompt.recommend({ list }).map((x) => x.name)).toEqual([])
  })

  test("skills output omits auto-skill hints when nothing matches", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "timer")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: timer
description: Manage timers and recurring checks.
---

Create or manage timers.
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const out = await Effect.runPromise(
            Effect.gen(function* () {
              const svc = yield* SystemPrompt.Service
              return yield* svc.skills(build!, "write a poem about clouds")
            }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
          )

          expect(out).not.toContain("Auto-skill hints")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("skills output includes auto-skill hints when request matches", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description, content] of [
          ["timer", "Manage timers and recurring checks.", "Create or manage timers."],
          ["kb", "Work with durable history and knowledge retrieval.", "Knowledge base and history analytics."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

${content}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const out = await Effect.runPromise(
            Effect.gen(function* () {
              const svc = yield* SystemPrompt.Service
              return yield* svc.skills(build!, "please set a recurring timer and consult kb history")
            }).pipe(Effect.provide(SystemPrompt.defaultLayer)),
          )

          expect(out).toContain("Auto-skill hints")
          expect(out).toContain("- timer: Manage timers and recurring checks.")
          expect(out).toContain("- kb: Work with durable history and knowledge retrieval.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("skills output skips auto-skill hints when config disables autoskill", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ autoskill: false }, null, 2),
        )
        for (const [name, description, content] of [
          ["timer", "Manage timers and recurring checks.", "Create or manage timers."],
          ["kb", "Work with durable history and knowledge retrieval.", "Knowledge base and history analytics."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

${content}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const out = await Effect.runPromise(
            Effect.gen(function* () {
              const svc = yield* SystemPrompt.Service
              return yield* svc.skills(build!, "please set a recurring timer and consult kb history")
            }).pipe(Effect.provide(SystemPrompt.defaultLayer), Effect.provide(Config.defaultLayer)),
          )

          expect(out).not.toContain("Auto-skill hints")
          expect(out).toContain("<name>timer</name>")
          expect(out).toContain("<name>kb</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
