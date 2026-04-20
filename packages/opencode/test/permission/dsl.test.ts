import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { DSL } from "../../src/permission/dsl"
import { Permission } from "../../src/permission"

// ---- parser ------------------------------------------------------------

describe("DSL.parse", () => {
  test("parses minimal YAML policy", () => {
    const raw = DSL.parse(`
version: 1
rules:
  - match: { tool: bash, command: "git *" }
    action: allow
`)
    expect(raw.version).toBe(1)
    expect(raw.rules).toHaveLength(1)
    expect(raw.rules[0].action).toBe("allow")
    expect(raw.rules[0].match.tool).toBe("bash")
    expect(raw.rules[0].match.command).toBe("git *")
  })

  test("parses JSONC policy", () => {
    const raw = DSL.parse(
      `{
        // top comment
        "version": 1,
        "rules": [
          { "match": { "tool": "bash", "command": "ls *" }, "action": "allow" },
        ]
      }`,
    )
    expect(raw.rules).toHaveLength(1)
    expect(raw.rules[0].match.command).toBe("ls *")
  })

  test("rejects unknown match key", () => {
    expect(() => DSL.parse(`version: 1\nrules: [{ match: { bogus: x }, action: allow }]`)).toThrow(/not a recognized key/)
  })

  test("rejects unknown action", () => {
    expect(() => DSL.parse(`version: 1\nrules: [{ match: { tool: bash }, action: nuke }]`)).toThrow(/action must be/)
  })

  test("rejects unsupported version", () => {
    expect(() => DSL.parse(`version: 99\nrules: []`)).toThrow(/unsupported policy version/)
  })

  test("rejects mutually exclusive command + command_regex", () => {
    expect(() =>
      DSL.parse(`
version: 1
rules:
  - match: { tool: bash, command: "x", command_regex: "y" }
    action: allow
`),
    ).toThrow(/mutually exclusive/)
  })

  test("parseFromSource picks format from filename", () => {
    const raw = DSL.parseFromSource(`{"version":1,"rules":[]}`, "exec-policy.jsonc")
    expect(raw.rules).toEqual([])
  })

  test("stringify round-trips", () => {
    const raw = DSL.parse(`version: 1\nrules:\n  - match: { tool: bash }\n    action: ask`)
    const text = DSL.stringify(raw)
    const back = DSL.parse(text)
    expect(back).toEqual(raw)
  })

  test("rejects empty match block at compile time", () => {
    expect(() => DSL.load(`version: 1\nrules:\n  - match: {}\n    action: allow`)).toThrow(/match block is empty/)
  })
})

// ---- compiler / matcher -----------------------------------------------

describe("DSL.compile + match", () => {
  test("matches bash command glob", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "git *" }
    action: allow
`)
    const decision = DSL.match(policy, { tool: "bash", command: "git status" })
    expect(decision?.action).toBe("allow")
  })

  test("non-matching bash returns undefined", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "git *" }
    action: allow
`)
    const decision = DSL.match(policy, { tool: "bash", command: "rm foo" })
    expect(decision).toBeUndefined()
  })

  test("last-matching rule wins", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "*" }
    action: allow
  - match: { tool: bash, command: "rm *" }
    action: deny
`)
    expect(DSL.match(policy, { tool: "bash", command: "rm -rf /" })?.action).toBe("deny")
    expect(DSL.match(policy, { tool: "bash", command: "ls" })?.action).toBe("allow")
  })

  test("regex pattern works", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command_regex: "^rm\\\\s+-rf" }
    action: deny
`)
    expect(DSL.match(policy, { tool: "bash", command: "rm -rf /" })?.action).toBe("deny")
    expect(DSL.match(policy, { tool: "bash", command: "ls" })).toBeUndefined()
  })

  test("rejects ReDoS-looking regex at compile time", () => {
    expect(() =>
      DSL.load(`version: 1
rules:
  - match: { tool: bash, command_regex: ".*.*" }
    action: deny
`),
    ).toThrow(/ReDoS/i)
  })

  test("path glob matches files", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: edit, path: "src/**/*.ts" }
    action: allow
`)
    expect(DSL.match(policy, { tool: "edit", path: "src/foo/bar.ts" })?.action).toBe("allow")
    expect(DSL.match(policy, { tool: "edit", path: "test/foo.ts" })).toBeUndefined()
  })

  test("cwd_under constrains rule", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "*", cwd_under: "/repo/allow" }
    action: allow
`)
    expect(DSL.match(policy, { tool: "bash", command: "ls", cwd: "/repo/allow/sub" })?.action).toBe("allow")
    expect(DSL.match(policy, { tool: "bash", command: "ls", cwd: "/repo/deny" })).toBeUndefined()
  })

  test("cwd_under requires absolute path", () => {
    expect(() =>
      DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "*", cwd_under: "relative/path" }
    action: allow
`),
    ).toThrow(/absolute path/)
  })

  test("tool wildcard matches anything", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: "*", command: "dangerous" }
    action: deny
`)
    expect(DSL.match(policy, { tool: "bash", command: "dangerous" })?.action).toBe("deny")
    expect(DSL.match(policy, { tool: "task", command: "dangerous" })?.action).toBe("deny")
  })

  test("matchMany returns all hits in source order", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "*" }
    action: ask
  - match: { tool: bash, command: "git *" }
    action: allow
`)
    const hits = DSL.matchMany(policy, { tool: "bash", command: "git status" })
    expect(hits).toHaveLength(2)
    expect(hits[0].action).toBe("ask")
    expect(hits[1].action).toBe("allow")
  })

  test("EMPTY policy yields no decisions", () => {
    expect(DSL.match(DSL.EMPTY, { tool: "bash", command: "ls" })).toBeUndefined()
    expect(DSL.decide(DSL.EMPTY, { tool: "bash", command: "ls" })).toBeUndefined()
  })

  test("decide returns undefined for undefined policy", () => {
    expect(DSL.decide(undefined, { tool: "bash", command: "ls" })).toBeUndefined()
  })

  test("explain produces readable diagnostics", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "ls *", description: "list-only" }
    action: allow
`)
    const decision = DSL.match(policy, { tool: "bash", command: "ls -la" })
    const msg = DSL.explain(decision, { tool: "bash", command: "ls -la" })
    expect(msg).toContain("allow")
    expect(msg).toContain("rule #0")
    const msg2 = DSL.explain(undefined, { tool: "bash", command: "nope" })
    expect(msg2).toContain("no DSL rule matched")
  })

  test("ReDoS guard short-circuits on enormous input", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command_regex: "x" }
    action: deny
`)
    // 16KB input — over MAX_TEST_INPUT (8KB). Should NOT match (guard returns false).
    const big = "x".repeat(16 * 1024)
    const decision = DSL.match(policy, { tool: "bash", command: big })
    expect(decision).toBeUndefined()
  })
})

// ---- integration with Permission.evaluateWithDSL ----------------------

describe("Permission.evaluateWithDSL", () => {
  test("DSL decision overrides ruleset", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "rm *" }
    action: deny
`)
    const ruleset: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const rule = Permission.evaluateWithDSL(
      "bash",
      "rm -rf /",
      { tool: "bash", command: "rm -rf /" },
      policy,
      ruleset,
    )
    expect(rule.action).toBe("deny")
  })

  test("falls back to ruleset when DSL has no match", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "git *" }
    action: allow
`)
    const ruleset: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
    const rule = Permission.evaluateWithDSL(
      "bash",
      "rm foo",
      { tool: "bash", command: "rm foo" },
      policy,
      ruleset,
    )
    expect(rule.action).toBe("ask")
  })

  test("undefined policy behaves like plain evaluate", () => {
    const ruleset: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const rule = Permission.evaluateWithDSL("bash", "ls", undefined, undefined, ruleset)
    expect(rule.action).toBe("allow")
  })

  test("undefined invocation forces ruleset fallback", () => {
    const policy = DSL.load(`version: 1
rules:
  - match: { tool: bash, command: "*" }
    action: deny
`)
    const ruleset: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
    const rule = Permission.evaluateWithDSL("bash", "ls", undefined, policy, ruleset)
    expect(rule.action).toBe("allow")
  })
})
