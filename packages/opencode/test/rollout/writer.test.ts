import { describe, expect, test } from "bun:test"
import { readFile, stat } from "fs/promises"
import { Rollout, RolloutPath, RolloutWriter } from "../../src/rollout"
import { SessionID } from "../../src/session/schema"

function newSessionID(): SessionID {
  return SessionID.descending() as unknown as SessionID
}

describe("RolloutWriter", () => {
  test("open creates a writer with the right file path", async () => {
    const id = newSessionID()
    const writer = await Rollout.open(id)
    expect(writer.sessionID).toBe(id)
    expect(writer.filePath).toBe(RolloutPath.forSession(id))
    await writer.close()
  })

  test("append produces monotonic sequence numbers starting at 0", async () => {
    const id = newSessionID()
    const writer = await Rollout.open(id)
    const a = await writer.append("custom", { i: 0 })
    const b = await writer.append("custom", { i: 1 })
    const c = await writer.append("custom", { i: 2 })
    expect(a.seq).toBe(0)
    expect(b.seq).toBe(1)
    expect(c.seq).toBe(2)
    await writer.close()
  })

  test("flush persists entries as JSONL on disk", async () => {
    const id = newSessionID()
    const writer = await Rollout.open(id)
    await writer.append("session.created", { title: "x" })
    await writer.append("message.updated", { role: "user" })
    await writer.flush()
    const text = await readFile(writer.filePath, "utf-8")
    const lines = text.split(/\n/).filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].kind).toBe("session.created")
    expect(parsed[0].seq).toBe(0)
    expect(parsed[1].kind).toBe("message.updated")
    expect(parsed[1].seq).toBe(1)
    await writer.close()
  })

  test("close performs atomic snapshot rewrite", async () => {
    const id = newSessionID()
    const writer = await Rollout.open(id)
    await writer.append("status", { s: "busy" })
    await writer.close()
    const st = await stat(writer.filePath)
    expect(st.isFile()).toBe(true)
    expect(st.size).toBeGreaterThan(0)
  })

  test("resumes sequence numbering from the existing tail", async () => {
    const id = newSessionID()
    const w1 = await Rollout.open(id)
    await w1.append("custom", { i: 0 })
    await w1.append("custom", { i: 1 })
    await w1.close()

    const w2 = await Rollout.open(id)
    const next = await w2.append("custom", { i: 2 })
    expect(next.seq).toBe(2)
    await w2.close()
  })

  test("append after close throws", async () => {
    const id = newSessionID()
    const writer = await Rollout.open(id)
    await writer.close()
    await expect(writer.append("custom", {})).rejects.toThrow(/close/)
  })

  test("Kind schema rejects unknown kinds", () => {
    const parsed = RolloutWriter.Kind.safeParse("not-a-real-kind")
    expect(parsed.success).toBe(false)
  })
})
