import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskWaitTool, MAX_WAIT_TIMEOUT_MS } from "../../src/tool/task-wait"
import { TaskSendInputTool } from "../../src/tool/task-send-input"
import { TaskCloseTool } from "../../src/tool/task-close"
import { TaskListTool } from "../../src/tool/task-list"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { SubagentRegistry } from "../../src/subagent/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    SubagentRegistry.defaultLayer,
  ),
)

const seed = Effect.fn("TaskMulti.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(text = "done"): TaskPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant",
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "general",
            agent: input.agent ?? "general",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ref.modelID,
            providerID: input.model?.providerID ?? ref.providerID,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "text",
              text,
            },
          ],
        } as MessageV2.WithParts
      }),
  }
}

function makeCtx(sessionID: string, messageID: string, extra: Record<string, any> = {}) {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make(messageID),
    agent: "build",
    abort: new AbortController().signal,
    extra,
    messages: [] as MessageV2.WithParts[],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.task-list", () => {
  it.live("returns empty message when no children", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskListTool
        const def = yield* tool.init()
        const result = yield* def.execute({}, makeCtx(chat.id, assistant.id))
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("No sub-agent children")
      }),
    ),
  )

  it.live("lists running + completed children separately", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const running = SessionID.make("ses_runner")
        const done = SessionID.make("ses_done")
        yield* reg.spawn(SessionID.make(chat.id), running)
        yield* reg.spawn(SessionID.make(chat.id), done)
        yield* reg.close(done, { status: "completed", result: "hello" })
        const tool = yield* TaskListTool
        const def = yield* tool.init()
        const result = yield* def.execute({}, makeCtx(chat.id, assistant.id))
        expect(result.metadata.count).toBe(2)
        expect(result.metadata.running).toBe(1)
        expect(result.metadata.completed).toBe(1)
        expect(result.output).toContain(running)
        expect(result.output).toContain(done)
        expect(result.output).toContain("[running]")
        expect(result.output).toContain("[completed]")
      }),
    ),
  )
})

describe("tool.task-wait", () => {
  it.live("waits for specific ids and returns summaries", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const a = SessionID.make("ses_wa_a")
        const b = SessionID.make("ses_wa_b")
        yield* reg.spawn(SessionID.make(chat.id), a)
        yield* reg.spawn(SessionID.make(chat.id), b)
        // Pre-close both so waitForIds resolves immediately.
        yield* reg.close(a, { status: "completed", result: "A" })
        yield* reg.close(b, { status: "completed", result: "B" })
        const tool = yield* TaskWaitTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { ids: [a, b] },
          makeCtx(chat.id, assistant.id),
        )
        expect(result.metadata.count).toBe(2)
        expect(result.metadata.completed).toBe(2)
        expect(result.output).toContain("[ok]")
        expect(result.output).toContain("A")
        expect(result.output).toContain("B")
      }),
    ),
  )

  it.live("waits for all when ids omitted and returns empty with no active children", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskWaitTool
        const def = yield* tool.init()
        const result = yield* def.execute({}, makeCtx(chat.id, assistant.id))
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("no children completed")
      }),
    ),
  )

  it.live("clamps very large timeout_ms to MAX_WAIT_TIMEOUT_MS in metadata", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskWaitTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { timeout_ms: 9_999_999 },
          makeCtx(chat.id, assistant.id),
        )
        expect(result.metadata.timeoutMs).toBe(MAX_WAIT_TIMEOUT_MS)
      }),
    ),
  )
})

describe("tool.task-send-input", () => {
  it.live("appends a user message to the child session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        yield* reg.spawn(SessionID.make(chat.id), SessionID.make(child.id))
        const tool = yield* TaskSendInputTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { session_id: child.id, text: "more context please" },
          makeCtx(chat.id, assistant.id),
        )
        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.output).toContain(`Injected user message into child ${child.id}`)
        // Verify the message actually landed in the child session.
        const msgs = yield* sessions.messages({ sessionID: child.id })
        const lastUser = msgs.filter((m) => m.info.role === "user").at(-1)
        expect(lastUser).toBeDefined()
        const text = lastUser!.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as any).text)
          .join("")
        expect(text).toBe("more context please")
      }),
    ),
  )

  it.live("fails when child is not running", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const child = SessionID.make("ses_si_done")
        yield* reg.spawn(SessionID.make(chat.id), child)
        yield* reg.close(child, { status: "completed", result: "ok" })
        const tool = yield* TaskSendInputTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute({ session_id: child, text: "hey" }, makeCtx(chat.id, assistant.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("fails on unknown child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskSendInputTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            { session_id: "ses_never_spawned", text: "hey" },
            makeCtx(chat.id, assistant.id),
          ),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})

describe("tool.task-close", () => {
  it.live("cancels an active child", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const child = SessionID.make("ses_cl_active")
        let cancelled = false
        yield* reg.spawn(SessionID.make(chat.id), child, { cancel: () => (cancelled = true) })
        const tool = yield* TaskCloseTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { session_id: child },
          makeCtx(chat.id, assistant.id),
        )
        expect(result.metadata.cancelled).toBe(true)
        expect(cancelled).toBe(true)
        const s = yield* reg.summary(child)
        expect(s?.status).toBe("cancelled")
      }),
    ),
  )

  it.live("is a no-op on already-finished children", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const child = SessionID.make("ses_cl_done")
        yield* reg.spawn(SessionID.make(chat.id), child)
        yield* reg.close(child, { status: "completed", result: "ok" })
        const tool = yield* TaskCloseTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { session_id: child },
          makeCtx(chat.id, assistant.id),
        )
        expect(result.metadata.cancelled).toBe(false)
        expect(result.metadata.reason).toBe("already-finished")
        expect(result.output).toContain("already finished")
      }),
    ),
  )

  it.live("refuses to cancel a child owned by a different parent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const otherParent = SessionID.make("ses_cl_other_parent")
        const child = SessionID.make("ses_cl_foreign")
        yield* reg.spawn(otherParent, child)
        const tool = yield* TaskCloseTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { session_id: child },
          makeCtx(chat.id, assistant.id),
        )
        expect(result.metadata.cancelled).toBe(false)
        // Either "unknown" (not in summaries yet) or "foreign" (after close).
        expect(["unknown", "foreign"]).toContain(result.metadata.reason as string)
        // The foreign child must remain active.
        const active = yield* reg.active(otherParent)
        expect(active.has(child)).toBe(true)
      }),
    ),
  )
})

describe("task async concurrency limit", () => {
  it.live("rejects async spawn when active children reach maxConcurrent", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { chat, assistant } = yield* seed()
          const reg = yield* SubagentRegistry.Service
          // Fill the registry to the ceiling with pre-spawned active children.
          yield* reg.spawn(SessionID.make(chat.id), SessionID.make("ses_fill_1"))
          yield* reg.spawn(SessionID.make(chat.id), SessionID.make("ses_fill_2"))
          const tool = yield* TaskTool
          const def = yield* tool.init()
          const promptOps = stubOps()
          const exit = yield* Effect.exit(
            def.execute(
              {
                description: "over the limit",
                prompt: "this should fail",
                subagent_type: "general",
                async: true,
              },
              {
                ...makeCtx(chat.id, assistant.id, { promptOps, bypassAgentCheck: true }),
              },
            ),
          )
          expect(exit._tag).toBe("Failure")
        }),
      {
        config: {
          experimental: {
            subagent: {
              maxConcurrent: 2,
            },
          },
        },
      },
    ),
  )
})
