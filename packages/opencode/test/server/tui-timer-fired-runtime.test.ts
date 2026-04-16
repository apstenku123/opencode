import { afterEach, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Log } from "../../src/util"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("tui timer fired route", () => {
  test("publishes timer fired event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create({})))
        const spy = mock(async () => undefined)
        const mod = await import("../../src/bus")
        mock.module("../../src/bus", () => ({
          Bus: {
            ...mod.Bus,
            publish: spy,
          },
        }))
        const app = Server.Default().app
        const body = {
          sessionID: session.id,
          id: "job",
          repeat: true,
          fired_at: 42,
        }
        const res = await app.request("/tui/timer-fired", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(spy).toHaveBeenCalledWith(TuiEvent.TimerFired, body)
      },
    })
  })
})
