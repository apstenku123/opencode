import { Hono } from "hono"
import z from "zod"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import * as Session from "../../session/session"
import { SessionPrompt } from "../../session/prompt"

function run<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function prompt<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionPrompt.defaultLayer)))
}

export const ThreadRoutes = () =>
  new Hono()
    .get("/", async (c) => {
      const sessions: Session.Info[] = []
      for await (const session of Session.list()) sessions.push(session)
      return c.json(sessions)
    })
    .get("/:threadID", async (c) => {
      const threadID = SessionID.zod.parse(c.req.param("threadID"))
      return c.json(await run(Session.Service.use((svc) => svc.get(threadID))))
    })
    .post("/start", async (c) => {
      const body = await c.req.json().catch(() => ({}))
      return c.json(await run(Session.Service.use((svc) => svc.create(body ?? {}))))
    })
    .post("/:threadID/fork", async (c) => {
      const threadID = SessionID.zod.parse(c.req.param("threadID"))
      const body = await c.req.json().catch(() => ({}))
      return c.json(await run(Session.Service.use((svc) => svc.fork({ ...body, sessionID: threadID }))))
    })
    .post("/:threadID/setName", async (c) => {
      const threadID = SessionID.zod.parse(c.req.param("threadID"))
      const body = await c.req.json()
      await run(Session.Service.use((svc) => svc.setTitle({ sessionID: threadID, title: z.object({ name: z.string() }).parse(body).name })))
      return c.json(await run(Session.Service.use((svc) => svc.get(threadID))))
    })
    .post("/:threadID/archive", async (c) => {
      const threadID = SessionID.zod.parse(c.req.param("threadID"))
      await run(Session.Service.use((svc) => svc.setArchived({ sessionID: threadID, time: Date.now() })))
      return c.json(await run(Session.Service.use((svc) => svc.get(threadID))))
    })
    .post("/:threadID/unarchive", async (c) => {
      const threadID = SessionID.zod.parse(c.req.param("threadID"))
      await run(Session.Service.use((svc) => svc.setArchived({ sessionID: threadID, time: null as any })))
      return c.json(await run(Session.Service.use((svc) => svc.get(threadID))))
    })

export const TurnRoutes = () =>
  new Hono()
    .post("/start", async (c) => {
      const body = await c.req.json()
      const input = z
        .object({
          threadID: SessionID.zod.optional(),
          thread_id: SessionID.zod.optional(),
          input: z.string().optional(),
          parts: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
          outputSchema: z.record(z.string(), z.any()).optional(),
          output_schema: z.record(z.string(), z.any()).optional(),
        })
        .parse(body)
      const sessionID = input.threadID ?? input.thread_id
      const schema = input.outputSchema ?? input.output_schema
      return c.json(
        await prompt(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({
              sessionID: SessionID.zod.parse(sessionID),
              parts: input.parts ?? (input.input ? [{ type: "text", text: input.input }] : []),
              format: schema ? { type: "json_schema", schema, retryCount: 2 } : undefined,
            }),
          ),
        ),
      )
    })
    .post("/interrupt", async (c) => {
      const body = await c.req.json()
      const input = z.object({ threadID: SessionID.zod }).parse(body)
      await prompt(SessionPrompt.Service.use((svc) => svc.cancel(input.threadID)))
      return c.json(true)
    })
    .post("/steer", async (c) => {
      const body = await c.req.json()
      const input = z.object({ threadID: SessionID.zod, prompt: z.string() }).parse(body)
      return c.json(
        await prompt(
          SessionPrompt.Service.use((svc) =>
            svc.prompt({
              sessionID: input.threadID,
              parts: [{ type: "text", text: input.prompt }],
            }),
          ),
        ),
      )
    })
