/**
 * Unit tests for `Hook.reduceResponses` and `Hook.getCommandHooksFor`.
 */
import { describe, expect, test } from "bun:test"
import { reduceResponses, getCommandHooksFor } from "../../src/hook"
import type { Config } from "../../src/config"
import type { HookResponse } from "../../src/hook/types"

const success = (name: string, extras: Record<string, unknown> = {}): HookResponse => ({
  hook_name: name,
  result: {
    kind: "success",
    decision_interrupt: false,
    suppress_output: false,
    ...extras,
  },
})

const abort = (name: string, error: string): HookResponse => ({
  hook_name: name,
  result: { kind: "failed_abort", error },
})

describe("Hook.reduceResponses", () => {
  test("first-wins on additional_context", () => {
    const reduced = reduceResponses([
      success("h1", { additional_context: "first" }),
      success("h2", { additional_context: "second" }),
    ])
    expect(reduced.outcome).toBe("continue")
    expect(reduced.additionalContext).toBe("first")
  })

  test("abort short-circuits — later responses dropped", () => {
    const reduced = reduceResponses([
      success("h1"),
      abort("h2", "blocked"),
      success("h3", { additional_context: "ignored" }),
    ])
    expect(reduced.outcome).toBe("abort")
    expect(reduced.abortReason).toBe("blocked")
    expect(reduced.additionalContext).toBeUndefined()
  })

  test("empty responses → continue with no fields", () => {
    const reduced = reduceResponses([])
    expect(reduced.outcome).toBe("continue")
    expect(reduced.responses).toHaveLength(0)
  })
})

describe("Hook.getCommandHooksFor", () => {
  test("reads experimental.hooks.<EventName> entries", () => {
    const cfg = {
      experimental: {
        hooks: {
          PreToolUse: [
            { name: "lint", command: ["echo", "hi"], matcher: "^shell$" },
          ],
        },
      },
    } as unknown as Config.Info
    const entries = getCommandHooksFor(cfg, "PreToolUse")
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe("lint")
    expect(entries[0].matcher).toBe("^shell$")
  })

  test("merges legacy stopHooks into Stop event entries", () => {
    const cfg = {
      experimental: {
        hooks: {
          stopHooks: [{ name: "legacy", command: "echo hi" }],
          Stop: [{ name: "new", command: ["true"] }],
        },
      },
    } as unknown as Config.Info
    const entries = getCommandHooksFor(cfg, "Stop")
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(["legacy", "new"])
  })

  test("returns empty array when no hooks configured", () => {
    const cfg = {} as Config.Info
    expect(getCommandHooksFor(cfg, "PreToolUse")).toHaveLength(0)
  })
})
