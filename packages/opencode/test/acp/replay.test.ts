import { describe, expect, test } from "bun:test"
import { Replay } from "../../src/acp/replay"
import { RequestError } from "@agentclientprotocol/sdk"
import { Rollout, RolloutWriter } from "../../src/rollout"
import { SessionID } from "../../src/session/schema"

function newSessionID(): SessionID {
  return SessionID.descending() as unknown as SessionID
}

describe("Replay.isAvailable", () => {
  test("returns true once the rollout module is wired in", () => {
    // R6 Stream G landed; R7 wired replay to it.
    expect(Replay.isAvailable()).toBe(true)
  })
})

describe("Replay.initializeMeta", () => {
  test("reports unsupported with stream-g reason when available=false", () => {
    const meta = Replay.initializeMeta(false)
    const block = meta[Replay.META_KEY] as Record<string, unknown>
    expect(block.supported).toBe(false)
    expect(typeof block.reason).toBe("string")
    expect(String(block.reason)).toContain("Stream G")
  })

  test("reports supported without reason when available=true", () => {
    const meta = Replay.initializeMeta(true)
    const block = meta[Replay.META_KEY] as Record<string, unknown>
    expect(block.supported).toBe(true)
    expect(block.reason).toBeUndefined()
  })
})

describe("Replay.run", () => {
  test("returns zero-state response when no rollout file exists", async () => {
    const id = newSessionID()
    const result = await Replay.run({ sessionId: id })
    expect(result.sessionId).toBe(id)
    expect(result.replayedCount).toBe(0)
    expect(result.skippedCount).toBe(0)
  })

  test("streams rollout entries through the supplied emitter in order", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("session.created", { role: "user" })
    await w.append("message.updated", { role: "assistant", text: "hi" })
    await w.append("status", { s: "idle" })
    await w.close()

    const emitted: RolloutWriter.Entry[] = []
    const res = await Replay.run({
      sessionId: id,
      emit: async (entry) => {
        emitted.push(entry)
      },
    })
    expect(emitted.length).toBe(3)
    expect(emitted.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(res.replayedCount).toBe(3)
    expect(res.skippedCount).toBe(0)
  })

  test("honours fromIndex / toIndex to restrict replay range", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    for (let i = 0; i < 6; i++) await w.append("custom", { i })
    await w.close()

    const emitted: RolloutWriter.Entry[] = []
    await Replay.run({
      sessionId: id,
      fromIndex: 2,
      toIndex: 4,
      emit: (entry) => {
        emitted.push(entry)
      },
    })
    expect(emitted.map((e) => e.seq)).toEqual([2, 3, 4])
  })

  test("skippedCount increments when the emitter throws", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("custom", { n: 1 })
    await w.append("custom", { n: 2 })
    await w.close()

    const res = await Replay.run({
      sessionId: id,
      emit: (entry) => {
        if (entry.seq === 0) throw new Error("boom")
      },
    })
    expect(res.replayedCount).toBe(1)
    expect(res.skippedCount).toBe(1)
  })
})

describe("Replay.handleOrReject", () => {
  test("still rejects with a RequestError for sessions with no rollout", async () => {
    const id = newSessionID()
    try {
      await Replay.handleOrReject({ sessionId: id })
      throw new Error("handleOrReject should have thrown for missing rollout")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      const err = error as RequestError
      expect(err.code).toBe(Replay.NOT_IMPLEMENTED_CODE)
      const data = err.data as Record<string, unknown>
      expect(data.sessionId).toBe(id)
      expect(data.dependency).toBe("rollout-missing")
    }
  })

  test("replays when rollout file is present", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("custom", { k: 1 })
    await w.close()

    const seen: RolloutWriter.Entry[] = []
    const res = await Replay.handleOrReject({
      sessionId: id,
      emit: (entry) => {
        seen.push(entry)
      },
    })
    expect(seen.length).toBe(1)
    expect(res.replayedCount).toBe(1)
  })
})
