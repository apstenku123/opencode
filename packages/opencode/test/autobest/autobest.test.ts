import { describe, expect, test } from "bun:test"
import { apply, decide, empty, extract, setActive } from "@/autobest"

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
