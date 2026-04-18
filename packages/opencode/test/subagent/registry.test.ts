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

  test("depth walks parent chain registered via spawn", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const top = sid("session_d_top")
        const lvl1 = sid("session_d_lvl1")
        const lvl2 = sid("session_d_lvl2")
        const lvl3 = sid("session_d_lvl3")
        yield* reg.spawn(top, lvl1)
        yield* reg.spawn(lvl1, lvl2)
        yield* reg.spawn(lvl2, lvl3)
        expect(yield* reg.depth(top)).toBe(0)
        expect(yield* reg.depth(lvl1)).toBe(1)
        expect(yield* reg.depth(lvl2)).toBe(2)
        expect(yield* reg.depth(lvl3)).toBe(3)
        // depth survives close
        yield* reg.close(lvl1, { status: "completed" })
        expect(yield* reg.depth(lvl3)).toBe(3)
      }),
    )
  })

  test("cancelAll invokes per-child cancel callbacks and records cancelled summaries", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_cancel_p")
        const c1 = sid("session_cancel_c1")
        const c2 = sid("session_cancel_c2")
        let cancelled1 = false
        let cancelled2 = false
        yield* reg.spawn(parent, c1, { cancel: () => (cancelled1 = true) })
        yield* reg.spawn(parent, c2, { cancel: () => (cancelled2 = true) })
        const n = yield* reg.cancelAll(parent)
        expect(n).toBe(2)
        expect(cancelled1).toBe(true)
        expect(cancelled2).toBe(true)
        const after = yield* reg.active(parent)
        expect(after.size).toBe(0)
        const s1 = yield* reg.summary(c1)
        const s2 = yield* reg.summary(c2)
        expect(s1?.status).toBe("cancelled")
        expect(s2?.status).toBe("cancelled")
      }),
    )
  })

  test("waitForAll resolves when cancelAll fires after wait was already pending", async () => {
    await run(
      Effect.gen(function* () {
        const reg = yield* SubagentRegistry.Service
        const parent = sid("session_cancelw_p")
        const c1 = sid("session_cancelw_c1")
        yield* reg.spawn(parent, c1)
        // Capture the entries before cancelAll so waitForAll has something to await.
        const before = yield* reg.active(parent)
        expect(before.size).toBe(1)
        const waiting = yield* Effect.forkChild(reg.waitForAll(parent))
        // Yield a tick so the forked waitForAll can read state.children before cancel.
        yield* Effect.sleep("5 millis")
        yield* reg.cancelAll(parent)
        const results = yield* Fiber.join(waiting)
        expect(results.length).toBe(1)
        expect(results[0]?.status).toBe("cancelled")
      }),
    )
  })

  test("summarize formats children list with status tags", () => {
    const out = SubagentRegistry.summarize([
      {
        sessionID: sid("session_x"),
        parentID: sid("session_p"),
        status: "completed",
        startedAt: 0,
        finishedAt: 1,
        result: "ok-result",
      },
      {
        sessionID: sid("session_y"),
        parentID: sid("session_p"),
        status: "error",
        startedAt: 0,
        finishedAt: 1,
        error: "boom",
      },
      {
        sessionID: sid("session_z"),
        parentID: sid("session_p"),
        status: "cancelled",
        startedAt: 0,
        finishedAt: 1,
      },
    ])
    expect(out).toContain("[Sub-agent results] All 3 sub-agent(s) have finished:")
    expect(out).toContain("[ok]")
    expect(out).toContain("[error]")
    expect(out).toContain("[cancelled]")
    expect(out).toContain("ok-result")
    expect(out).toContain("boom")
  })

  test("summarize on empty input returns empty string", () => {
    expect(SubagentRegistry.summarize([])).toBe("")
  })
})
