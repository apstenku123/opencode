import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

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
  mock.restore()
  await Instance.disposeAll()
})

describe("session action routes", () => {
  test("autobest routes get and apply state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const empty = await app.request(`/session/${session.id}/autobest`)
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual({ enabled: false, active: null, picks: [], log: [], result: null })

        const toggle = await app.request(`/session/${session.id}/autobest/enabled`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, ts: 6 }),
        })
        expect(toggle.status).toBe(200)
        expect(await toggle.json()).toEqual({ enabled: true })

        const set = await app.request(`/session/${session.id}/autobest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "lane-a", score: 3, source: "manual", ts: 7 }),
        })
        expect(set.status).toBe(200)
        expect(await set.json()).toEqual({
          active: { key: "lane-a", score: 3, source: "manual", ts: 7 },
          changed: true,
          selected: null,
          candidates: [],
        })

        const get = await app.request(`/session/${session.id}/autobest`)
        expect(get.status).toBe(200)
        expect(await get.json()).toEqual({
          enabled: true,
          active: { key: "lane-a", score: 3, source: "manual", ts: 7 },
          picks: [{ key: "lane-a", score: 3, source: "manual", ts: 7 }],
          log: [],
          result: null,
        })

        const auto = await app.request(`/session/${session.id}/autobest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ts: 10,
            candidates: [
              { key: "lane-b", score: 8, reason: ["best"] },
              { key: "lane-a", score: 3 },
            ],
          }),
        })
        expect(auto.status).toBe(200)
        expect(await auto.json()).toEqual({
          active: { key: "lane-b", score: 8, source: "auto", ts: 10 },
          changed: true,
          selected: { key: "lane-b", score: 8, reason: ["best"] },
          candidates: [
            { key: "lane-b", score: 8, reason: ["best"] },
            { key: "lane-a", score: 3 },
          ],
        })

        const final = await app.request(`/session/${session.id}/autobest`)
        expect(final.status).toBe(200)
        expect(await final.json()).toEqual({
          enabled: true,
          active: { key: "lane-b", score: 8, source: "auto", ts: 10 },
          picks: [
            { key: "lane-a", score: 3, source: "manual", ts: 7 },
            { key: "lane-b", score: 8, source: "auto", ts: 10 },
          ],
          log: [],
          result: {
            ts: 10,
            selected: { key: "lane-b", score: 8, reason: ["best"] },
            changed: true,
            candidates: [
              { key: "lane-b", score: 8, reason: ["best"] },
              { key: "lane-a", score: 3 },
            ],
          },
        })

        const extract = await app.request(`/session/${session.id}/autobest/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ts: 12,
            candidates: [
              { key: "lane-c", score: 9, reason: ["fresh", "best"] },
              { key: "lane-b", score: 8 },
            ],
          }),
        })
        expect(extract.status).toBe(200)
        expect(await extract.json()).toEqual({
          active: { key: "lane-c", score: 9, source: "auto", ts: 12 },
          changed: true,
          selected: { key: "lane-c", score: 9, reason: ["fresh", "best"] },
          candidates: [
            { key: "lane-c", score: 9, reason: ["fresh", "best"] },
            { key: "lane-b", score: 8 },
          ],
          result: {
            ts: 12,
            selected: { key: "lane-c", score: 9, reason: ["fresh", "best"] },
            changed: true,
            candidates: [
              { key: "lane-c", score: 9, reason: ["fresh", "best"] },
              { key: "lane-b", score: 8 },
            ],
          },
        })

        const afterExtract = await app.request(`/session/${session.id}/autobest`)
        expect(afterExtract.status).toBe(200)
        expect(await afterExtract.json()).toEqual({
          enabled: true,
          active: { key: "lane-c", score: 9, source: "auto", ts: 12 },
          picks: [
            { key: "lane-a", score: 3, source: "manual", ts: 7 },
            { key: "lane-b", score: 8, source: "auto", ts: 10 },
            { key: "lane-c", score: 9, source: "auto", ts: 12 },
          ],
          log: [],
          result: {
            ts: 12,
            selected: { key: "lane-c", score: 9, reason: ["fresh", "best"] },
            changed: true,
            candidates: [
              { key: "lane-c", score: 9, reason: ["fresh", "best"] },
              { key: "lane-b", score: 8 },
            ],
          },
        })

      },
    })
  })

  test("timer routes list create pause resume drain and delete", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const empty = await app.request(`/session/${session.id}/timer`)
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual([])

        const created = await app.request(`/session/${session.id}/timer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "job", delay: 1, repeat: false }),
        })
        expect(created.status).toBe(200)
        expect(await created.json()).toMatchObject({ id: "job", delay: 1, repeat: false, active: true })

        const listed = await app.request(`/session/${session.id}/timer`)
        expect(listed.status).toBe(200)
        expect(await listed.json()).toEqual([
          {
            id: "job",
            delay: 1,
            repeat: false,
            active: true,
            next: expect.any(Number),
          },
        ])

        const paused = await app.request(`/session/${session.id}/timer/job/pause`, { method: "POST" })
        expect(paused.status).toBe(200)
        expect(await paused.json()).toMatchObject({ id: "job", active: false, next: null })

        const resumed = await app.request(`/session/${session.id}/timer/job/resume`, { method: "POST" })
        expect(resumed.status).toBe(200)
        expect(await resumed.json()).toMatchObject({ id: "job", delay: 1, repeat: false, active: true })

        await new Promise((resolve) => setTimeout(resolve, 5))

        const drained = await app.request(`/session/${session.id}/timer/drain?inject=true`, { method: "POST" })
        expect(drained.status).toBe(200)
        expect(await drained.json()).toMatchObject([{ id: "job" }])

        const msgs = await app.request(`/session/${session.id}/message`)
        expect(msgs.status).toBe(200)
        const body = (await msgs.json()) as any[]
        expect(body.at(-1)?.info.role).toBe("user")
        expect(body.at(-1)?.parts?.[0]?.text).toBe("[timer:job] fired")

        const deleted = await app.request(`/session/${session.id}/timer/job`, { method: "DELETE" })
        expect(deleted.status).toBe(200)
        expect(await deleted.json()).toBe(true)

        const after = await app.request(`/session/${session.id}/timer`)
        expect(after.status).toBe(200)
        expect(await after.json()).toEqual([])

        await svc.remove(session.id)
      },
    })
  })

  test("abort route returns success", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

        await svc.remove(session.id)
      },
    })
  })
})
