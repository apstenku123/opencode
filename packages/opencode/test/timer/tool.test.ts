import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TimerTool, TimerToolState } from "../../src/tool/timer"
import * as Tool from "../../src/tool/tool"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"

afterEach(() => {
  TimerToolState.reset()
})

function ctx(): Tool.Context {
  return {
    sessionID: "session_test" as never,
    messageID: "message_test" as never,
    agent: "agent_test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const layer = Effect.provideService(
  Effect.provideService(
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* TimerTool)
      return def
    }),
    Truncate.Service,
    {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
      cleanup: () => Effect.void,
      write: (text: string) => Effect.succeed(text),
    },
  ),
  Agent.Service,
  { get: () => Effect.succeed({ id: "agent_test" } as never), list: () => Effect.succeed([]), defaultAgent: () => Effect.succeed("agent_test"), generate: () => Effect.succeed({ identifier: "timer", whenToUse: "", systemPrompt: "" }) },
)

describe("timer tool", () => {
  test("creates and reads timers", async () => {
    const def = await Effect.runPromise(layer as never)
    const created: any = await Effect.runPromise((def as any).execute({ action: "create", id: "job", delay: 50, repeat: true }, ctx()))
    expect(created.output).toContain('"id": "job"')

    const listed: any = await Effect.runPromise((def as any).execute({ action: "list" }, ctx()))
    expect(listed.output).toContain('"job"')

    const got: any = await Effect.runPromise((def as any).execute({ action: "get", id: "job" }, ctx()))
    expect(got.output).toContain('"repeat": true')
  })
})
