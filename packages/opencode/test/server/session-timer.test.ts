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

describe("session timer routes", () => {
  test("creates lists pauses resumes drains and deletes timers through server routes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const empty = await app.request(`/session/${session.id}/timer`)
        if (empty.status !== 200) console.log("EMPTY_TIMER_STATUS", empty.status, await empty.text())
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual([])

        const create = await app.request(`/session/${session.id}/timer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "job", delay: 25, repeat: true }),
        })
        expect(create.status).toBe(200)
        expect(await create.json()).toMatchObject({
          id: "job",
          delay: 25,
          repeat: true,
          active: true,
        })

        const listed = await app.request(`/session/${session.id}/timer`)
        expect(listed.status).toBe(200)
        expect(await listed.json()).toEqual([
          {
            id: "job",
            delay: 25,
            repeat: true,
            active: true,
            next: expect.any(Number),
          },
        ])

        const replaced = await app.request(`/session/${session.id}/timer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "job", delay: 1, repeat: false }),
        })
        expect(replaced.status).toBe(200)
        expect(await replaced.json()).toMatchObject({
          id: "job",
          delay: 1,
          repeat: false,
          active: true,
        })

        const paused = await app.request(`/session/${session.id}/timer/job/pause`, {
          method: "POST",
        })
        expect(paused.status).toBe(200)
        expect(await paused.json()).toMatchObject({ id: "job", active: false, next: null })

        const resumed = await app.request(`/session/${session.id}/timer/job/resume`, {
          method: "POST",
        })
        expect(resumed.status).toBe(200)
        expect(await resumed.json()).toMatchObject({ id: "job", active: true, delay: 1, repeat: false })

        await new Promise((resolve) => setTimeout(resolve, 5))

        const drained = await app.request(`/session/${session.id}/timer/drain?inject=true`, {
          method: "POST",
        })
        expect(drained.status).toBe(200)
        expect(await drained.json()).toMatchObject([{ id: "job" }])

        const msgs = await app.request(`/session/${session.id}/message`)
        expect(msgs.status).toBe(200)
        const body = (await msgs.json()) as any[]
        expect(body.at(-1)?.info.role).toBe("user")
        expect(body.at(-1)?.parts?.[0]?.text).toBe("[timer:job] fired")

        const deleted = await app.request(`/session/${session.id}/timer/job`, {
          method: "DELETE",
        })
        expect(deleted.status).toBe(200)
        expect(await deleted.json()).toBe(true)

        const after = await app.request(`/session/${session.id}/timer`)
        expect(after.status).toBe(200)
        expect(await after.json()).toEqual([])

        await svc.remove(session.id)
      },
    })
  })
})
