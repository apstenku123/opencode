import { afterEach, describe, expect, test } from "bun:test"
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
  await Instance.disposeAll()
})

describe("session instruction routes", () => {
  test("inject and eject session-scoped instructions without affecting other sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionA = await svc.create({})
        const sessionB = await svc.create({})

        const empty = await app.request(`/session/${sessionA.id}/instruction`)
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual({ items: [] })

        const injected = await app.request(`/session/${sessionA.id}/instruction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Session-only instruction" }),
        })
        expect(injected.status).toBe(200)
        expect(await injected.json()).toEqual({ items: ["Session-only instruction"] })

        const listedA = await app.request(`/session/${sessionA.id}/instruction`)
        expect(await listedA.json()).toEqual({ items: ["Session-only instruction"] })

        const listedB = await app.request(`/session/${sessionB.id}/instruction`)
        expect(await listedB.json()).toEqual({ items: [] })

        const configA = await app.request(`/session/${sessionA.id}/config`)
        expect(configA.status).toBe(200)
        expect(((await configA.json()) as { instructions?: string[] }).instructions).toContain(
          "Session-only instruction",
        )

        const configB = await app.request(`/session/${sessionB.id}/config`)
        expect(configB.status).toBe(200)
        expect(((await configB.json()) as { instructions?: string[] }).instructions ?? []).not.toContain(
          "Session-only instruction",
        )

        const ejected = await app.request(`/session/${sessionA.id}/instruction`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Session-only instruction" }),
        })
        expect(ejected.status).toBe(200)
        expect(await ejected.json()).toEqual({ items: [] })

        const finalA = await app.request(`/session/${sessionA.id}/instruction`)
        expect(await finalA.json()).toEqual({ items: [] })

        await svc.remove(sessionA.id)
        await svc.remove(sessionB.id)
      },
    })
  })
})
