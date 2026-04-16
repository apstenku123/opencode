import { InstanceState } from "@/effect"
import { Timer } from "@/timer"
import { Instance } from "@/project/instance"
import { Context, Effect, Layer } from "effect"
import z from "zod"

export namespace TimerSvc {
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
    readonly list: () => Effect.Effect<Info[]>
    readonly get: (id: string) => Effect.Effect<Info | undefined>
    readonly create: (input: z.infer<typeof CreateInput>) => Effect.Effect<Info>
    readonly pause: (id: string) => Effect.Effect<Info | undefined>
    readonly resume: (id: string) => Effect.Effect<Info | undefined>
    readonly delete: (id: string) => Effect.Effect<boolean>
    readonly drain: () => Effect.Effect<Fired[]>
    readonly clear: () => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/TimerSvc") {}

  const shared = new Map<string, ReturnType<typeof Timer.create>>()

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make(
        Effect.fn("TimerSvc.state")(() =>
          Effect.sync(() => {
            const dir = Instance.directory
            const found = shared.get(dir)
            if (found) return found
            const next = Timer.create()
            shared.set(dir, next)
            return next
          }),
        ),
      )

      const list = Effect.fn("TimerSvc.list")(function* () {
        return (yield* InstanceState.get(state)).list()
      })

      const get = Effect.fn("TimerSvc.get")(function* (id: string) {
        return (yield* InstanceState.get(state)).get(id)
      })

      const create = Effect.fn("TimerSvc.create")(function* (input: z.infer<typeof CreateInput>) {
        return (yield* InstanceState.get(state)).create(input.id, input.delay, input.repeat)
      })

      const pause = Effect.fn("TimerSvc.pause")(function* (id: string) {
        return (yield* InstanceState.get(state)).pause(id)
      })

      const resume = Effect.fn("TimerSvc.resume")(function* (id: string) {
        return (yield* InstanceState.get(state)).resume(id)
      })

      const del = Effect.fn("TimerSvc.delete")(function* (id: string) {
        return (yield* InstanceState.get(state)).delete(id)
      })

      const drain = Effect.fn("TimerSvc.drain")(function* () {
        return (yield* InstanceState.get(state)).drain()
      })

      const clear = Effect.fn("TimerSvc.clear")(function* () {
        ;(yield* InstanceState.get(state)).clear()
      })

      return Service.of({ list, get, create, pause, resume, delete: del, drain, clear })
    }),
  )

  export const defaultLayer = layer
}
