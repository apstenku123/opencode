import { describe, expect, test } from "bun:test"
import path from "path"
import { stat } from "fs/promises"
import { RolloutPath } from "../../src/rollout"
import { SessionID } from "../../src/session/schema"

function newSessionID(): SessionID {
  return SessionID.descending() as unknown as SessionID
}

describe("RolloutPath", () => {
  test("root lives under the XDG data dir", () => {
    const r = RolloutPath.root()
    expect(r.endsWith(path.join("opencode", "rollouts"))).toBe(true)
  })

  test("forSession returns <root>/<session-id>.jsonl", () => {
    const id = newSessionID()
    const p = RolloutPath.forSession(id)
    expect(p).toBe(path.join(RolloutPath.root(), `${id}.jsonl`))
  })

  test("stagingFor returns the .tmp sibling of forSession", () => {
    const id = newSessionID()
    expect(RolloutPath.stagingFor(id)).toBe(RolloutPath.forSession(id) + ".tmp")
  })

  test("ensureRoot creates the rollout directory", async () => {
    const r = await RolloutPath.ensureRoot()
    const st = await stat(r)
    expect(st.isDirectory()).toBe(true)
  })
})
