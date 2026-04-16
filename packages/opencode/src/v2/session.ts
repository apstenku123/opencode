import { Context, Layer, Schema, Effect } from "effect"
import { SessionEntry } from "./session-entry"
import { Struct } from "effect"
import { Identifier } from "@/id/id"
import { withStatics } from "@/util/schema"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"

export namespace SessionV2 {
  export const ID = SessionID

  export type ID = Schema.Schema.Type<typeof ID>

  export class PromptInput extends Schema.Class<PromptInput>("Session.PromptInput")({
    ...Struct.omit(SessionEntry.User.fields, ["time", "type"]),
    id: Schema.optionalKey(SessionEntry.ID),
    sessionID: SessionV2.ID,
  }) {}

  export class CreateInput extends Schema.Class<CreateInput>("Session.CreateInput")({
    id: Schema.optionalKey(SessionV2.ID),
  }) {}

  export class Info extends Schema.Class<Info>("Session.Info")({
    id: SessionV2.ID,
    model: Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      modelID: Schema.String,
    }).pipe(Schema.optional),
  }) {}

  export interface Interface {
    fromID: (id: SessionV2.ID) => Effect.Effect<Info>
    create: (input: CreateInput) => Effect.Effect<Info>
    prompt: (input: PromptInput) => Effect.Effect<SessionEntry.User>
  }

  export class Service extends Context.Service<Service, Interface>()("Session.Service") {}

  export const layer = Layer.effect(Service)(
    Effect.gen(function* () {
      const session = yield* Session.Service

      const create: Interface["create"] = Effect.fn("Session.create")(function* (_input) {
        const created = yield* session.create()
        return fromV1(created)
      })

      const prompt: Interface["prompt"] = Effect.fn("Session.prompt")(function* (input) {
        const id = yield* session.appendUserText({
          sessionID: input.sessionID,
          text: input.text,
        })
        return new SessionEntry.User({
          id: SessionEntry.ID.make(id),
          type: "user",
          text: input.text,
          files: input.files,
          agents: input.agents,
          metadata: input.metadata,
          time: { created: new Date() as never },
        })
      })

      const fromID: Interface["fromID"] = Effect.fn("Session.fromID")(function* (id) {
        const match = yield* session.get(id)
        return fromV1(match)
      })

      return Service.of({
        create,
        prompt,
        fromID,
      })
    }),
  )

  function fromV1(input: Session.Info): Info {
    return new Info({
      id: SessionV2.ID.make(input.id),
    })
  }
}
