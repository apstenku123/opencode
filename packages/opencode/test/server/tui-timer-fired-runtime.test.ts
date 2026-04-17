import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Log } from "../../src/util"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tui timer fired route", () => {
  // Avoid `mock.module("../../src/bus", …)` here: Bun's `mock.restore()` does
  // not undo module-level mocks, so a global Bus replacement leaks into every
  // subsequent test file and breaks any path that publishes via the Bus
  // namespace (e.g. SyncEvent projector fan-out). Subscribing to the real Bus
  // gives the same assertion without polluting module state.
  test("publishes timer fired event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create({})))
        const received: Array<{ type: string; properties: unknown }> = []
        const unsub = Bus.subscribe(TuiEvent.TimerFired, (evt) => {
          received.push({ type: evt.type, properties: evt.properties })
        })
        try {
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

          // Bus.publish delivers via forkScoped streams; give the subscriber a tick.
          for (let i = 0; i < 50 && received.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          expect(received).toHaveLength(1)
          expect(received[0].type).toBe(TuiEvent.TimerFired.type)
          expect(received[0].properties).toEqual(body)
        } finally {
          unsub()
        }
      },
    })
  })
})
