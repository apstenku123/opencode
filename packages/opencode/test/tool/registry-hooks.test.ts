/**
 * Tests for `PreToolUse` / `PostToolUse` hook integration in
 * `ToolRegistry.tools()` — see `packages/opencode/src/tool/registry.ts`.
 *
 * Coverage:
 *  - A tool's `execute()` fires both `PreToolUse` and `PostToolUse`.
 *  - `PreToolUse` `FailedAbort` short-circuits `execute` (AbortError).
 *  - `PreToolUse` `decision_behavior === "deny"` throws AbortError.
 *  - `PostToolUse` `updated_output` replaces the captured output.
 *  - In-process matcher regex filters hooks by `tool_name`.
 */
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import type { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ReadTool } from "../../src/tool/read"
import { TodoWriteTool } from "../../src/tool/todo"
import * as Hook from "../../src/hook"
import type { HookEvent, HookResult } from "../../src/hook/types"
import { ToolRegistry } from "../../src/tool"
import type { Tool } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const okAsk: Tool.Context["ask"] = () => Effect.void

afterEach(async () => {
  await Instance.disposeAll()
})

const node = CrossSpawnSpawner.defaultLayer
// `ToolRegistry.defaultLayer` uses `Layer.provideMerge(Hook.defaultLayer)` so
// the single Hook.Service instance it wires into every tool's wrappedExecute
// is also visible on the layer output — the test can register hooks against
// the same instance the registry dispatches through.
const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }

describe("tool.registry hooks", () => {
  it.live("fires PreToolUse and PostToolUse around execute", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello world\n"))

        const hooks = yield* Hook.Service
        const seen: Array<HookEvent["hook_event_name"]> = []
        yield* hooks.register({
          name: "test-pre",
          event: "PreToolUse",
          run: (_payload) =>
            Effect.sync(() => {
              seen.push("PreToolUse")
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })
        yield* hooks.register({
          name: "test-post",
          event: "PostToolUse",
          run: (_payload) =>
            Effect.sync(() => {
              seen.push("PostToolUse")
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const read = list.find((t) => t.id === ReadTool.id)
        if (!read) throw new Error("read tool not found")

        yield* read.execute({ filePath: target }, { ...baseCtx, ask: okAsk })

        expect(seen).toEqual(["PreToolUse", "PostToolUse"])
      }),
    ),
  )

  it.live("fires PostToolUseFailure and AfterToolUse on tool failure", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const hooks = yield* Hook.Service
        const seen: Array<HookEvent["hook_event_name"]> = []
        yield* hooks.register({
          name: "pre",
          event: "PreToolUse",
          run: () =>
            Effect.sync(() => {
              seen.push("PreToolUse")
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })
        yield* hooks.register({
          name: "fail",
          event: "PostToolUseFailure",
          run: () =>
            Effect.sync(() => {
              seen.push("PostToolUseFailure")
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })
        yield* hooks.register({
          name: "after",
          event: "AfterToolUse",
          run: () =>
            Effect.sync(() => {
              seen.push("AfterToolUse")
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const todo = list.find((t) => t.id === TodoWriteTool.id)
        if (!todo) throw new Error("todo tool not found")

        const exit = yield* Effect.exit(
          todo.execute(
            {
              todos: [
                {
                  id: "1",
                  content: "broken",
                  status: "pending",
                  priority: "high",
                },
              ],
            },
            {
              ...baseCtx,
              ask: () => Effect.die(new Error("forced tool failure")),
            },
          ),
        )
        expect(exit._tag).toBe("Failure")
        expect(seen).toEqual(["PreToolUse", "PostToolUseFailure", "AfterToolUse"])
      }),
    ),
  )

  it.live("PreToolUse FailedAbort short-circuits execute (AbortError)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello\n"))

        const hooks = yield* Hook.Service
        let executed = false
        yield* hooks.register({
          name: "abort-pre",
          event: "PreToolUse",
          run: (_p) =>
            Effect.sync(() => ({ kind: "failed_abort", error: "nope" }) as HookResult),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const read = list.find((t) => t.id === ReadTool.id)
        if (!read) throw new Error("read tool not found")

        // Monkey-patch the inner execute by wrapping an ask that signals when
        // the read tool actually starts work. If Pre aborts first, execute
        // never runs.
        const ctx: Tool.Context = {
          ...baseCtx,
          ask: () =>
            Effect.sync(() => {
              executed = true
            }),
        }

        const exit = yield* Effect.exit(read.execute({ filePath: target }, ctx))
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("nope")
        expect(executed).toBe(false)
      }),
    ),
  )

  it.live("PreToolUse permissionDecision 'deny' short-circuits with AbortError", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello\n"))

        const hooks = yield* Hook.Service
        yield* hooks.register({
          name: "deny-pre",
          event: "PreToolUse",
          run: (_p) =>
            Effect.sync(
              () =>
                ({
                  kind: "success",
                  decision_interrupt: false,
                  suppress_output: false,
                  decision_behavior: "deny",
                  decision_message: "forbidden",
                }) as HookResult,
            ),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const read = list.find((t) => t.id === ReadTool.id)
        if (!read) throw new Error("read tool not found")

        const exit = yield* Effect.exit(read.execute({ filePath: target }, { ...baseCtx, ask: okAsk }))
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("forbidden")
      }),
    ),
  )

  it.live("PreToolUse permissionDecision 'ask' forwards to Permission via ctx.ask", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello\n"))

        const hooks = yield* Hook.Service
        yield* hooks.register({
          name: "ask-pre",
          event: "PreToolUse",
          run: (_p) =>
            Effect.sync(
              () =>
                ({
                  kind: "success",
                  decision_interrupt: false,
                  suppress_output: false,
                  decision_behavior: "ask",
                  decision_message: "please confirm",
                }) as HookResult,
            ),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const read = list.find((t) => t.id === ReadTool.id)
        if (!read) throw new Error("read tool not found")

        const asked: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const ctx: Tool.Context = {
          ...baseCtx,
          ask: (req) =>
            Effect.sync(() => {
              asked.push(req)
            }),
        }

        yield* read.execute({ filePath: target }, ctx)
        // The hook-triggered ask is the only one surfaced here since ReadTool
        // for a plain in-tree path inside our tmp cwd performs no additional
        // permission request beyond the standard read flow.
        expect(asked.length).toBeGreaterThanOrEqual(1)
        expect(asked.some((r) => r.permission === ReadTool.id)).toBe(true)
        const hookAsk = asked.find((r) => r.permission === ReadTool.id)
        expect(hookAsk?.metadata.hookReason).toBe("please confirm")
      }),
    ),
  )

  it.live("PostToolUse updated_output replaces the tool's captured output", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const hooks = yield* Hook.Service
        yield* hooks.register({
          name: "replace-post",
          event: "PostToolUse",
          run: (_p) =>
            Effect.sync(
              () =>
                ({
                  kind: "success",
                  decision_interrupt: false,
                  suppress_output: false,
                  updated_output: "REPLACED_BY_HOOK",
                }) as HookResult,
            ),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const todo = list.find((t) => t.id === TodoWriteTool.id)
        if (!todo) throw new Error("todo tool not found")

        const out = yield* todo.execute({ todos: [] }, { ...baseCtx, ask: okAsk })
        expect(out.output).toBe("REPLACED_BY_HOOK")
      }),
    ),
  )

  it.live("matcher regex filters in-process hooks by tool_name", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello\n"))

        const hooks = yield* Hook.Service
        const seen: string[] = []
        const all: string[] = []
        // Match only `todowrite` — should NOT fire for `read`.
        yield* hooks.register({
          name: "only-todo",
          event: "PreToolUse",
          matcher: /^todowrite$/,
          run: (payload) =>
            Effect.sync(() => {
              const ev = payload.hook_event
              if (ev.hook_event_name === "PreToolUse") seen.push(ev.tool_name)
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })
        // No matcher — fires for every PreToolUse, sanity baseline.
        yield* hooks.register({
          name: "any-pre",
          event: "PreToolUse",
          run: (payload) =>
            Effect.sync(() => {
              const ev = payload.hook_event
              if (ev.hook_event_name === "PreToolUse") all.push(ev.tool_name)
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const todo = list.find((t) => t.id === TodoWriteTool.id)
        const read = list.find((t) => t.id === ReadTool.id)
        if (!todo) throw new Error("todo tool not found")
        if (!read) throw new Error("read tool not found")

        // Run read first — matcher must filter it OUT.
        yield* read.execute({ filePath: target }, { ...baseCtx, ask: okAsk })
        // Then run todo — matcher must allow it.
        yield* todo.execute({ todos: [] }, { ...baseCtx, ask: okAsk })

        expect(all).toEqual(["read", "todowrite"])
        expect(seen).toEqual(["todowrite"])
      }),
    ),
  )

  it.live("threads subagent provenance into tool hook payloads", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const hooks = yield* Hook.Service
        const seen: Array<{ level: number; source: string }> = []
        yield* hooks.register({
          name: "capture-pre",
          event: "PreToolUse",
          run: (payload) =>
            Effect.sync(() => {
              seen.push({ level: payload.agent_level, source: payload.session_context.source })
              return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
            }),
        })

        const registry = yield* ToolRegistry.Service
        const list = yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })
        const todo = list.find((t) => t.id === TodoWriteTool.id)
        if (!todo) throw new Error("todo tool not found")

        yield* todo.execute(
          { todos: [] },
          { ...baseCtx, ask: okAsk, agent: "review", extra: { agentLevel: 1 } },
        )

        expect(seen).toEqual([{ level: 1, source: "sub_agent" }])
      }),
    ),
  )
})
