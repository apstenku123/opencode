import { InstanceState } from "@/effect"
import { Timer } from "@/timer"
import { Instance } from "@/project/instance"
import { Context, Effect, Layer } from "effect"
import z from "zod"

export namespace TimerSvc {
  export const SessionID = z.string().min(1).meta({ ref: "TimerSessionID" })

  export const Info = z
    .object({
      id: z.string(),
      delay: z.number().int().nonnegative(),
      repeat: z.boolean(),
      active: z.boolean(),
      next: z.number().nullable(),
    })
    .meta({ ref: "TimerInfo" })
  export type Info = z.infer<typeof Info>

  export const Fired = z
    .object({
      id: z.string(),
      at: z.number(),
    })
    .meta({ ref: "TimerFired" })
  export type Fired = z.infer<typeof Fired>

  export const CreateInput = z
    .object({
      id: z.string().min(1),
      delay: z.number().int().positive(),
      repeat: z.boolean().optional(),
    })
    .meta({ ref: "TimerCreateInput" })

  export const ItemInput = z
    .object({
      id: z.string().min(1),
    })
    .meta({ ref: "TimerItemInput" })

  export interface Interface {
    readonly list: (sessionID?: string) => Effect.Effect<Info[]>
    readonly get: (sessionID: string, id: string) => Effect.Effect<Info | undefined>
    readonly create: (sessionID: string, input: z.infer<typeof CreateInput>) => Effect.Effect<Info>
    readonly pause: (sessionID: string, id: string) => Effect.Effect<Info | undefined>
    readonly resume: (sessionID: string, id: string) => Effect.Effect<Info | undefined>
    readonly delete: (sessionID: string, id: string) => Effect.Effect<boolean>
    readonly drain: (sessionID: string) => Effect.Effect<Fired[]>
    readonly clear: (sessionID: string) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/TimerSvc") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make(
        Effect.fn("TimerSvc.state")(() =>
          Effect.sync(() => {
            const timers = new Map<string, ReturnType<typeof Timer.create>>()
            return {
              timers,
              get(sessionID: string) {
                const found = timers.get(sessionID)
                if (found) return found
                const next = Timer.create()
                timers.set(sessionID, next)
                return next
              },
              clear(sessionID: string) {
                const found = timers.get(sessionID)
                if (!found) return
                found.clear()
                timers.delete(sessionID)
              },
            }
          }).pipe(
            Effect.tap((state) =>
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  for (const timer of state.timers.values()) timer.clear()
                  state.timers.clear()
                }),
              ),
            ),
          ),
        ),
      )

      const list = Effect.fn("TimerSvc.list")(function* (sessionID?: string) {
        if (!sessionID) return []
        return (yield* InstanceState.get(state)).get(sessionID).list()
      })

      const get = Effect.fn("TimerSvc.get")(function* (sessionID: string, id: string) {
        return (yield* InstanceState.get(state)).get(sessionID).get(id)
      })

      const create = Effect.fn("TimerSvc.create")(function* (sessionID: string, input: z.infer<typeof CreateInput>) {
        return (yield* InstanceState.get(state)).get(sessionID).create(input.id, input.delay, input.repeat)
      })

      const pause = Effect.fn("TimerSvc.pause")(function* (sessionID: string, id: string) {
        return (yield* InstanceState.get(state)).get(sessionID).pause(id)
      })

      const resume = Effect.fn("TimerSvc.resume")(function* (sessionID: string, id: string) {
        return (yield* InstanceState.get(state)).get(sessionID).resume(id)
      })

      const del = Effect.fn("TimerSvc.delete")(function* (sessionID: string, id: string) {
        const timers = (yield* InstanceState.get(state)).get(sessionID)
        const deleted = timers.delete(id)
        if (!deleted) return false
        if (timers.list().length) return true
        ;(yield* InstanceState.get(state)).clear(sessionID)
        return true
      })

      const drain = Effect.fn("TimerSvc.drain")(function* (sessionID: string) {
        return (yield* InstanceState.get(state)).get(sessionID).drain()
      })

      const clear = Effect.fn("TimerSvc.clear")(function* (sessionID: string) {
        ;(yield* InstanceState.get(state)).clear(sessionID)
      })

      return Service.of({ list, get, create, pause, resume, delete: del, drain, clear })
    }),
  )

  export const defaultLayer = layer
}
