import { describe, expect, test } from "bun:test"
import { Rollout, RolloutReplay, RolloutWriter } from "../../src/rollout"
import { SessionID } from "../../src/session/schema"

function newSessionID(): SessionID {
  return SessionID.descending() as unknown as SessionID
}

describe("RolloutReplay", () => {
  test("replayToMemory on empty log returns a zero state", async () => {
    const id = newSessionID()
    const state = await Rollout.replay(id)
    expect(state.sessionID).toBe(id)
    expect(state.entries.length).toBe(0)
    expect(state.kinds).toEqual({})
    expect(state.firstTime).toBeUndefined()
    expect(state.lastTime).toBeUndefined()
    expect(state.lastSeq).toBeUndefined()
  })

  test("replayToMemory aggregates kind counts and time bounds", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("session.created", {})
    await w.append("message.updated", { role: "user" })
    await w.append("message.updated", { role: "assistant" })
    await w.append("status", { s: "idle" })
    await w.close()

    const state = await Rollout.replay(id)
    expect(state.entries.length).toBe(4)
    expect(state.kinds["message.updated"]).toBe(2)
    expect(state.kinds["session.created"]).toBe(1)
    expect(state.kinds["status"]).toBe(1)
    expect(state.lastSeq).toBe(3)
    expect(state.firstTime).toBeLessThanOrEqual(state.lastTime!)
  })

  test("replayToMemory honors sinceSeq / untilSeq", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    for (let i = 0; i < 10; i++) await w.append("custom", { i })
    await w.close()

    const middle = await Rollout.replay(id, { sinceSeq: 3, untilSeq: 6 })
    expect(middle.entries.map((e) => e.seq)).toEqual([3, 4, 5, 6])
  })

  test("replayToEmitter invokes the emitter once per entry in order", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("custom", { n: 1 })
    await w.append("custom", { n: 2 })
    await w.append("custom", { n: 3 })
    await w.close()

    const emitted: RolloutWriter.Entry[] = []
    const state = await RolloutReplay.replayToEmitter(id, async (e) => {
      emitted.push(e)
    })
    expect(emitted.length).toBe(3)
    expect(emitted.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(state.lastSeq).toBe(2)
  })
})
