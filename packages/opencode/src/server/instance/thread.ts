import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "../../session"
import { SessionID, MessageID } from "../../session/schema"
import { SessionPrompt } from "../../session/prompt"
import { Permission } from "@/permission"
import { Question } from "../../question"
import { AppRuntime } from "../../effect/app-runtime"
import { Effect } from "effect"
import { errors } from "../error"

export const ThreadRoutes = () =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List threads",
        operationId: "thread.list",
        responses: { 200: { description: "Threads", content: { "application/json": { schema: resolver(Session.Info.array()) } } } },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
          roots: z.coerce.boolean().optional(),
          start: z.coerce.number().optional(),
          search: z.string().optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const items: Session.Info[] = []
        for await (const item of Session.list(query)) items.push(item)
        return c.json(items)
      },
    )
    .get(
      "/:threadID",
      describeRoute({
        summary: "Get thread",
        operationId: "thread.read",
        responses: { 200: { description: "Thread", content: { "application/json": { schema: resolver(Session.Info) } } }, ...errors(400, 404) },
      }),
      validator("param", z.object({ threadID: SessionID.zod })),
      async (c) => c.json(await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(c.req.valid("param").threadID)))) ,
    )
    .post(
      "/start",
      describeRoute({
        summary: "Start thread",
        operationId: "thread.start",
        responses: { 200: { description: "Thread", content: { "application/json": { schema: resolver(Session.Info) } } } },
      }),
      validator("json", Session.CreateInput),
      async (c) => c.json(await AppRuntime.runPromise(Session.Service.use((svc) => svc.create(c.req.valid("json") ?? {})))),
    )
    .post(
      "/:threadID/fork",
      describeRoute({
        summary: "Fork thread",
        operationId: "thread.fork",
        responses: { 200: { description: "Thread", content: { "application/json": { schema: resolver(Session.Info) } } }, ...errors(400, 404) },
      }),
      validator("param", z.object({ threadID: SessionID.zod })),
      validator("json", z.object({ messageID: MessageID.zod.optional() })),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        return c.json(await AppRuntime.runPromise(Session.Service.use((svc) => svc.fork({ sessionID: param.threadID, ...body }))))
      },
    )
    .post(
      "/:threadID/setName",
      describeRoute({
        summary: "Set thread name",
        operationId: "thread.setName",
        responses: { 200: { description: "Thread", content: { "application/json": { schema: resolver(Session.Info) } } }, ...errors(400, 404) },
      }),
      validator("param", z.object({ threadID: SessionID.zod })),
      validator("json", z.object({ title: z.string() })),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        const session = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            yield* svc.setTitle({ sessionID: param.threadID, title: body.title })
            return yield* svc.get(param.threadID)
          }),
        )
        return c.json(session)
      },
    )
    .post(
      "/:threadID/autobest/setActive",
      validator("param", z.object({ threadID: SessionID.zod })),
      validator("json", z.object({ enabled: z.boolean(), ts: z.number().optional() })),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        return c.json({ enabled: await AppRuntime.runPromise(Session.Service.use((svc) => svc.setAutobestEnabled({ sessionID: param.threadID, enabled: body.enabled, ts: body.ts }))) })
      },
    )
    .post(
      "/:threadID/autobest/extract",
      validator("param", z.object({ threadID: SessionID.zod })),
      validator(
        "json",
        z.object({
          candidates: z.array(z.object({ key: z.string(), score: z.number(), reason: z.array(z.string()).optional() })),
          ts: z.number().optional(),
        }),
      ),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        const out = await AppRuntime.runPromise(Session.Service.use((svc) => svc.applyAutobest({ sessionID: param.threadID, candidates: body.candidates, ts: body.ts })))
        return c.json({ active: out.decision.active ?? null, changed: out.decision.changed, selected: out.decision.selected ?? null, candidates: out.decision.candidates })
      },
    )


    .get(
      "/:threadID/request_permissions",
      validator("param", z.object({ threadID: SessionID.zod })),
      async (c) => {
        const threadID = c.req.valid("param").threadID
        const items = await AppRuntime.runPromise(Permission.Service.use((svc) => svc.list()))
        return c.json(items.filter((item) => item.sessionID === threadID))
      },
    )
    .get(
      "/:threadID/request_user_input",
      validator("param", z.object({ threadID: SessionID.zod })),
      async (c) => {
        const threadID = c.req.valid("param").threadID
        const items = await AppRuntime.runPromise(Question.Service.use((svc) => svc.list()))
        return c.json(items.filter((item) => item.sessionID === threadID))
      },
    )
    .post(
      "/:threadID/request_user_input/:requestID/reply",
      validator("param", z.object({ threadID: SessionID.zod, requestID: z.string() })),
      validator("json", z.object({ answers: Question.Answer.zod.array() })),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        await AppRuntime.runPromise(Question.Service.use((svc) => svc.reply({ requestID: param.requestID as any, answers: body.answers })))
        return c.json(true)
      },
    )

export const TurnRoutes = () =>
  new Hono()
    .post(
      "/start",
      validator("json", SessionPrompt.PromptInput),
      async (c) => c.json(await AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.prompt(c.req.valid("json"))))),
    )
    .post(
      "/interrupt",
      validator("json", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        await AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.cancel(c.req.valid("json").sessionID)))
        return c.json(true)
      },
    )
    .post(
      "/steer",
      validator("json", SessionPrompt.PromptInput),
      async (c) => c.json(await AppRuntime.runPromise(SessionPrompt.Service.use((svc) => svc.prompt(c.req.valid("json"))))),
    )
