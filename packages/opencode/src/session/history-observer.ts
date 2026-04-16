import { Bus } from "@/bus"
import { Effect, Layer, Context } from "effect"
import * as History from "@/history"
import { MessageV2 } from "./message-v2"

export namespace SessionHistoryObserver {
  export interface Interface {}

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionHistoryObserver") {}

  function reminder(part: MessageV2.Part) {
    if (part.type !== "text" || !part.synthetic) return
    if (part.text == "The following tool was executed by the user") return
    if (part.text.includes("Plan mode is active")) return { kind: "plan_mode", source: "plan_file_exists" } as const
    if (part.text.includes("A plan file exists at ")) return { kind: "build_switch", source: "plan_file_exists" } as const
    if (part.text.includes("make a plan") || part.text.includes("You should execute on the plan defined within it"))
      return { kind: "build_switch", source: "prior_plan_assistant" } as const
    return { kind: "plan_prompt", source: "agent_match" } as const
  }

  function subtask(part: MessageV2.Part) {
    if (part.type !== "tool" || part.tool !== "task") return
    return {
      callID: part.callID,
      agent:
        "subagent_type" in part.state.input && typeof part.state.input.subagent_type === "string"
          ? part.state.input.subagent_type
          : "",
      status: part.state.status === "completed" ? "completed" : part.state.status === "running" ? "running" : "error",
      description:
        "description" in part.state.input && typeof part.state.input.description === "string"
          ? part.state.input.description
          : "",
    } as const
  }

  function shell(part: MessageV2.Part) {
    if (part.type !== "tool" || part.tool !== "bash") return
    const err = part.state.status === "error" ? part.state.error : undefined
    const status =
      part.state.status === "completed"
        ? "completed"
        : part.state.status === "running"
          ? "running"
          : err === "aborted"
            ? "aborted"
            : undefined
    if (!status) return
    return {
      callID: part.callID,
      cwd: "cwd" in part.state.input && typeof part.state.input.cwd === "string" ? part.state.input.cwd : "",
      shell: "shell" in part.state.input && typeof part.state.input.shell === "string" ? part.state.input.shell : "",
      status,
    } as const
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const off = yield* bus.subscribeCallback(MessageV2.Event.PartUpdated, (evt) => {
        const part = evt.properties.part
        const ts = evt.properties.time
        const info = reminder(part)
        if (info) {
          void History.append(part.sessionID, {
            ts,
            type: "prompt.reminder.inserted",
            sessionID: part.sessionID,
            messageID: part.messageID,
            agent: "unknown",
            kind: info.kind,
            source: info.source,
            synthetic: true,
          })
        }
        const task = subtask(part)
        if (task) {
          void History.append(part.sessionID, {
            ts,
            type: "prompt.subtask.state_changed",
            sessionID: part.sessionID,
            messageID: part.messageID,
            callID: task.callID,
            agent: task.agent,
            status: task.status,
            description: task.description,
          })
        }
        const sh = shell(part)
        if (sh) {
          void History.append(part.sessionID, {
            ts,
            type: "prompt.shell.state_changed",
            sessionID: part.sessionID,
            messageID: part.messageID,
            callID: sh.callID,
            cwd: sh.cwd,
            shell: sh.shell,
            status: sh.status,
          })
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      return Service.of({})
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
}
