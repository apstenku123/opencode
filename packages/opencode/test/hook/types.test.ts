/**
 * Unit tests for Hook types — matcher target selection and wire
 * serialization. Mirrors the parity tests in `codex-rs/hooks/src/types.rs`.
 */
import { describe, expect, test } from "bun:test"
import { matchTargetFor, serializeHookPayload, HookPayload } from "../../src/hook/types"
import type { HookEvent } from "../../src/hook/types"

describe("Hook.matchTargetFor", () => {
  test("tool-name events match on tool_name", () => {
    const e: HookEvent = {
      hook_event_name: "PreToolUse",
      tool_name: "shell",
      tool_input: {},
    }
    expect(matchTargetFor(e)).toBe("shell")
  })

  test("Notification matches on notification_type", () => {
    const e: HookEvent = {
      hook_event_name: "Notification",
      message: "hi",
      notification_type: "warning",
    }
    expect(matchTargetFor(e)).toBe("warning")
  })

  test("SessionStart matches on source", () => {
    const e: HookEvent = { hook_event_name: "SessionStart", source: "resume", model: "m" }
    expect(matchTargetFor(e)).toBe("resume")
  })

  test("SessionEnd matches on reason", () => {
    const e: HookEvent = { hook_event_name: "SessionEnd", reason: "timeout" }
    expect(matchTargetFor(e)).toBe("timeout")
  })

  test("SubagentStart/Stop match on agent_type", () => {
    expect(
      matchTargetFor({
        hook_event_name: "SubagentStart",
        agent_id: "a",
        agent_type: "coding",
      }),
    ).toBe("coding")
    expect(
      matchTargetFor({
        hook_event_name: "SubagentStop",
        stop_hook_active: false,
        agent_id: "a",
        agent_type: "review",
      }),
    ).toBe("review")
  })

  test("PreCompact matches on trigger", () => {
    expect(
      matchTargetFor({
        hook_event_name: "PreCompact",
        trigger: "auto",
        custom_instructions: "",
      }),
    ).toBe("auto")
  })

  test("Stop matches on last_assistant_message", () => {
    expect(
      matchTargetFor({
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "done.",
      }),
    ).toBe("done.")
  })

  test("UserPromptSubmit / AfterAgent / Worktree events have no target", () => {
    expect(
      matchTargetFor({ hook_event_name: "UserPromptSubmit", prompt: "hi" }),
    ).toBeUndefined()
    expect(
      matchTargetFor({
        hook_event_name: "WorktreeCreate",
        name: "feat/a",
      }),
    ).toBeUndefined()
  })

  test("TurnStart / UserMessage / AssistantMessage have no target", () => {
    expect(
      matchTargetFor({ hook_event_name: "TurnStart", turn_id: "t1" }),
    ).toBeUndefined()
    expect(
      matchTargetFor({
        hook_event_name: "UserMessage",
        turn_id: "t1",
        message_id: "m1",
        text: "hi",
      }),
    ).toBeUndefined()
    expect(
      matchTargetFor({
        hook_event_name: "AssistantMessage",
        turn_id: "t1",
        message_id: "m2",
        text: "ok",
      }),
    ).toBeUndefined()
  })

  test("TurnStop matches on finish_reason", () => {
    expect(
      matchTargetFor({
        hook_event_name: "TurnStop",
        turn_id: "t1",
        iterations: 3,
        finish_reason: "stop",
      }),
    ).toBe("stop")
  })
})

describe("Hook.serializeHookPayload", () => {
  test("flattens hook_event fields to the wire root (matches Rust shape)", () => {
    const payload: HookPayload = {
      session_id: "s-1",
      agent_level: 0,
      session_context: { source: "cli" },
      cwd: "/tmp",
      triggered_at: "2025-01-01T00:00:00Z",
      hook_event: {
        hook_event_name: "PreToolUse",
        tool_name: "shell",
        tool_input: { cmd: "ls" },
      },
    }
    const wire = serializeHookPayload(payload)
    expect(wire.session_id).toBe("s-1")
    expect(wire.hook_event_name).toBe("PreToolUse")
    expect(wire.tool_name).toBe("shell")
    // hook_event key itself should not appear at the root.
    expect((wire as Record<string, unknown>).hook_event).toBeUndefined()
  })

  test("turn lifecycle events flatten turn_id alongside session_id", () => {
    const base = {
      session_id: "s-1",
      agent_level: 0,
      session_context: { source: "cli" as const },
      cwd: "/tmp",
      triggered_at: "2025-01-01T00:00:00Z",
    }
    const turnStart = serializeHookPayload({
      ...base,
      hook_event: { hook_event_name: "TurnStart", turn_id: "t-1" },
    })
    expect(turnStart.hook_event_name).toBe("TurnStart")
    expect(turnStart.turn_id).toBe("t-1")
    expect(turnStart.session_id).toBe("s-1")

    const userMsg = serializeHookPayload({
      ...base,
      hook_event: {
        hook_event_name: "UserMessage",
        turn_id: "t-1",
        message_id: "m-1",
        text: "hello",
      },
    })
    expect(userMsg.text).toBe("hello")
    expect(userMsg.message_id).toBe("m-1")

    const assistantMsg = serializeHookPayload({
      ...base,
      hook_event: {
        hook_event_name: "AssistantMessage",
        turn_id: "t-1",
        message_id: "m-2",
        text: "world",
        tool_calls: ["bash", "read"],
      },
    })
    expect(assistantMsg.tool_calls).toEqual(["bash", "read"])

    const turnStop = serializeHookPayload({
      ...base,
      hook_event: {
        hook_event_name: "TurnStop",
        turn_id: "t-1",
        iterations: 2,
        finish_reason: "stop",
      },
    })
    expect(turnStop.iterations).toBe(2)
    expect(turnStop.finish_reason).toBe("stop")
  })
})
