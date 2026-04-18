import { describe, expect, test } from "bun:test"
import { appendFile } from "fs/promises"
import { Rollout, RolloutPath, RolloutReader } from "../../src/rollout"
import { SessionID } from "../../src/session/schema"

function newSessionID(): SessionID {
  return SessionID.descending() as unknown as SessionID
}

describe("RolloutReader", () => {
  test("exists returns false for sessions with no rollout", async () => {
    const id = newSessionID()
    expect(await RolloutReader.exists(id)).toBe(false)
  })

  test("readAll returns [] for a missing file", async () => {
    const id = newSessionID()
    const entries = await Rollout.read(id)
    expect(entries).toEqual([])
  })

  test("readAll round-trips written entries", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("custom", { a: 1 })
    await w.append("custom", { a: 2 })
    await w.append("custom", { a: 3 })
    await w.close()

    const entries = await Rollout.read(id)
    expect(entries.length).toBe(3)
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(entries.map((e) => (e.payload as { a: number }).a)).toEqual([1, 2, 3])
  })

  test("readAll skips invalid trailing lines and reports them via onWarn", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    await w.append("custom", { ok: true })
    await w.close()

    await RolloutPath.ensureRoot()
    await appendFile(RolloutPath.forSession(id), "this is not json\n", "utf-8")
    await appendFile(
      RolloutPath.forSession(id),
      JSON.stringify({ missing: "fields" }) + "\n",
      "utf-8",
    )

    const warnings: string[] = []
    const entries = await RolloutReader.readAll(id, {
      onWarn: (m) => warnings.push(m),
    })
    expect(entries.length).toBe(1)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  test("stream yields entries in append order", async () => {
    const id = newSessionID()
    const w = await Rollout.open(id)
    for (let i = 0; i < 5; i++) await w.append("custom", { i })
    await w.close()
    const seen: number[] = []
    for await (const e of Rollout.stream(id)) {
      seen.push((e.payload as { i: number }).i)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })
})
