import { describe, expect, test } from "bun:test"
import {
  advanceCycle,
  apply,
  buildCycleAdvanceEvent,
  buildCycleResetEvent,
  decide,
  DEFAULT_CYCLE_CONFIG,
  empty,
  extract,
  reduceCycleEvents,
  resetCycle,
  resolveCycleConfig,
  setActive,
  type CycleEvent,
} from "@/autobest"

describe("autobest", () => {
  test("extract sorts candidates by score then key", () => {
    expect(
      extract({
        candidates: [
          { key: "c", score: 1 },
          { key: "a", score: 3 },
          { key: "b", score: 3 },
        ],
      }),
    ).toEqual({
      active: undefined,
      top: "a",
      candidates: [
        { key: "a", score: 3 },
        { key: "b", score: 3 },
        { key: "c", score: 1 },
      ],
    })
  })

  test("setActive appends a manual pick", () => {
    expect(setActive(empty(), { key: "lane-b", ts: 7 })).toEqual({
      active: { key: "lane-b", source: "manual", ts: 7, score: undefined },
      picks: [{ key: "lane-b", source: "manual", ts: 7, score: undefined }],
    })
  })

  test("setActive preserves cycle state", () => {
    expect(
      setActive(
        {
          ...empty(),
          cycle: {
            iteration: 2,
            stepKind: "c",
            whatNextAsked: true,
          },
        },
        { key: "lane-b", ts: 7 },
      ),
    ).toEqual({
      active: { key: "lane-b", source: "manual", ts: 7, score: undefined },
      picks: [{ key: "lane-b", source: "manual", ts: 7, score: undefined }],
      cycle: {
        iteration: 2,
        stepKind: "c",
        whatNextAsked: true,
      },
    })
  })

  test("decide keeps current active when top candidate is unchanged", () => {
    const state = setActive(empty(), { key: "lane-a", ts: 1, source: "manual", score: 4 })
    expect(
      decide(state, {
        ts: 9,
        candidates: [
          { key: "lane-b", score: 3 },
          { key: "lane-a", score: 4 },
        ],
      }),
    ).toEqual({
      active: { key: "lane-a", source: "manual", ts: 1, score: 4 },
      candidates: [
        { key: "lane-a", score: 4 },
        { key: "lane-b", score: 3 },
      ],
      selected: { key: "lane-a", score: 4 },
      changed: false,
    })
  })

  test("apply promotes the top candidate and records auto pick", () => {
    const out = apply(setActive(empty(), { key: "lane-a", ts: 1 }), {
      ts: 10,
      candidates: [
        { key: "lane-c", score: 8, reason: ["faster"] },
        { key: "lane-a", score: 2 },
      ],
    })
    expect(out).toEqual({
      state: {
        active: { key: "lane-c", score: 8, source: "auto", ts: 10 },
        picks: [
          { key: "lane-a", source: "manual", ts: 1, score: undefined },
          { key: "lane-c", score: 8, source: "auto", ts: 10 },
        ],
      },
      decision: {
        active: { key: "lane-c", score: 8, source: "auto", ts: 10 },
        candidates: [
          { key: "lane-c", score: 8, reason: ["faster"] },
          { key: "lane-a", score: 2 },
        ],
        selected: { key: "lane-c", score: 8, reason: ["faster"] },
        changed: true,
      },
    })
  })

  test("apply is a no-op when there are no candidates", () => {
    const state = setActive(empty(), { key: "lane-a", ts: 1 })
    const out = apply(state, { candidates: [] })
    expect(out.state).toBe(state)
    expect(out.decision).toEqual({
      active: { key: "lane-a", source: "manual", ts: 1, score: undefined },
      candidates: [],
      selected: undefined,
      changed: false,
    })
  })
})

describe("autobest — cycle config (R6 flags)", () => {
  test("DEFAULT_CYCLE_CONFIG is the documented conservative baseline", () => {
    expect(DEFAULT_CYCLE_CONFIG).toEqual({
      askWhereIsPlanOnEmpty: false,
      maxIterations: 3,
      resetOnUserTurn: true,
    })
  })

  test("resolveCycleConfig falls through to defaults on partial override", () => {
    expect(resolveCycleConfig({ askWhereIsPlanOnEmpty: true })).toEqual({
      askWhereIsPlanOnEmpty: true,
      maxIterations: 3,
      resetOnUserTurn: true,
    })
    expect(resolveCycleConfig({ maxIterations: 5 })).toEqual({
      askWhereIsPlanOnEmpty: false,
      maxIterations: 5,
      resetOnUserTurn: true,
    })
  })

  test("advanceCycle propagates whereIsPlanAsked and stagnationDelta", () => {
    const s0 = empty()
    const s1 = advanceCycle(s0, { stepKind: "c", whereIsPlanAsked: true })
    expect(s1.cycle?.whereIsPlanAsked).toBe(true)
    expect(s1.cycle?.iteration).toBe(1)
    const s2 = advanceCycle(s1, { stepKind: "c", stagnationDelta: 1 })
    expect(s2.cycle?.stagnationCount).toBe(1)
    expect(s2.cycle?.whereIsPlanAsked).toBe(true) // preserved
    const s3 = advanceCycle(s2, { stepKind: "a", stagnationDelta: -2 })
    expect(s3.cycle?.stagnationCount).toBe(0) // clamped to 0
  })

  test("resetCycle zeroes iteration", () => {
    const advanced = advanceCycle(empty(), { stepKind: "b", whatNextAsked: true })
    const reset = resetCycle(advanced)
    expect(reset.cycle).toEqual({ iteration: 0, stepKind: "a" })
  })

  test("cycle advance events round-trip whereIsPlanAsked + stagnationCount", () => {
    const ev = buildCycleAdvanceEvent({
      sessionID: "ses-1",
      cycle: {
        iteration: 5,
        stepKind: "c",
        whatNextAsked: true,
        whereIsPlanAsked: true,
        stagnationCount: 2,
      },
      ts: 100,
    })
    expect(ev.whatNextAsked).toBe(true)
    expect(ev.whereIsPlanAsked).toBe(true)
    expect(ev.stagnationCount).toBe(2)
    const reconstructed = reduceCycleEvents([ev])
    expect(reconstructed).toEqual({
      iteration: 5,
      stepKind: "c",
      turnID: undefined,
      whatNextAsked: true,
      whereIsPlanAsked: true,
      stagnationCount: 2,
    })
  })

  test("cycle reset event restores the initial iteration", () => {
    const evs: CycleEvent[] = [
      buildCycleAdvanceEvent({
        sessionID: "s",
        cycle: { iteration: 3, stepKind: "c", whatNextAsked: true },
      }),
      buildCycleResetEvent({ sessionID: "s" }),
    ]
    const state = reduceCycleEvents(evs)
    expect(state).toEqual({ iteration: 0, stepKind: "a" })
  })
})
