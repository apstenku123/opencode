import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { last, read, readByType } from "../../src/history"
import * as History from "../../src/history"
import * as Autobest from "../../src/autobest"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionAutobestObserver } from "../../src/session/autobest-observer"
import { SessionStatus } from "../../src/session/status"
import { SessionRoutes } from "../../src/server/instance/session"
import { Layer, Effect } from "effect"
import { MessageID, PartID } from "../../src/session/schema"

const projectRoot = path.join(__dirname, "../..")

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function fork(input: { sessionID: SessionNs.Info["id"]; messageID?: string }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.fork(input as any)))
}

function setSummary(input: { sessionID: SessionNs.Info["id"]; summary: SessionNs.Info["summary"] }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.setSummary(input)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

function setAutobest(input: { sessionID: SessionNs.Info["id"]; key: string; source?: "manual" | "auto"; score?: number; ts?: number }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.setAutobest(input)))
}

function getAutobest(sessionID: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.getAutobest(sessionID)))
}

function setAutobestEnabled(input: { sessionID: SessionNs.Info["id"]; enabled: boolean; ts?: number }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.setAutobestEnabled(input)))
}

function getAutobestEnabled(sessionID: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.getAutobestEnabled(sessionID)))
}

function applyAutobest(input: { sessionID: SessionNs.Info["id"]; candidates: { key: string; score: number }[]; ts?: number }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.applyAutobest(input)))
}

function removeMessage(input: { sessionID: SessionNs.Info["id"]; messageID: MessageID }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.removeMessage(input)))
}

function removePart(input: { sessionID: SessionNs.Info["id"]; messageID: MessageID; partID: PartID }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.removePart(input)))
}

describe("session history", () => {
  test("session create appends created history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const items = await read(session.id)
        expect(items.some((item) => item.type === "session.created" && item.sessionID === session.id)).toBe(true)
      },
    })
  })

  test("session fork appends forked history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await create({})
        const child = await fork({ sessionID: parent.id })
        const items = await read(child.id)
        expect(items.some((item) => item.type === "session.forked" && item.parentID === parent.id)).toBe(true)
      },
    })
  })

  test("session setSummary appends summary history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        await setSummary({ sessionID: session.id, summary: { additions: 1, deletions: 2, files: 3 } })
        const items = await read(session.id)
        expect(
          items.some(
            (item) =>
              item.type === "session.summary.updated" &&
              item.sessionID === session.id &&
              item.summary?.additions === 1 &&
              item.summary?.deletions === 2 &&
              item.summary?.files === 3,
          ),
        ).toBe(true)
      },
    })
  })

  test("session updateMessage appends message.created history event on first write", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const messageID = MessageID.ascending()
        await updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        expect(await last(session.id, "message.created")).toEqual({
          ts: expect.any(Number),
          type: "message.created",
          sessionID: session.id,
          messageID,
          role: "user",
        })
      },
    })
  })

  test("session updateMessage appends message.updated history event on later write", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const messageID = MessageID.ascending()
        await updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        await updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "followup",
        } as unknown as MessageV2.Info)
        expect(await last(session.id, "message.updated")).toEqual({
          ts: expect.any(Number),
          type: "message.updated",
          sessionID: session.id,
          messageID,
          role: "user",
        })
      },
    })
  })

  test("session updatePart appends part created history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const messageID = MessageID.ascending()
        await updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        const partID = PartID.ascending()
        await updatePart({
          id: partID,
          sessionID: session.id,
          messageID,
          type: "text",
          text: "hello",
        })
        const items = await readByType(session.id, "message.part.created")
        expect(items.some((item) => item.messageID === messageID && item.partID === partID && item.partType === "text")).toBe(true)
      },
    })
  })

  test("session removeMessage appends removed history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const messageID = MessageID.ascending()
        await updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        await removeMessage({ sessionID: session.id, messageID })
        expect(await last(session.id, "message.removed")).toEqual({
          ts: expect.any(Number),
          type: "message.removed",
          sessionID: session.id,
          messageID,
        })
      },
    })
  })

  test("session removePart appends part removed history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const messageID = MessageID.ascending()
        await updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        const partID = PartID.ascending()
        await updatePart({
          id: partID,
          sessionID: session.id,
          messageID,
          type: "text",
          text: "hello",
        })
        await removePart({ sessionID: session.id, messageID, partID })
        expect(await last(session.id, "message.part.removed")).toEqual({
          ts: expect.any(Number),
          type: "message.part.removed",
          sessionID: session.id,
          messageID,
          partID,
        })
      },
    })
  })


  test("session autobest enabled roundtrips through history", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        expect(await getAutobestEnabled(session.id)).toBe(false)
        expect(await setAutobestEnabled({ sessionID: session.id, enabled: true, ts: 5 })).toBe(true)
        expect(await getAutobestEnabled(session.id)).toBe(true)
        expect(await last(session.id, "autobest.enabled")).toEqual({
          ts: 5,
          type: "autobest.enabled",
          sessionID: session.id,
          enabled: true,
        })
      },
    })
  })

  test("session setAutobest appends manual autobest history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const state = await setAutobest({ sessionID: session.id, key: "lane-a", ts: 7 })
        expect(state.active).toEqual({ key: "lane-a", source: "manual", ts: 7, score: undefined })
        expect(await last(session.id, "autobest.active")).toEqual({
          ts: 7,
          type: "autobest.active",
          sessionID: session.id,
          source: "manual",
          key: "lane-a",
          score: undefined,
          changed: true,
          picks: 1,
        })
      },
    })
  })

  test("session applyAutobest appends auto autobest history event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        await setAutobest({ sessionID: session.id, key: "lane-a", ts: 1 })
        const out = await applyAutobest({
          sessionID: session.id,
          ts: 10,
          candidates: [
            { key: "lane-b", score: 9 },
            { key: "lane-a", score: 3 },
          ],
        })
        expect(out.state.active).toEqual({ key: "lane-b", source: "auto", ts: 10, score: 9 })
        expect(await last(session.id, "autobest.active")).toEqual({
          ts: 10,
          type: "autobest.active",
          sessionID: session.id,
          source: "auto",
          key: "lane-b",
          score: 9,
          changed: true,
          picks: 2,
          candidates: [
            { key: "lane-b", score: 9 },
            { key: "lane-a", score: 3 },
          ],
        })
        expect(await getAutobest(session.id)).toEqual(out.state)
      },
    })
  })

  test("session getAutobest hydrates durable cycle state from history", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        await setAutobest({ sessionID: session.id, key: "lane-a", ts: 1 })
        await History.append(
          session.id,
          Autobest.buildCycleAdvanceEvent({
            sessionID: session.id,
            ts: 4,
            cycle: {
              iteration: 4,
              stepKind: "d",
              whatNextAsked: true,
            },
            reason: "max-iterations-reached",
          }),
        )
        expect(await getAutobest(session.id)).toEqual({
          active: { key: "lane-a", source: "manual", ts: 1, score: undefined },
          picks: [{ key: "lane-a", source: "manual", ts: 1, score: undefined }],
          cycle: {
            iteration: 4,
            stepKind: "d",
            turnID: undefined,
            whatNextAsked: true,
            whereIsPlanAsked: undefined,
            stagnationCount: undefined,
          },
        })
      },
    })
  })

  test("session autobest observer extracts ranked candidates from assistant bullets", async () => {
    expect(SessionAutobestObserver.extract(`- tighten failing repro
- rerun focused lane`)).toEqual([
      { key: "tighten failing repro", score: 100 },
      { key: "rerun focused lane", score: 99 },
    ])
  })

  test("session autobest extract route persists autobest.result", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await create({})
        const res = await SessionRoutes().request(`/${session.id}/autobest/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ts: 123,
            candidates: [
              { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
              { key: "rerun tests", score: 55 },
            ],
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
          result: {
            ts: 123,
            type: "autobest.result",
            sessionID: session.id,
            resultingAction: "follow the plan",
            selected: { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
            changed: true,
            candidates: [
              { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
              { key: "rerun tests", score: 55 },
            ],
          },
        })
        expect(await last(session.id, "autobest.result")).toEqual({
          ts: 123,
          type: "autobest.result",
          sessionID: session.id,
          resultingAction: "follow the plan",
          selected: { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
          changed: true,
          candidates: [
            { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
            { key: "rerun tests", score: 55 },
          ],
        })
        expect(await readByType(session.id, "autobest.result")).toHaveLength(1)
      },
    })
  })

})
