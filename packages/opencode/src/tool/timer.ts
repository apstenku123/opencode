import z from "zod"
import { Effect } from "effect"
import { Timer } from "../timer"
import { Tool } from "./tool"

const Parameters = z.object({
  action: z.enum(["create", "pause", "resume", "delete", "get", "list", "drain", "clear"]),
  id: z.string().optional().describe("Timer id for single-timer actions"),
  delay: z.number().int().positive().optional().describe("Delay in milliseconds for create"),
  repeat: z.boolean().optional().describe("Whether the timer repeats"),
})

type Input = z.infer<typeof Parameters>

type Meta = {
  action: Input["action"]
  id?: string
  count?: number
  ok?: boolean
  found?: boolean
}

export namespace TimerToolState {
  let state: ReturnType<typeof Timer.create> | undefined

  export function get() {
    state ??= Timer.create()
    return state
  }

  export function reset() {
    state?.clear()
    state = undefined
  }
}

export const TimerTool = Tool.define(
  "timer",
  Effect.succeed({
    description: "Manage lightweight in-process timers for create, pause, resume, inspect, and drain operations.",
    parameters: Parameters,
    execute: (args: Input) =>
      Effect.sync(() => {
        const timer = TimerToolState.get()
        const id = args.id
        if (args.action === "list") {
          const items = timer.list()
          return out("Listed timers", JSON.stringify(items, null, 2), { action: args.action, count: items.length })
        }
        if (args.action === "drain") {
          const items = timer.drain()
          return out("Drained timers", JSON.stringify(items, null, 2), { action: args.action, count: items.length })
        }
        if (args.action === "clear") {
          timer.clear()
          return out("Cleared timers", "[]", { action: args.action })
        }
        if (!id) throw new Error(`timer.${args.action} requires id`)
        if (args.action === "create") {
          if (!args.delay) throw new Error("timer.create requires delay")
          return out(`Created timer ${id}`, JSON.stringify(timer.create(id, args.delay, args.repeat ?? false), null, 2), {
            action: args.action,
            id,
          })
        }
        if (args.action === "delete") {
          const ok = timer.delete(id)
          return out(`Deleted timer ${id}`, JSON.stringify(ok), { action: args.action, id, ok })
        }
        if (args.action === "get") {
          const item = timer.get(id) ?? null
          return out(`Got timer ${id}`, JSON.stringify(item, null, 2), { action: args.action, id, found: Boolean(item) })
        }
        const item = args.action === "pause" ? timer.pause(id) : timer.resume(id)
        return out(`${args.action === "pause" ? "Paused" : "Resumed"} timer ${id}`, JSON.stringify(item ?? null, null, 2), {
          action: args.action,
          id,
          found: Boolean(item),
        })
      }),
  }),
)

function out(title: string, output: string, metadata: Meta) {
  return {
    title,
    output,
    metadata,
  }
}
