import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("thread/turn compat aliases", () => {
  test("thread aliases list/get/setName/fork and autobest aliases work", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "root" })
        const app = Server.Default().app

        const listed = await app.request(`/thread?directory=${encodeURIComponent(tmp.path)}`)
        expect(listed.status).toBe(200)
        const items = (await listed.json()) as any[]
        expect(items.some((item) => item.id === session.id)).toBe(true)

        const got = await app.request(`/thread/${session.id}`)
        expect(got.status).toBe(200)
        expect((await got.json() as any).id).toBe(session.id)

        const renamed = await app.request(`/thread/${session.id}/setName`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "renamed" }),
        })
        expect(renamed.status).toBe(200)
        expect((await renamed.json() as any).title).toBe("renamed")

        const toggled = await app.request(`/thread/${session.id}/autobest/setActive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, ts: 1 }),
        })
        expect(toggled.status).toBe(200)
        expect(await toggled.json()).toEqual({ enabled: true })

        const extracted = await app.request(`/thread/${session.id}/autobest/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ts: 2, candidates: [{ key: "next move", score: 9 }] }),
        })
        expect(extracted.status).toBe(200)
        expect((await extracted.json() as any).selected.key).toBe("next move")

        const forked = await app.request(`/thread/${session.id}/fork`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)
        const forkBody = await forked.json() as any
        expect(typeof forkBody.id).toBe("string")
        expect(forkBody.id).not.toBe(session.id)
      },
    })
  })

  test("turn start and interrupt aliases work", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const started = await app.request(`/turn/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, parts: [{ type: "text", text: "hello" }], agent: "build" }),
        })
        expect(started.status).toBe(200)

        const interrupted = await app.request(`/turn/interrupt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(interrupted.status).toBe(200)
        expect(await interrupted.json()).toBe(true)
      },
    })
  })
})
