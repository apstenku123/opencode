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
})
