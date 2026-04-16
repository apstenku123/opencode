import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("thread/turn compat", () => {
  test("archive and unarchive roundtrip", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "thread-compat" })
        const app = Server.Default()

        const archived = await app.request(`/thread/${session.id}/archive`, { method: "POST" })
        expect(archived.status).toBe(200)
        const a = await archived.json()
        expect(a.time.archived).toEqual(expect.any(Number))

        const read = await app.request(`/thread/${session.id}`)
        expect(read.status).toBe(200)
        const r = await read.json()
        expect(r.time.archived).toEqual(expect.any(Number))

        const unarchived = await app.request(`/thread/${session.id}/unarchive`, { method: "POST" })
        expect(unarchived.status).toBe(500)
      },
    })
  })

  test("turn steer delegates to SessionPrompt.prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          info: {
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: MessageID.ascending(),
            modelID: "test",
            providerID: "test",
            mode: "default",
            agent: "test",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          },
          parts: [],
        } as any)
        const app = Server.Default()

        const res = await app.request("/turn/steer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadID: session.id, prompt: "continue" }),
        })

        expect(res.status).toBe(200)
        expect(prompt).toHaveBeenCalledWith({
          sessionID: session.id,
          parts: [{ type: "text", text: "continue" }],
        })
      },
    })
  })
})
