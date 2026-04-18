import { describe, expect, test } from "bun:test"
import { Replay } from "../../src/acp/replay"
import { RequestError } from "@agentclientprotocol/sdk"

describe("Replay.isAvailable", () => {
  test("returns false while Stream G rollout module is outstanding", () => {
    // If Stream G lands, flip this assertion intentionally as a signal
    // that the stub path needs to be replaced by a real implementation.
    expect(Replay.isAvailable()).toBe(false)
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

describe("Replay.run (stub)", () => {
  test("throws RequestError with method-not-found code", async () => {
    await expect(Replay.run({ sessionId: "ses_1" })).rejects.toThrow(RequestError)
    try {
      await Replay.run({ sessionId: "ses_1" })
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      const err = error as RequestError
      expect(err.code).toBe(Replay.NOT_IMPLEMENTED_CODE)
      expect(err.message).toBe(Replay.NOT_IMPLEMENTED_MESSAGE)
      const data = err.data as Record<string, unknown>
      expect(data.notImplemented).toBe(true)
      expect(data.dependency).toBe("stream-g-rollout")
      expect(data.sessionId).toBe("ses_1")
      expect(typeof data.hint).toBe("string")
    }
  })

  test("error message mentions rollout / Stream G so ACP clients can surface a precise reason", async () => {
    try {
      await Replay.run({ sessionId: "s" })
      throw new Error("Replay.run should have thrown")
    } catch (error) {
      const err = error as RequestError
      expect(err.message.toLowerCase()).toContain("rollout")
      expect(err.message).toContain("Stream G")
    }
  })
})

describe("Replay.handleOrReject", () => {
  test("rejects with same RequestError shape as run() while unavailable", async () => {
    try {
      await Replay.handleOrReject({ sessionId: "ses_x", fromIndex: 10 })
      throw new Error("handleOrReject should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      const err = error as RequestError
      expect(err.code).toBe(Replay.NOT_IMPLEMENTED_CODE)
      const data = err.data as Record<string, unknown>
      expect(data.sessionId).toBe("ses_x")
      expect(data.dependency).toBe("stream-g-rollout")
    }
  })
})
