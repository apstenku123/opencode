import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { Server } from "../../src/server/server"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("thread request compat", () => {
  test("request_permissions alias lists pending items", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }

    let pending!: Promise<any>
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        pending = AppRuntime.runPromise(
          Permission.Service.use((svc) =>
            svc.ask({
              sessionID: SessionID.make("ses_perm"),
              permission: "edit",
              patterns: ["*"] as any,
              metadata: {},
              always: [],
              ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
            }),
          ),
        ).catch(() => undefined)
      },
    })

    const list = await app.request(`/thread/${SessionID.make("ses_perm")}/request_permissions`, { headers })
    expect(list.status).toBe(200)
    const items = await list.json() as any[]
    expect(items).toHaveLength(1)
    expect(items[0].sessionID).toBe(SessionID.make("ses_perm"))
    void pending
  })

  test("request_user_input alias lists and replies", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
    let pending!: Promise<any>
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        pending = AppRuntime.runPromise(
          Question.Service.use((svc) =>
            svc.ask({
              sessionID: SessionID.make("ses_q"),
              questions: [
                {
                  question: "Pick one",
                  header: "Choice",
                  options: [{ label: "A", description: "alpha" }],
                },
              ],
            }),
          ),
        )
      },
    })

    const list = await app.request(`/thread/${SessionID.make("ses_q")}/request_user_input`, { headers })
    expect(list.status).toBe(200)
    const items = await list.json() as any[]
    expect(items).toHaveLength(1)

    const reply = await app.request(`/thread/${SessionID.make("ses_q")}/request_user_input/${items[0].id}/reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ answers: [["A"]] }),
    })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toBe(true)
    expect(await pending).toEqual([["A"]])
  })
})
