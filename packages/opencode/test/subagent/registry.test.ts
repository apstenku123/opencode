import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { SubagentRegistry } from "../../src/subagent/registry"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const sid = (s: string) => SessionID.make(s)

function run<A, E>(body: Effect.Effect<A, E, SubagentRegistry.Service>) {
  return Effect.runPromise(
    provideTmpdirInstance(() => body.pipe(Effect.scoped, Effect.provide(SubagentRegistry.defaultLayer)))
      .pipe(Effect.scoped, Effect.provide(CrossSpawnSpawner.defaultLayer)) as Effect.Effect<A, E>,
  )
}

describe("SubagentRegistry", () => {
  test("spawn + active + close round-trip", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_parent")
        const child = sid("session_child_a")
        yield* reg.spawn(parent, child)
        const before = yield* reg.active(parent)
        expect(before.has(child)).toBe(true)
        expect(before.size).toBe(1)

        yield* reg.close(child, { status: "completed", result: "ok" })
        const after = yield* reg.active(parent)
        expect(after.size).toBe(0)

        const summary = yield* reg.summary(child)
        expect(summary?.status).toBe("completed")
        expect(summary?.result).toBe("ok")
        expect(summary?.parentID).toBe(parent)
      }),
    )
  })

  test("waitForAll resolves when all children close", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_parent_wait")
        const a = sid("session_wait_a")
        const b = sid("session_wait_b")
        yield* reg.spawn(parent, a)
        yield* reg.spawn(parent, b)
        const waiting = yield* Effect.forkChild(reg.waitForAll(parent))
        // Close them from a separate fiber.
        yield* Effect.forkChild(reg.close(a, { status: "completed", result: "A" }))
        yield* Effect.forkChild(reg.close(b, { status: "completed", result: "B" }))
        const results = yield* Fiber.join(waiting)
        expect(results.length).toBe(2)
        const texts = results.map((s) => s.result).sort()
        expect(texts).toEqual(["A", "B"])
      }),
    )
  })

  test("waitForAll returns empty when no active children", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const results = yield* reg.waitForAll(sid("session_nobody"))
        expect(results).toEqual([])
      }),
    )
  })

  test("close on unknown child is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        yield* reg.close(sid("session_ghost"), { status: "completed" })
        const s = yield* reg.summary(sid("session_ghost"))
        expect(s).toBeUndefined()
      }),
    )
  })

  test("active isolates parent-child relationships", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const p1 = sid("session_p1")
        const p2 = sid("session_p2")
        yield* reg.spawn(p1, sid("session_c11"))
        yield* reg.spawn(p1, sid("session_c12"))
        yield* reg.spawn(p2, sid("session_c21"))
        const a1 = yield* reg.active(p1)
        const a2 = yield* reg.active(p2)
        expect(a1.size).toBe(2)
        expect(a2.size).toBe(1)
      }),
    )
  })

  test("error summary is captured with error message", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_err_parent")
        const child = sid("session_err_child")
        yield* reg.spawn(parent, child)
        yield* reg.close(child, { status: "error", error: "boom" })
        const s = yield* reg.summary(child)
        expect(s?.status).toBe("error")
        expect(s?.error).toBe("boom")
      }),
    )
  })
})
