import { Bus } from "@/bus"
import { Effect, Layer, Context, Option } from "effect"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"

export namespace SessionAutobestObserver {
  export interface Interface {}

  export function extract(text: string) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line, i) => {
        const m = line.match(/^[-*]\s+(.+)$/) ?? line.match(/^\d+[.)]\s+(.+)$/)
        if (!m) return []
        return [{ key: m[1].slice(0, 120), score: Math.max(1, 100 - i) }]
      })
      .slice(0, 5)
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAutobestObserver") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const session = yield* Session.Service
      const off = yield* bus.subscribeCallback(SessionStatus.Event.Idle, (evt) => {
        void Effect.runPromise(
          Effect.gen(function* () {
            const sessionID = evt.properties.sessionID
            const enabled = yield* session.getAutobestEnabled(sessionID)
            if (!enabled) return
            const msg = yield* session.findMessage(sessionID, (item) => item.info.role === "assistant")
            if (Option.isNone(msg)) return
            const text = msg.value.parts
              .filter((part): part is MessageV2.TextPart => part.type === "text")
              .map((part) => part.text.trim())
              .filter(Boolean)
              .join("\n")
            if (!text) return
            const picks = extract(text)
            if (!picks.length) return
            yield* session.applyAutobest({ sessionID, candidates: picks, ts: Date.now() })
          }),
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      return Service.of({})
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Session.defaultLayer))
}
