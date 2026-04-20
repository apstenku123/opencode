import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { AdaptiveHooks, AdaptiveState } from "../../src/session/adaptive"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const sid = (s: string) => SessionID.make(s)

const run = <A, E>(body: Effect.Effect<A, E, AdaptiveHooks.Service>) =>
  Effect.runPromise(
    provideTmpdirInstance(() => body.pipe(Effect.scoped, Effect.provide(AdaptiveHooks.defaultLayer)))
      .pipe(Effect.scoped, Effect.provide(CrossSpawnSpawner.defaultLayer)) as Effect.Effect<A, E>,
  )

describe("AdaptiveHooks", () => {
  test("stateFor returns fresh state bag, subsequent calls return same bag (CRUD)", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const sessionID = sid("session_s1")
        const a = yield* hooks.stateFor(sessionID)
        expect(a.iteration).toBe(0)
        expect(a.stagnationCount).toBe(0)
        expect(a.emptyOutputCount).toBe(0)
        expect(a.lastAssistantText).toBeUndefined()
        a.stagnationCount = 3
        a.lastAssistantText = "hello"
        const b = yield* hooks.stateFor(sessionID)
        expect(b.stagnationCount).toBe(3)
        expect(b.lastAssistantText).toBe("hello")
        yield* hooks.clear(sessionID)
        const c = yield* hooks.stateFor(sessionID)
        expect(c.stagnationCount).toBe(0)
        expect(c.lastAssistantText).toBeUndefined()
      }),
    )
  })

  test("resetCycle zeroes per-cycle counters but preserves scratch", () => {
    const s = AdaptiveState.empty()
    s.whereIsPlanAsks = 2
    s.whatNextAsks = 1
    s.stagnationCount = 5
    s.emptyOutputCount = 4
    s.scratch.foo = "bar"
    AdaptiveState.resetCycle(s)
    expect(s.whereIsPlanAsks).toBe(0)
    expect(s.whatNextAsks).toBe(0)
    expect(s.stagnationCount).toBe(0)
    expect(s.emptyOutputCount).toBe(0)
    expect(s.scratch.foo).toBe("bar")
  })

  test("observers are invoked in registration order", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const order = yield* Ref.make<string[]>([])
        yield* hooks.register({
          name: "first",
          preIteration: () => Ref.update(order, (a) => [...a, "first"]),
        })
        yield* hooks.register({
          name: "second",
          preIteration: () => Ref.update(order, (a) => [...a, "second"]),
        })
        yield* hooks.runPreIteration({ sessionID: sid("session_ord"), step: 1 })
        const seen = yield* Ref.get(order)
        expect(seen).toEqual(["first", "second"])
      }),
    )
  })

  test("registered lists names; unregister removes observer", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const off = yield* hooks.register({ name: "temp", preIteration: () => Effect.void })
        const before = yield* hooks.registered
        expect(before).toContain("temp")
        off()
        const after = yield* hooks.registered
        expect(after).not.toContain("temp")
      }),
    )
  })

  test("postIteration directive precedence: break > inject > continue", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        yield* hooks.register({
          name: "c1",
          postIteration: () => Effect.succeed(AdaptiveHooks.Continue),
        })
        yield* hooks.register({
          name: "inj",
          postIteration: () =>
            Effect.succeed(AdaptiveHooks.Inject({ text: "try again", source: "test:inject" })),
        })
        yield* hooks.register({
          name: "brk",
          postIteration: () => Effect.succeed(AdaptiveHooks.Break),
        })
        const merged = yield* hooks.runPostIteration({
          sessionID: sid("session_merge"),
          step: 1,
          defaultOutcome: "continue",
        })
        expect(merged.kind).toBe("break")
      }),
    )
  })

  test("postIteration: first inject wins when no break", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        yield* hooks.register({
          name: "c1",
          postIteration: () => Effect.succeed(AdaptiveHooks.Continue),
        })
        yield* hooks.register({
          name: "inject-a",
          postIteration: () => Effect.succeed(AdaptiveHooks.Inject({ text: "a", source: "test:a" })),
        })
        yield* hooks.register({
          name: "inject-b",
          postIteration: () => Effect.succeed(AdaptiveHooks.Inject({ text: "b", source: "test:b" })),
        })
        const merged = yield* hooks.runPostIteration({
          sessionID: sid("session_inject"),
          step: 1,
          defaultOutcome: "continue",
        })
        expect(merged.kind).toBe("inject")
        if (merged.kind === "inject") {
          expect(merged.message.text).toBe("a")
          expect(merged.message.source).toBe("test:a")
        }
      }),
    )
  })

  test("postIteration writes lastAssistantText into state", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const sessionID = sid("session_text")
        yield* hooks.runPostIteration({
          sessionID,
          step: 1,
          defaultOutcome: "continue",
          assistantText: "hello world",
        })
        const bag = yield* hooks.stateFor(sessionID)
        expect(bag.lastAssistantText).toBe("hello world")
      }),
    )
  })

  test("preBreak directive precedence mirrors postIteration", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        yield* hooks.register({
          name: "pb-continue",
          preBreak: () => Effect.succeed(AdaptiveHooks.Continue),
        })
        yield* hooks.register({
          name: "pb-inject",
          preBreak: () => Effect.succeed(AdaptiveHooks.Inject({ text: "wait", source: "test:wait" })),
        })
        const merged = yield* hooks.runPreBreak({ sessionID: sid("session_pb"), step: 1 })
        expect(merged.kind).toBe("inject")
      }),
    )
  })

  test("no observers → continue directive", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const merged = yield* hooks.runPostIteration({
          sessionID: sid("session_empty"),
          step: 1,
          defaultOutcome: "continue",
        })
        expect(merged.kind).toBe("continue")
      }),
    )
  })

  test("mergeDirectives unit: break short-circuits", () => {
    const d = AdaptiveHooks.mergeDirectives([
      AdaptiveHooks.Inject({ text: "x", source: "a" }),
      AdaptiveHooks.Break,
      AdaptiveHooks.Inject({ text: "y", source: "b" }),
    ])
    expect(d.kind).toBe("break")
  })

  test("resetCycleFor zeros per-cycle counters on existing state but not scratch", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const sessionID = sid("session_reset_cycle")
        const bag = yield* hooks.stateFor(sessionID)
        bag.stagnationCount = 7
        bag.whereIsPlanAsks = 3
        bag.whatNextAsks = 2
        bag.emptyOutputCount = 9
        bag.scratch.keepMe = 42
        yield* hooks.resetCycleFor(sessionID)
        const after = yield* hooks.stateFor(sessionID)
        expect(after.stagnationCount).toBe(0)
        expect(after.whereIsPlanAsks).toBe(0)
        expect(after.whatNextAsks).toBe(0)
        expect(after.emptyOutputCount).toBe(0)
        expect(after.scratch.keepMe).toBe(42)
      }),
    )
  })

  test("resetCycleFor on a never-seen session is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        // Should not throw.
        yield* hooks.resetCycleFor(sid("session_reset_unknown"))
      }),
    )
  })

  test("noteInject increments scratch.injectCount and records lastInjectSource", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const sessionID = sid("session_note_inject")
        yield* hooks.noteInject(sessionID, "test:a")
        yield* hooks.noteInject(sessionID, "test:b")
        const bag = yield* hooks.stateFor(sessionID)
        expect(bag.scratch.injectCount).toBe(2)
        expect(bag.scratch.lastInjectSource).toBe("test:b")
      }),
    )
  })

  test("appendSyntheticUserText shares the append path and inject accounting contract", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const seen = yield* Ref.make<string[]>([])
        const sessionID = sid("session_append_shared")
        yield* hooks.appendSyntheticUserText({
          sessionID,
          source: "timer:job",
          text: "timer fired",
          append: Ref.update(seen, (items) => [...items, "appended"]),
        })
        const bag = yield* hooks.stateFor(sessionID)
        const pending = yield* hooks.pendingInjectsFor(sessionID)
        expect(yield* Ref.get(seen)).toEqual(["appended"])
        expect(bag.scratch.injectCount).toBe(1)
        expect(bag.scratch.lastInjectSource).toBe("timer:job")
        expect(pending).toEqual([{ text: "timer fired", source: "timer:job" }])
      }),
    )
  })

  test("appendSyntheticUserText queues accepted injects in FIFO order and clearPendingInjectsFor drains them", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const sessionID = sid("session_append_fifo")
        yield* hooks.appendSyntheticUserText({
          sessionID,
          source: "test:first",
          text: "first",
          append: Effect.void,
        })
        yield* hooks.appendSyntheticUserText({
          sessionID,
          source: "test:second",
          text: "second",
          append: Effect.void,
        })
        expect(yield* hooks.pendingInjectsFor(sessionID)).toEqual([
          { text: "first", source: "test:first" },
          { text: "second", source: "test:second" },
        ])
        yield* hooks.clearPendingInjectsFor(sessionID)
        expect(yield* hooks.pendingInjectsFor(sessionID)).toEqual([])
      }),
    )
  })

  test("queue bookkeeping preserves coexistence order for timer, subagent auto-wait, and stop-hook sources", async () => {
    await run(
      Effect.gen(function* () {
        const hooks = yield* AdaptiveHooks.Service
        const sessionID = sid("session_boundary_queue")
        yield* hooks.appendSyntheticUserText({
          sessionID,
          source: "timer:coexist",
          text: "[timer:coexist] fired",
          append: Effect.void,
        })
        yield* hooks.appendSyntheticUserText({
          sessionID,
          source: "subagent:auto-wait",
          text: "[Sub-agent results] All 1 sub-agent(s) have finished:\n- child [ok]: child result",
          append: Effect.void,
        })
        yield* hooks.appendSyntheticUserText({
          sessionID,
          source: "stop-hooks",
          text: '<stop-hook name="alpha">\nstop output\n</stop-hook>',
          append: Effect.void,
        })
        expect(yield* hooks.pendingInjectsFor(sessionID)).toEqual([
          { text: "[timer:coexist] fired", source: "timer:coexist" },
          {
            text: "[Sub-agent results] All 1 sub-agent(s) have finished:\n- child [ok]: child result",
            source: "subagent:auto-wait",
          },
          { text: '<stop-hook name="alpha">\nstop output\n</stop-hook>', source: "stop-hooks" },
        ])
      }),
    )
  })
})
