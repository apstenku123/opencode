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

        const created = yield* svc.create({ id: "loop", delay: 20, repeat: true })
        expect(created).toMatchObject({ id: "loop", delay: 20, repeat: true, active: true })

        const listed = yield* svc.list()
        expect(listed).toMatchObject([{ id: "loop", delay: 20, repeat: true, active: true }])

        const paused = yield* svc.pause("loop")
        expect(paused).toMatchObject({ id: "loop", active: false, next: null })

        const resumed = yield* svc.resume("loop")
        expect(resumed).toMatchObject({ id: "loop", active: true, repeat: true })

        expect(yield* svc.drain()).toEqual([])
        expect(yield* svc.delete("loop")).toBe(true)
        expect(yield* svc.list()).toEqual([])
      }),
    ),
  )

  it.live("keeps timer state isolated per instance", () =>
    Effect.gen(function* () {
      const a = yield* tmpdirScoped({ git: true })
      const b = yield* tmpdirScoped({ git: true })

      yield* provideInstance(a)(
        Effect.gen(function* () {
          const svc = yield* TimerSvc.Service
          yield* svc.create({ id: "a", delay: 10 })
          expect((yield* svc.list()).map((item) => item.id)).toEqual(["a"])
        }),
      )

      yield* provideInstance(b)(
        Effect.gen(function* () {
          const svc = yield* TimerSvc.Service
          expect(yield* svc.list()).toEqual([])
          yield* svc.create({ id: "b", delay: 15, repeat: true })
          expect((yield* svc.list()).map((item) => item.id)).toEqual(["b"])
        }),
      )

      yield* provideInstance(a)(
        Effect.gen(function* () {
          const svc = yield* TimerSvc.Service
          expect((yield* svc.list()).map((item) => item.id)).toEqual(["a"])
        }),
      )
    }),
  )
})
