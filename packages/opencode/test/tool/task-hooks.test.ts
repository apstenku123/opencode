/**
 * Round 7 Stream 3 — task tool SubagentStart / SubagentStop hook dispatch
 * tests.
 *
 * Covers both the synchronous and `async: true` variants of the `task`
 * tool. `SubagentStart` must fire on every spawn. For the sync variant the
 * `task` tool also fires `SubagentStop` directly (completed / cancelled /
 * failed). The async variant's stop event is fired by SubagentRegistry
 * (verified in `test/subagent/registry-hooks.test.ts`).
 */
import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { SubagentRegistry } from "../../src/subagent/registry"
import * as Hook from "../../src/hook"
import type {
  DispatchInput,
  HookDispatchResult,
  Interface as HookInterface,
} from "../../src/hook/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Shared recorder for the current test. Reset on each `it.live` invocation
// since `testEffect` builds a fresh layer per test.
let currentCalls: DispatchInput[] = []

function makeRecorderLayer(): Layer.Layer<Hook.Service> {
  return Layer.sync(Hook.Service, () => {
    const svc: HookInterface = {
      register: () => Effect.succeed(() => {}),
      listed: () => Effect.succeed([]),
      dispatch: (input) =>
        Effect.sync(() => {
          currentCalls.push(input)
          return {
            outcome: "continue",
            responses: [],
          } satisfies HookDispatchResult
        }),
    }
    return svc
  })
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
    makeRecorderLayer(),
  ),
)

const seed = Effect.fn("TaskToolHooksTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
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

function stubOps(opts?: {
  text?: string
  fail?: boolean
}): TaskPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        if (opts?.fail) {
          return yield* Effect.die(new Error("forced failure"))
        }
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
              text: opts?.text ?? "done",
            },
          ],
        } satisfies MessageV2.WithParts
      }),
    fork: (effect) => Effect.runFork(effect),
  }
}

describe("tool.task hook events", () => {
  it.live("sync spawn fires SubagentStart then SubagentStop(reason=completed)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        currentCalls = []
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            description: "run it",
            prompt: "go do the thing",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ text: "finished output" }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect(result.output).toContain("finished output")
        const start = currentCalls.find((c) => c.event.hook_event_name === "SubagentStart")
        const stop = currentCalls.find((c) => c.event.hook_event_name === "SubagentStop")
        expect(start).toBeDefined()
        expect(stop).toBeDefined()
        if (start?.event.hook_event_name !== "SubagentStart") throw new Error("expected SubagentStart")
        if (stop?.event.hook_event_name !== "SubagentStop") throw new Error("expected SubagentStop")
        expect(start.event.parent_session_id).toBe(chat.id)
        expect(start.event.child_session_id).toBe(result.metadata.sessionId)
        expect(start.event.agent_type).toBe("general")
        expect(start.event.prompt).toBe("go do the thing")
        expect(stop.event.reason).toBe("completed")
        expect(stop.event.summary).toBe("finished output")
        expect(stop.event.parent_session_id).toBe(chat.id)
        expect(stop.event.child_session_id).toBe(result.metadata.sessionId)
      }),
    ),
  )

  it.live("sync spawn failure fires SubagentStop(reason=failed)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        currentCalls = []
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            {
              description: "run it",
              prompt: "go do the thing",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({ fail: true }) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )
        // execute wraps with orDie so the runtime-level exit is a defect.
        expect(exit._tag).toBe("Failure")
        const stops = currentCalls.filter((c) => c.event.hook_event_name === "SubagentStop")
        expect(stops.length).toBeGreaterThan(0)
        const stop = stops[0]!
        if (stop.event.hook_event_name !== "SubagentStop") throw new Error("expected SubagentStop")
        expect(stop.event.reason).toBe("failed")
      }),
    ),
  )

  it.live("async spawn fires SubagentStart and records registry completion", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        currentCalls = []
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            description: "run async",
            prompt: "work async",
            subagent_type: "general",
            async: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ text: "async done" }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect((result.metadata as { async?: boolean }).async).toBe(true)
        // Wait for child to settle — the async child fiber runs under the
        // ambient scope. Poll up to 2s for the summary to land.
        const childID = result.metadata.sessionId
        const deadline = Date.now() + 2_000
        let stop: DispatchInput | undefined
        while (Date.now() < deadline) {
          const s = yield* reg.summary(childID)
          stop = currentCalls.find((c) => c.event.hook_event_name === "SubagentStop")
          if (s && stop) break
          yield* Effect.sleep("10 millis")
        }
        const start = currentCalls.find((c) => c.event.hook_event_name === "SubagentStart")
        expect(start).toBeDefined()
        if (start?.event.hook_event_name !== "SubagentStart") throw new Error("expected SubagentStart")
        expect(start.event.parent_session_id).toBe(chat.id)
        expect(start.event.child_session_id).toBe(childID)
        expect(start.event.prompt).toBe("work async")
        const summary = yield* reg.summary(childID)
        expect(summary?.status).toBe("completed")
      }),
    ),
  )

  it.live("async spawn cancelled via cancelAll fires SubagentStop(reason=cancelled)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        currentCalls = []
        const { chat, assistant } = yield* seed()
        const reg = yield* SubagentRegistry.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()
        // Use an ops that never resolves so the child stays running long
        // enough for cancelAll to observe it.
        const hangingOps: TaskPromptOps = {
          cancel() {},
          resolvePromptParts: (template) =>
            Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: () => Effect.never,
          fork: (effect) => Effect.runFork(effect),
        }
        const result = yield* def.execute(
          {
            description: "run hang",
            prompt: "never returns",
            subagent_type: "general",
            async: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: hangingOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect((result.metadata as { async?: boolean }).async).toBe(true)
        yield* reg.cancelAll(chat.id)
        const stops = currentCalls.filter((c) => c.event.hook_event_name === "SubagentStop")
        expect(stops).toHaveLength(1)
        const stop = stops[0]!
        if (stop.event.hook_event_name !== "SubagentStop") throw new Error("expected SubagentStop")
        expect(stop.event.reason).toBe("cancelled")
      }),
    ),
  )
})
