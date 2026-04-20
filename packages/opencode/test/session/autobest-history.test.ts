import * as DateTime from "effect/DateTime"
import { describe, expect, test } from "bun:test"
import * as History from "@/history"
import { session as kb } from "@/history/kb"
import * as Autobest from "@/autobest"
import * as SessionAutobest from "@/session/autobest"
import { shouldContinue, DEFAULT_MAX_ITERATIONS } from "@/session/autobest-observer"
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


  test("autobest cycle state advances iteration counter", () => {
    const base = Autobest.empty()
    const once = Autobest.advanceCycle(base, { stepKind: "a", turnID: "t1" })
    // Round-6 (Stream H) extended the cycle bag with `whereIsPlanAsked`
    // and `stagnationCount`. The default values are `undefined` / `0`.
    expect(once.cycle).toEqual({
      iteration: 1,
      stepKind: "a",
      turnID: "t1",
      whatNextAsked: undefined,
      whereIsPlanAsked: undefined,
      stagnationCount: 0,
    })
    const twice = Autobest.advanceCycle(once, { stepKind: "c", whatNextAsked: true })
    expect(twice.cycle?.iteration).toBe(2)
    expect(twice.cycle?.stepKind).toBe("c")
    expect(twice.cycle?.turnID).toBe("t1") // preserved
    expect(twice.cycle?.whatNextAsked).toBe(true)
  })

  test("resetCycle clears iteration counter", () => {
    const advanced = Autobest.advanceCycle(Autobest.advanceCycle(Autobest.empty(), { stepKind: "a" }), {
      stepKind: "c",
    })
    const reset = Autobest.resetCycle(advanced)
    expect(reset.cycle).toEqual({ iteration: 0, stepKind: "a" })
  })

  test("shouldContinue respects maxIterations cap", () => {
    const pre = shouldContinue({
      enabled: true,
      changed: true,
      activeKey: "do thing",
      cycle: { iteration: 2, stepKind: "a" },
      maxIterations: 3,
    })
    expect(pre.shouldContinue).toBe(true)
    expect(pre.reason).toBe("continue")

    const post = shouldContinue({
      enabled: true,
      changed: true,
      activeKey: "do thing",
      cycle: { iteration: 3, stepKind: "a" },
      maxIterations: 3,
    })
    expect(post.shouldContinue).toBe(false)
    expect(post.reason).toBe("max-iterations-reached")
  })

  test("max-iteration denial should persist terminal step d", () => {
    const continuation = shouldContinue({
      enabled: true,
      changed: true,
      activeKey: "do thing",
      cycle: { iteration: 3, stepKind: "a" },
      maxIterations: 3,
    })
    const event = Autobest.buildCycleAdvanceEvent({
      sessionID: "s-max-terminal",
      cycle: {
        iteration: 4,
        stepKind: continuation.shouldContinue ? "a" : "d",
      },
      reason: continuation.shouldContinue ? "step_a" : continuation.reason,
    })
    expect(event.stepKind).toBe("d")
    expect(event.iteration).toBe(4)
    expect(Autobest.reduceCycleEvents([event])).toEqual({
      iteration: 4,
      stepKind: "d",
      turnID: undefined,
      whatNextAsked: undefined,
      whereIsPlanAsked: undefined,
      stagnationCount: undefined,
    })
  })

  test("shouldContinue defaults to DEFAULT_MAX_ITERATIONS", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(3)
    const out = shouldContinue({
      enabled: true,
      changed: true,
      activeKey: "k",
      cycle: { iteration: DEFAULT_MAX_ITERATIONS, stepKind: "a" },
    })
    expect(out.shouldContinue).toBe(false)
  })

  test("shouldContinue halts on explicit stop pattern in last user text", () => {
    const out = shouldContinue({
      enabled: true,
      changed: true,
      activeKey: "k",
      cycle: { iteration: 0, stepKind: "a" },
      lastUserText: "Please /stop the autobest loop",
    })
    expect(out.shouldContinue).toBe(false)
    expect(out.reason).toBe("stop-pattern")
  })

  test("shouldContinue halts when autobest disabled", () => {
    const out = shouldContinue({
      enabled: false,
      changed: true,
      activeKey: "k",
      cycle: { iteration: 0, stepKind: "a" },
    })
    expect(out.shouldContinue).toBe(false)
    expect(out.reason).toBe("autobest-disabled")
  })

  test("shouldContinue halts when candidate did not change", () => {
    const out = shouldContinue({
      enabled: true,
      changed: false,
      activeKey: "k",
      cycle: { iteration: 0, stepKind: "a" },
    })
    expect(out.shouldContinue).toBe(false)
    expect(out.reason).toBe("not-changed")
  })

  test("SessionEvent.Autobest carries extended decision fields", () => {
    const ev = SessionEvent.Autobest.create({
      changed: true,
      candidates: [{ key: "x", score: 9 }],
      stepKind: "a",
      reason: "llm-step-a",
      iteration: 2,
      turnID: "turn-42",
      elapsedMs: 123,
      modelUsed: "gpt-4.1",
      resultingAction: "rerun failing test",
    })
    expect(ev.stepKind).toBe("a")
    expect(ev.reason).toBe("llm-step-a")
    expect(ev.iteration).toBe(2)
    expect(ev.turnID).toBe("turn-42")
    expect(ev.elapsedMs).toBe(123)
    expect(ev.modelUsed).toBe("gpt-4.1")
    expect(ev.resultingAction).toBe("rerun failing test")
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

  test("autobest.result persists the resulting action", async () => {
    const sessionID = "s-autobest-result"
    await clean(sessionID)
    await History.append(sessionID, {
      ts: 60,
      type: "autobest.result",
      sessionID,
      resultingAction: "Where is the plan?",
      selected: { key: "Where is the plan?", score: 100, reason: ["ask_where_is_plan"] },
      changed: true,
      candidates: [{ key: "Where is the plan?", score: 100, reason: ["ask_where_is_plan"] }],
    })
    expect(await History.last(sessionID, "autobest.result")).toEqual({
      ts: 60,
      type: "autobest.result",
      sessionID,
      resultingAction: "Where is the plan?",
      selected: { key: "Where is the plan?", score: 100, reason: ["ask_where_is_plan"] },
      changed: true,
      candidates: [{ key: "Where is the plan?", score: 100, reason: ["ask_where_is_plan"] }],
    })
  })

  test("resultEvent preserves durable extract/result shape", () => {
    expect(
      SessionAutobest.resultEvent({
        sessionID: "s-extract-result",
        ts: 70,
        resultingAction: "follow the plan",
        selected: { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
        changed: true,
        candidates: [
          { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
          { key: "rerun tests", score: 33 },
        ],
      }),
    ).toEqual({
      ts: 70,
      type: "autobest.result",
      sessionID: "s-extract-result",
      resultingAction: "follow the plan",
      selected: { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
      changed: true,
      candidates: [
        { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
        { key: "rerun tests", score: 33 },
      ],
    })
  })

  test("resultEventFromDecision derives durable extract/result shape from a decision", () => {
    expect(
      SessionAutobest.resultEventFromDecision({
        sessionID: "s-decision-result",
        ts: 71,
        decision: {
          active: { key: "follow the plan", score: 99, source: "auto", ts: 72 },
          selected: { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
          changed: true,
          candidates: [
            { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
            { key: "rerun tests", score: 33 },
          ],
        },
      }),
    ).toEqual({
      ts: 72,
      type: "autobest.result",
      sessionID: "s-decision-result",
      resultingAction: "follow the plan",
      selected: { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
      changed: true,
      candidates: [
        { key: "follow the plan", score: 99, reason: ["plan_step_skipped"] },
        { key: "rerun tests", score: 33 },
      ],
    })
  })

})
