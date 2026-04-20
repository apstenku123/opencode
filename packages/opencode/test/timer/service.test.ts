import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { TimerSvc } from "../../src/server/instance/timer"
import { provideTmpdirInstance, tmpdirScoped, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(TimerSvc.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

describe("timer service", () => {
  it.live("supports create list pause resume delete and drain", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* TimerSvc.Service
        const sessionID = "session-a"

        const created = yield* svc.create(sessionID, { id: "loop", delay: 20, repeat: true })
        expect(created).toMatchObject({ id: "loop", delay: 20, repeat: true, active: true })

        const listed = yield* svc.list(sessionID)
        expect(listed).toMatchObject([{ id: "loop", delay: 20, repeat: true, active: true }])

        const paused = yield* svc.pause(sessionID, "loop")
        expect(paused).toMatchObject({ id: "loop", active: false, next: null })

        const resumed = yield* svc.resume(sessionID, "loop")
        expect(resumed).toMatchObject({ id: "loop", active: true, repeat: true })

        expect(yield* svc.drain(sessionID)).toEqual([])
        expect(yield* svc.delete(sessionID, "loop")).toBe(true)
        expect(yield* svc.list(sessionID)).toEqual([])
      }),
    ),
  )

  it.live("keeps timer state isolated per instance", () =>
    Effect.gen(function* () {
      const a = yield* tmpdirScoped({ git: true })
      const b = yield* tmpdirScoped({ git: true })
      const aSessionID = "session-a"
      const bSessionID = "session-b"

      yield* provideInstance(a)(
        Effect.gen(function* () {
          const svc = yield* TimerSvc.Service
          yield* svc.create(aSessionID, { id: "a", delay: 10 })
          expect((yield* svc.list(aSessionID)).map((item) => item.id)).toEqual(["a"])
        }),
      )

      yield* provideInstance(b)(
        Effect.gen(function* () {
          const svc = yield* TimerSvc.Service
          expect(yield* svc.list(bSessionID)).toEqual([])
          yield* svc.create(bSessionID, { id: "b", delay: 15, repeat: true })
          expect((yield* svc.list(bSessionID)).map((item) => item.id)).toEqual(["b"])
        }),
      )

      yield* provideInstance(a)(
        Effect.gen(function* () {
          const svc = yield* TimerSvc.Service
          expect((yield* svc.list(aSessionID)).map((item) => item.id)).toEqual(["a"])
        }),
      )
    }),
  )
})
