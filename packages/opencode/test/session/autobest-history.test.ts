import * as DateTime from "effect/DateTime"
import { describe, expect, test } from "bun:test"
import * as History from "@/history"
import { session as kb } from "@/history/kb"
import * as SessionAutobest from "@/session/autobest"
import { SessionEvent } from "@/v2/session-event"
import { rm } from "node:fs/promises"

async function clean(sessionID: string) {
  await rm(History.file(sessionID), { force: true }).catch(() => undefined)
}

describe("session autobest history", () => {
  test("append persists autobest decision snapshots", async () => {
    const sessionID = "s-autobest-history"
    await clean(sessionID)
    const out = await SessionAutobest.append(sessionID, { picks: [] }, {
      ts: 10,
      candidates: [
        { key: "a", score: 2, reason: ["fresh"] },
        { key: "b", score: 1 },
      ],
    })
    expect(out.state.active?.key).toBe("a")
    expect(await History.last(sessionID, "autobest.state")).toEqual({
      ts: 10,
      type: "autobest.state",
      sessionID,
      active: { key: "a", score: 2, source: "auto", ts: 10 },
      selected: { key: "a", score: 2, reason: ["fresh"] },
      changed: true,
      candidates: 2,
      top: { key: "a", score: 2, reason: ["fresh"] },
      log: {
        active: { key: "a", score: 2, source: "auto", ts: 10 },
        selected: { key: "a", score: 2, reason: ["fresh"] },
        changed: true,
        candidates: [
          { key: "a", score: 2, reason: ["fresh"] },
          { key: "b", score: 1 },
        ],
      },
    })
  })

  test("kb view exposes latest autobest state", async () => {
    const sessionID = "s-autobest-kb"
    await clean(sessionID)
    await History.append(sessionID, {
      ts: 20,
      type: "autobest.state",
      sessionID,
      active: { key: "x", source: "manual", ts: 5 },
      selected: { key: "x", score: 9 },
      changed: false,
      candidates: 3,
    })
    const view = await kb(sessionID)
    expect(view.counts.autobest_states).toBe(1)
    expect(view.counts.autobest_logs).toBe(0)
    expect(view.latest.autobest).toEqual({
      ts: 20,
      type: "autobest.state",
      sessionID,
      active: { key: "x", source: "manual", ts: 5 },
      selected: { key: "x", score: 9 },
      changed: false,
      candidates: 3,
    })
  })

  test("fromEvent maps protocol autobest events into durable history shape", () => {
    const event = SessionEvent.Autobest.create({
      timestamp: DateTime.makeUnsafe(30),
      metadata: { sessionID: "s-proto" },
      active: { key: "p", source: "auto", ts: 30, score: 4 },
      selected: { key: "p", score: 4, reason: ["top"] },
      changed: true,
      candidates: [{ key: "p", score: 4, reason: ["top"] }],
    })
    expect(SessionAutobest.fromEvent(event)).toEqual({
      ts: 30,
      type: "autobest.state",
      sessionID: "s-proto",
      active: { key: "p", source: "auto", ts: 30, score: 4 },
      selected: { key: "p", score: 4, reason: ["top"] },
      changed: true,
      candidates: 1,
      top: { key: "p", score: 4, reason: ["top"] },
      log: {
        active: { key: "p", source: "auto", ts: 30, score: 4 },
        selected: { key: "p", score: 4, reason: ["top"] },
        changed: true,
        candidates: [{ key: "p", score: 4, reason: ["top"] }],
      },
    })
  })


  test("server autobest route exposes durable decision log", async () => {
    const sessionID = "s-autobest-log"
    await clean(sessionID)
    await SessionAutobest.append(sessionID, { picks: [] }, {
      ts: 50,
      candidates: [
        { key: "b", score: 7, reason: ["best"] },
        { key: "a", score: 2 },
      ],
    })
    const view = await kb(sessionID)
    expect(view.counts.autobest_logs).toBe(1)
    expect(view.latest.autobest_log).toEqual({
      ts: 50,
      sessionID,
      active: { key: "b", score: 7, source: "auto", ts: 50 },
      selected: { key: "b", score: 7, reason: ["best"] },
      changed: true,
      candidates: [
        { key: "b", score: 7, reason: ["best"] },
        { key: "a", score: 2 },
      ],
    })
  })

})
