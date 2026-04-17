import { describe, expect, test } from "bun:test"
import { extractFromTurn, yamlSafeScalar, collectToolCallsFromParts } from "../../src/skill/extractor"
import type { MessageV2 } from "../../src/session/message-v2"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function successfulShellTurn(n: number) {
  const turnId = `turn-${n}`
  return {
    turnId,
    userPrompt: "Run the three build verification steps and push a commit",
    modelResponse: "Done.",
    toolCalls: Array.from({ length: n }).map((_, i) => ({
      toolName: "shell",
      argumentsSummary: `cargo test --workspace --step ${i + 1}`,
      success: true,
    })),
  }
}

describe("skill/extractor", () => {
  // ---- threshold gates -----------------------------------------------------

  test("skips turns with fewer than minToolCalls", () => {
    const out = extractFromTurn(successfulShellTurn(2))
    expect(out).toEqual([])
  })

  test("skips turns below success-rate threshold", () => {
    const input = successfulShellTurn(5)
    // Mark two failures — 3/5 = 0.6 < 0.8 default.
    input.toolCalls[0].success = false
    input.toolCalls[1].success = false
    const out = extractFromTurn(input)
    expect(out).toEqual([])
  })

  test("emits a candidate when thresholds pass", () => {
    const out = extractFromTurn(successfulShellTurn(5))
    expect(out.length).toBe(1)
    const c = out[0]
    expect(c.suggestedName).toMatch(/^[a-z0-9-]+$/)
    expect(c.suggestedName.length).toBeLessThanOrEqual(50)
    expect(c.confidence).toBeGreaterThan(0.5)
    expect(c.executionMode).toBe("Automated") // shell dominates
    expect(c.content).toContain("---")
    expect(c.content).toContain("# ")
    expect(c.content).toContain("## Steps")
  })

  // ---- confidence ----------------------------------------------------------

  test("confidence lifts with more repeat calls", () => {
    const small = extractFromTurn(successfulShellTurn(3))
    const large = extractFromTurn(successfulShellTurn(10))
    expect(large[0].confidence).toBeGreaterThan(small[0].confidence)
  })

  test("confidence is in [0,1]", () => {
    const out = extractFromTurn(successfulShellTurn(50))
    expect(out[0].confidence).toBeGreaterThanOrEqual(0)
    expect(out[0].confidence).toBeLessThanOrEqual(1)
  })

  // ---- execution-mode inference --------------------------------------------

  test("reference mode when only read/search tools used", () => {
    const out = extractFromTurn({
      turnId: "t",
      userPrompt: "Survey the snapshot module",
      modelResponse: "",
      toolCalls: [
        { toolName: "read_file", argumentsSummary: "src/snapshot/index.ts", success: true },
        { toolName: "search_files", argumentsSummary: "snapshot.track", success: true },
        { toolName: "list_files", argumentsSummary: "src/snapshot", success: true },
      ],
    })
    expect(out[0].executionMode).toBe("Reference")
  })

  test("automated mode when apply_patch present", () => {
    const out = extractFromTurn({
      turnId: "t",
      userPrompt: "Apply the header fix",
      modelResponse: "",
      toolCalls: [
        { toolName: "read_file", argumentsSummary: "src/header.ts", success: true },
        { toolName: "apply_patch", argumentsSummary: "*** Update File: src/header.ts", success: true },
        { toolName: "shell", argumentsSummary: "bun test", success: true },
      ],
    })
    expect(out[0].executionMode).toBe("Automated")
  })

  // ---- name & description --------------------------------------------------

  test("kebab-case name is capped at 50 chars", () => {
    const out = extractFromTurn({
      ...successfulShellTurn(5),
      userPrompt:
        "Please run the entire end-to-end integration test suite and collect the metrics artifacts",
    })
    expect(out[0].suggestedName.length).toBeLessThanOrEqual(50)
    expect(out[0].suggestedName).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  test("description folds multiple tools", () => {
    const out = extractFromTurn({
      turnId: "t",
      userPrompt: "Apply a patch and re-run tests",
      modelResponse: "",
      toolCalls: [
        { toolName: "read_file", argumentsSummary: "a.ts", success: true },
        { toolName: "apply_patch", argumentsSummary: "*** Update", success: true },
        { toolName: "shell", argumentsSummary: "bun test", success: true },
      ],
    })
    expect(out[0].suggestedDescription).toContain("(uses")
  })

  test("empty prompt falls back to tool arguments for name", () => {
    const out = extractFromTurn({
      ...successfulShellTurn(5),
      userPrompt: "",
    })
    expect(out[0].suggestedName.length).toBeGreaterThan(0)
  })

  // ---- YAML escaping -------------------------------------------------------

  test("yaml-safe escapes colons, newlines, and quotes", () => {
    expect(yamlSafeScalar("plain-name")).toBe("plain-name")
    // Contains colon → must be quoted
    expect(yamlSafeScalar("oh no: a colon")).toContain('"')
    expect(yamlSafeScalar("has \"quote\"")).toContain("\\\"")
    expect(yamlSafeScalar("multi\nline")).toContain("\\n")
    // YAML reserved → must be quoted
    expect(yamlSafeScalar("yes")).toBe('"yes"')
    expect(yamlSafeScalar("null")).toBe('"null"')
  })

  test("SKILL.md with colon in description parses as valid frontmatter", () => {
    const out = extractFromTurn({
      ...successfulShellTurn(5),
      userPrompt: "Spawn 3 parallel agents: agent 1 does X, agent 2 does Y",
    })
    // Frontmatter should not contain unquoted colons after `description:`.
    const fm = out[0].content.match(/^---\n([\s\S]*?)\n---/)
    expect(fm).toBeTruthy()
    const body = fm![1]
    // description line should be emitted as a quoted scalar because the
    // source contains colons.
    expect(body).toMatch(/^description: "/m)
  })

  // ---- adapter -------------------------------------------------------------

  test("collectToolCallsFromParts maps completed/error states correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        type: "tool",
        tool: "bash",
        callID: "1",
        id: "p1" as any,
        messageID: "m1" as any,
        sessionID: "s1" as any,
        state: {
          status: "completed",
          input: { command: "echo hi" },
          output: "hi",
          title: "echo",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
      {
        type: "tool",
        tool: "shell",
        callID: "2",
        id: "p2" as any,
        messageID: "m1" as any,
        sessionID: "s1" as any,
        state: {
          status: "error",
          input: { command: "false" },
          error: "exit 1",
          time: { start: 0, end: 1 },
        },
      },
      // pending part should be skipped
      {
        type: "tool",
        tool: "shell",
        callID: "3",
        id: "p3" as any,
        messageID: "m1" as any,
        sessionID: "s1" as any,
        state: { status: "pending", input: {}, raw: "" },
      },
    ]
    const calls = collectToolCallsFromParts(parts)
    expect(calls.length).toBe(2)
    expect(calls[0].toolName).toBe("shell") // bash → shell canonical
    expect(calls[0].success).toBe(true)
    expect(calls[0].argumentsSummary).toBe("echo hi")
    expect(calls[1].success).toBe(false)
  })

  test("completed output that looks like an error is marked as failure", () => {
    const parts: MessageV2.Part[] = [
      {
        type: "tool",
        tool: "shell",
        callID: "1",
        id: "p1" as any,
        messageID: "m1" as any,
        sessionID: "s1" as any,
        state: {
          status: "completed",
          input: { command: "missing-binary" },
          output: "Error: command not found",
          title: "missing-binary",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ]
    const calls = collectToolCallsFromParts(parts)
    expect(calls[0].success).toBe(false)
  })
})
