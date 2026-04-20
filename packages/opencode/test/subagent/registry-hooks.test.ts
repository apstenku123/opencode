/**
 * Round 7 Stream 3 — SubagentStart / SubagentStop hook dispatch tests.
 *
 * Verifies that:
 *  - SubagentRegistry.close() fires `SubagentStop` with `reason=completed`
 *    and the child's result threaded through as the summary.
 *  - SubagentRegistry.cancelChild() / cancelAll() fire `SubagentStop` with
 *    `reason=cancelled`.
 *  - SubagentRegistry.close({status:"error"}) fires `SubagentStop` with
 *    `reason=failed` and the error message as the summary.
 *  - When the `Hook.Service` layer is not provided the registry still works
 *    (soft dependency via `Effect.serviceOption`).
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SubagentRegistry } from "../../src/subagent/registry"
import * as Hook from "../../src/hook"
import type {
  DispatchInput,
  HookDispatchResult,
  Interface as HookInterface,
} from "../../src/hook/registry"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const sid = (s: string) => SessionID.make(s)

/**
 * A test double for Hook.Service that records every dispatch call without
 * touching the real command-hook subprocess machinery.
 */
function makeRecorder() {
  const calls: DispatchInput[] = []
  const service: HookInterface = {
    register: () => Effect.succeed(() => {}),
    listed: () => Effect.succeed([]),
    dispatch: (input) =>
      Effect.sync(() => {
        calls.push(input)
        return {
          outcome: "continue",
          responses: [],
        } satisfies HookDispatchResult
      }),
  }
  return {
    calls,
    layer: Layer.succeed(Hook.Service, service),
  }
}

function runWith<A, E>(
  hookLayer: Layer.Layer<Hook.Service>,
  body: Effect.Effect<A, E, SubagentRegistry.Service>,
): Promise<A> {
  return Effect.runPromise(
    provideTmpdirInstance(() =>
      body.pipe(
        Effect.scoped,
        Effect.provide(SubagentRegistry.defaultLayer),
        Effect.provide(hookLayer),
      ),
    ).pipe(
      Effect.scoped,
      Effect.provide(CrossSpawnSpawner.defaultLayer),
    ) as Effect.Effect<A, E>,
  )
}

describe("SubagentRegistry hook dispatch", () => {
  test("close() fires SubagentStop with reason=completed", async () => {
    const rec = makeRecorder()
    await runWith(
      rec.layer,
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_stop_parent_ok")
        const child = sid("session_stop_child_ok")
        yield* reg.spawn(parent, child, { agentType: "general" })
        yield* reg.close(child, { status: "completed", result: "all good" })
      }),
    )
    const stop = rec.calls.find((c) => c.event.hook_event_name === "SubagentStop")
    expect(stop).toBeDefined()
    if (stop?.event.hook_event_name !== "SubagentStop") throw new Error("expected SubagentStop")
    expect(stop.event.reason).toBe("completed")
    expect(stop.event.summary).toBe("all good")
    expect(stop.event.agent_id).toBe("session_stop_child_ok")
    expect(stop.event.agent_type).toBe("general")
    expect(stop.event.parent_session_id).toBe("session_stop_parent_ok")
    expect(stop.event.child_session_id).toBe("session_stop_child_ok")
    expect(stop.event.last_assistant_message).toBe("all good")
    expect(stop.agentLevel).toBe(1)
    expect(stop.sessionContext?.source).toBe("sub_agent")
  })

  test("cancelChild() fires SubagentStop with reason=cancelled", async () => {
    const rec = makeRecorder()
    await runWith(
      rec.layer,
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_stop_parent_cx")
        const child = sid("session_stop_child_cx")
        yield* reg.spawn(parent, child, { agentType: "review" })
        const ok = yield* reg.cancelChild(parent, child)
        expect(ok).toBe(true)
      }),
    )
    const stop = rec.calls.find((c) => c.event.hook_event_name === "SubagentStop")
    expect(stop).toBeDefined()
    if (stop?.event.hook_event_name !== "SubagentStop") throw new Error("expected SubagentStop")
    expect(stop.event.reason).toBe("cancelled")
    expect(stop.event.agent_type).toBe("review")
    expect(stop.event.child_session_id).toBe("session_stop_child_cx")
  })

  test("cancelAll() fires one SubagentStop per child, reason=cancelled", async () => {
    const rec = makeRecorder()
    await runWith(
      rec.layer,
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_stop_parent_all")
        yield* reg.spawn(parent, sid("session_stop_a"), { agentType: "general" })
        yield* reg.spawn(parent, sid("session_stop_b"), { agentType: "general" })
        const n = yield* reg.cancelAll(parent)
        expect(n).toBe(2)
      }),
    )
    const stops = rec.calls.filter((c) => c.event.hook_event_name === "SubagentStop")
    expect(stops).toHaveLength(2)
    for (const s of stops) {
      if (s.event.hook_event_name !== "SubagentStop") continue
      expect(s.event.reason).toBe("cancelled")
    }
  })

  test("close({status:error}) fires SubagentStop with reason=failed and error summary", async () => {
    const rec = makeRecorder()
    await runWith(
      rec.layer,
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_stop_parent_err")
        const child = sid("session_stop_child_err")
        yield* reg.spawn(parent, child, { agentType: "general" })
        yield* reg.close(child, { status: "error", error: "kaboom" })
      }),
    )
    const stop = rec.calls.find((c) => c.event.hook_event_name === "SubagentStop")
    expect(stop).toBeDefined()
    if (stop?.event.hook_event_name !== "SubagentStop") throw new Error("expected SubagentStop")
    expect(stop.event.reason).toBe("failed")
    expect(stop.event.summary).toBe("kaboom")
  })

  test("registry works without Hook layer (soft dependency)", async () => {
    // No Hook.Service in the environment — operations still succeed.
    const empty = Layer.succeedContext(
      // Cast: we're intentionally _not_ providing Hook.Service so the
      // registry's serviceOption code path is exercised.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      (await import("effect/Context")).empty(),
    ) as Layer.Layer<Hook.Service>
    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const reg = yield* SubagentRegistry.Service
          const parent = sid("session_stop_parent_nohook")
          const child = sid("session_stop_child_nohook")
          yield* reg.spawn(parent, child, { agentType: "general" })
          yield* reg.close(child, { status: "completed", result: "done" })
          const s = yield* reg.summary(child)
          expect(s?.status).toBe("completed")
        }).pipe(Effect.scoped, Effect.provide(SubagentRegistry.defaultLayer), Effect.provide(empty)),
      ).pipe(Effect.scoped, Effect.provide(CrossSpawnSpawner.defaultLayer)) as Effect.Effect<void>,
    )
  })
})
