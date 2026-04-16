import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("thread/turn compat", () => {
  test("archive and unarchive roundtrip", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "thread-compat" })
        const app = Server.Default().app

        const archived = await app.request(`/thread/${session.id}/archive`, { method: "POST" })
        expect(archived.status).toBe(200)
        const a = await archived.json()
        expect(a.time.archived).toEqual(expect.any(Number))

        const read = await app.request(`/thread/${session.id}`)
        expect(read.status).toBe(200)
        const r = await read.json()
        expect(r.time.archived).toEqual(expect.any(Number))

        const unarchived = await app.request(`/thread/${session.id}/unarchive`, { method: "POST" })
        expect(unarchived.status).toBe(200)
      },
    })
  })

  test("turn steer alias works", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const res = await app.request("/turn/steer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadID: session.id, prompt: "continue" }),
        })

        expect(res.status).toBe(200)
      },
    })
  })

  test("turn start maps upstream output_schema and keeps it per-turn only", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }

        const first = await app.request("/turn/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ thread_id: session.id, input: "hello", output_schema: schema }),
        })

        expect(first.status).toBe(200)

        const second = await app.request("/turn/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ thread_id: session.id, input: "next" }),
        })

        expect(second.status).toBe(200)
      },
    })
  })
})
