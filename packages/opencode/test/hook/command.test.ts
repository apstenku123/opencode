/**
 * Unit tests for the pure output interpreter
 * ({@link Hook.interpretOutput}). Uses synthetic `{stdout, stderr, exitCode}`
 * tuples to cover each branch of the hook-spec semantics without
 * spawning real subprocesses.
 */
import { describe, expect, test } from "bun:test"
import { interpretOutput } from "../../src/hook/command"
import type { HookEvent } from "../../src/hook/types"

const stopEvent = (): HookEvent => ({
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "ok",
})

const preToolUseEvent = (tool = "shell"): HookEvent => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { cmd: "ls" },
  tool_use_id: "call-1",
})

const permissionRequestEvent = (): HookEvent => ({
  hook_event_name: "PermissionRequest",
  tool_name: "request_permissions",
  tool_input: {},
})

const postToolUseEvent = (): HookEvent => ({
  hook_event_name: "PostToolUse",
  tool_name: "mcp_tool",
  tool_input: {},
  tool_response: { ok: true },
  tool_use_id: "call-x",
})

const sessionStartEvent = (): HookEvent => ({
  hook_event_name: "SessionStart",
  source: "startup",
  model: "test",
})

describe("Hook.interpretOutput — exit codes", () => {
  test("exit 0 with empty stdout is a no-op Success", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: { stdout: "", stderr: "", exitCode: 0 },
    })
    expect(r.kind).toBe("success")
  })

  test("exit 2 maps to FailedAbort with stderr message", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: { stdout: "", stderr: "blocked by policy", exitCode: 2 },
    })
    expect(r.kind).toBe("failed_abort")
    if (r.kind !== "failed_abort") throw new Error()
    expect(r.error).toBe("blocked by policy")
  })

  test("non-zero non-2 exit maps to FailedContinue", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: { stdout: "", stderr: "warning", exitCode: 1 },
    })
    expect(r.kind).toBe("failed_continue")
  })
})

describe("Hook.interpretOutput — decision and continue", () => {
  test('decision: "block" → FailedAbort', () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: {
        stdout: JSON.stringify({ decision: "block", reason: "tests not passing" }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("failed_abort")
    if (r.kind !== "failed_abort") throw new Error()
    expect(r.error).toBe("tests not passing")
  })

  test("continue: false → FailedAbort", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: {
        stdout: JSON.stringify({ continue: false, stopReason: "nope" }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("failed_abort")
    if (r.kind !== "failed_abort") throw new Error()
    expect(r.error).toBe("nope")
  })
})

describe("Hook.interpretOutput — PreToolUse permissionDecision", () => {
  test('permissionDecision: "deny" → FailedAbort', () => {
    const r = interpretOutput({
      event: preToolUseEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "policy denies shell",
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("failed_abort")
  })

  test('permissionDecision: "ask" → FailedContinue (escalate)', () => {
    const r = interpretOutput({
      event: preToolUseEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "ask",
            permissionDecisionReason: "needs review",
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("failed_continue")
  })

  test('permissionDecision: "allow" + updatedInput → Success with updated_input', () => {
    const r = interpretOutput({
      event: preToolUseEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "allow",
            updatedInput: { cmd: "ls", args: ["-la"] },
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.updated_input).toEqual({ cmd: "ls", args: ["-la"] })
  })
})

describe("Hook.interpretOutput — PermissionRequest decision mapping", () => {
  test("permissionDecision maps to decision_behavior/decision_message", () => {
    const r = interpretOutput({
      event: permissionRequestEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "allow",
            permissionDecisionReason: "policy ok",
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.decision_behavior).toBe("allow")
    expect(r.decision_message).toBe("policy ok")
  })

  test("decision overrides permissionDecision when set", () => {
    const r = interpretOutput({
      event: permissionRequestEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "allow",
            decision: { behavior: "deny", message: "overridden" },
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.decision_behavior).toBe("deny")
    expect(r.decision_message).toBe("overridden")
  })

  test("decision with empty fields does NOT clobber permissionDecision", () => {
    const r = interpretOutput({
      event: permissionRequestEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "allow",
            permissionDecisionReason: "policy ok",
            decision: {},
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.decision_behavior).toBe("allow")
    expect(r.decision_message).toBe("policy ok")
  })
})

describe("Hook.interpretOutput — PostToolUse updatedMCPToolOutput", () => {
  test("routes to updated_output", () => {
    const r = interpretOutput({
      event: postToolUseEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: { updatedMCPToolOutput: { content: [] } },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.updated_output).toEqual({ content: [] })
  })

  test("updatedMCPToolOutput on non-PostToolUse is rejected", () => {
    const r = interpretOutput({
      event: preToolUseEvent(),
      captured: {
        stdout: JSON.stringify({
          hookSpecificOutput: { updatedMCPToolOutput: {} },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("failed_abort")
  })
})

describe("Hook.interpretOutput — SessionStart plain-text context", () => {
  test("plain text stdout becomes additional_context", () => {
    const r = interpretOutput({
      event: sessionStartEvent(),
      captured: { stdout: "warm the shell", stderr: "", exitCode: 0 },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.additional_context).toBe("warm the shell")
  })

  test("invalid JSON starting with { is rejected", () => {
    const r = interpretOutput({
      event: sessionStartEvent(),
      captured: { stdout: "{", stderr: "", exitCode: 0 },
    })
    expect(r.kind).toBe("failed_continue")
  })
})

describe("Hook.interpretOutput — additionalContext, systemMessage, suppressOutput", () => {
  test("top-level additionalContext", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: {
        stdout: JSON.stringify({ additionalContext: "remember the risk" }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.additional_context).toBe("remember the risk")
  })

  test("hookSpecificOutput.additionalContext wins over top-level", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: {
        stdout: JSON.stringify({
          additionalContext: "top",
          hookSpecificOutput: { additionalContext: "nested" },
        }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.additional_context).toBe("nested")
  })

  test("systemMessage + suppressOutput pass through", () => {
    const r = interpretOutput({
      event: stopEvent(),
      captured: {
        stdout: JSON.stringify({ systemMessage: "hidden", suppressOutput: true }),
        stderr: "",
        exitCode: 0,
      },
    })
    expect(r.kind).toBe("success")
    if (r.kind !== "success") throw new Error()
    expect(r.system_message).toBe("hidden")
    expect(r.suppress_output).toBe(true)
  })
})
