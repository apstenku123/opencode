import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  buildRefiningPrompt,
  circlesSignal,
  momentumSignal,
  objectiveSignal,
  parseRefiningResponse,
  refineSextuple,
  scoreCandidate,
  sentimentSignal,
  toSextupleInput,
  tokenize,
  SCORE_KEEP_THRESHOLD,
  W_OBJECTIVE,
  W_SENTIMENT,
  W_CIRCLES,
  W_MOMENTUM,
  type RefiningCandidate,
  type RefiningInput,
} from "../../src/memory/refining"
import type { SextupleSource } from "../../src/memory/schema"

const candidate: RefiningCandidate = {
  keywords: ["mutex", "deadlock"],
  problem: "Service deadlocks on shutdown when logger and timer race for the same lock",
  rootCause: "Logger acquires the timer mutex before its own; timer does the inverse.",
  solution: "Unify lock-ordering: every consumer acquires the logger lock first.",
}

describe("memory/refining — pure 4-signal scorer", () => {
  test("weights sum to 1.0", () => {
    expect(W_OBJECTIVE + W_SENTIMENT + W_CIRCLES + W_MOMENTUM).toBeCloseTo(1.0, 6)
  })

  test("objectiveSignal recognises strong-pass markers", () => {
    expect(objectiveSignal("All 42 tests passed.")).toBe(1.0)
    expect(objectiveSignal("compilation finished — 0 errors")).toBe(1.0)
    expect(objectiveSignal("Build succeeded ✅")).toBe(1.0)
    // Standalone PASS token (case-sensitive in the original).
    expect(objectiveSignal("PASS")).toBe(1.0)
  })

  test("objectiveSignal recognises strong-fail markers", () => {
    expect(objectiveSignal("Tests failed — 3 errors")).toBe(0.0)
    expect(objectiveSignal("traceback (most recent call last)")).toBe(0.0)
    expect(objectiveSignal("FAIL")).toBe(0.0)
    // Failure trumps pass when both appear in the same blob.
    expect(objectiveSignal("compiled successfully but test FAILED.")).toBe(0.0)
  })

  test("objectiveSignal returns 0.5 when no signal", () => {
    expect(objectiveSignal()).toBe(0.5)
    expect(objectiveSignal("just some neutral text")).toBe(0.5)
  })

  test("sentimentSignal recognises positive vocabulary (English)", () => {
    expect(sentimentSignal(["it works now, thanks"])).toBe(1.0)
    expect(sentimentSignal(["awesome, perfect"])).toBe(1.0)
  })

  test("sentimentSignal recognises positive vocabulary (Russian)", () => {
    expect(sentimentSignal(["спасибо, наконец работает"])).toBe(1.0)
  })

  test("sentimentSignal recognises negative vocabulary", () => {
    expect(sentimentSignal(["still broken, doesn't work"])).toBe(0.0)
    expect(sentimentSignal(["не работает блять"])).toBe(0.0)
  })

  test("sentimentSignal returns 0.5 on no input or neutral", () => {
    expect(sentimentSignal([])).toBe(0.5)
    expect(sentimentSignal(["ok then"])).toBe(0.5)
  })

  test("circlesSignal returns 1.0 when there are <2 messages", () => {
    expect(circlesSignal([])).toBe(1.0)
    expect(circlesSignal(["only one"])).toBe(1.0)
  })

  test("circlesSignal drops to 0.2 when last 2 messages overlap heavily", () => {
    // 100% overlap → > CIRCLES_HIGH_OVERLAP (0.6).
    expect(circlesSignal(["fix the websocket reconnect bug", "fix the websocket reconnect bug"])).toBe(0.2)
  })

  test("circlesSignal returns 1.0 when last 2 messages are dissimilar", () => {
    expect(
      circlesSignal(["fix the websocket reconnect bug", "switch the database driver to native"]),
    ).toBe(1.0)
  })

  test("momentumSignal recognises forward-progress vocabulary", () => {
    expect(momentumSignal(["next, let's tackle the migrations"])).toBe(1.0)
    expect(momentumSignal(["далее переходим к рефакторингу"])).toBe(1.0)
  })

  test("momentumSignal recognises stalled vocabulary", () => {
    expect(momentumSignal(["still stuck on the same issue"])).toBe(0.0)
    expect(momentumSignal(["опять по кругу"])).toBe(0.0)
  })

  test("scoreCandidate combines signals via weights", () => {
    const score = scoreCandidate({
      candidate,
      recentUserMessages: ["thanks, it works now"],
      tailSummary: "All tests passed.",
    })
    // objective=1.0, sentiment=1.0, circles=1.0 (n<2), momentum=0.5 (no markers in "thanks, it works now")
    expect(score.objective).toBe(1.0)
    expect(score.sentiment).toBe(1.0)
    expect(score.circles).toBe(1.0)
    expect(score.momentum).toBe(0.5)
    expect(score.total).toBeCloseTo(W_OBJECTIVE + W_SENTIMENT + W_CIRCLES + W_MOMENTUM * 0.5, 6)
    expect(score.total).toBeGreaterThan(SCORE_KEEP_THRESHOLD)
  })

  test("scoreCandidate stays below threshold for negative tail + circles", () => {
    const score = scoreCandidate({
      candidate,
      recentUserMessages: [
        "still broken, doesn't work",
        "still broken, doesn't work",
        "still broken, doesn't work",
      ],
      tailSummary: "Tests failed — segfault on init.",
    })
    expect(score.total).toBeLessThan(SCORE_KEEP_THRESHOLD)
  })

  test("tokenize drops <3-char tokens and lowercases", () => {
    const out = tokenize("Hello, world! AB c12 mutex")
    expect(out.has("hello")).toBe(true)
    expect(out.has("world")).toBe(true)
    expect(out.has("mutex")).toBe(true)
    expect(out.has("ab")).toBe(false) // too short
    expect(out.has("c12")).toBe(true) // exactly 3 chars
  })
})

describe("memory/refining — buildRefiningPrompt + parseRefiningResponse", () => {
  test("buildRefiningPrompt substitutes candidate JSON + score summary", () => {
    const score = {
      objective: 1,
      sentiment: 1,
      circles: 1,
      momentum: 0.5,
      total: 0.925,
    }
    const prompt = buildRefiningPrompt(candidate, score)
    expect(prompt).toContain("Service deadlocks on shutdown")
    expect(prompt).toContain("total=0.93")
    expect(prompt).not.toContain("{candidate_json}")
    expect(prompt).not.toContain("{score_summary}")
  })

  test("parseRefiningResponse handles direct JSON", () => {
    const out = parseRefiningResponse(
      JSON.stringify({
        keywords: ["a", "b"],
        problem: "p",
        root_cause: "r",
        solution: "s",
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.keywords).toEqual(["a", "b"])
    expect(out!.rootCause).toBe("r")
  })

  test("parseRefiningResponse handles fenced JSON + surrounding chatter", () => {
    const out = parseRefiningResponse(
      'Sure!\n```json\n{"keywords":["k"],"problem":"p","root_cause":"r","solution":"s"}\n```\n',
    )
    expect(out).not.toBeNull()
    expect(out!.keywords).toEqual(["k"])
  })

  test("parseRefiningResponse returns null on garbage", () => {
    expect(parseRefiningResponse("not json")).toBeNull()
    expect(parseRefiningResponse('{"problem": "missing fields"}')).toBeNull()
  })
})

describe("memory/refining — refineSextuple", () => {
  test("rejects below-threshold candidates without invoking the LLM", async () => {
    let called = false
    const out = await Effect.runPromise(
      refineSextuple(
        {
          candidate,
          recentUserMessages: ["still broken, doesn't work"],
          tailSummary: "test failed: panic in init",
        } satisfies RefiningInput,
        {
          model: () => {
            called = true
            return Effect.succeed("never used")
          },
        },
      ),
    )
    expect(called).toBe(false)
    expect(out.refined).toBeNull()
    expect(out.path).toBe("gate-rejected")
  })

  test("keeps verbatim when no model is supplied", async () => {
    const out = await Effect.runPromise(
      refineSextuple({
        candidate,
        recentUserMessages: ["thanks, works now"],
        tailSummary: "All tests passed.",
      }),
    )
    expect(out.refined).toEqual(candidate)
    expect(out.path).toBe("kept-verbatim")
  })

  test("polishes via LLM when model returns valid JSON", async () => {
    const polished = {
      keywords: ["mutex", "ordering"],
      problem: "shutdown deadlock",
      root_cause: "logger / timer lock-ordering inversion",
      solution: "unify ordering: logger first",
    }
    const out = await Effect.runPromise(
      refineSextuple(
        {
          candidate,
          recentUserMessages: ["thanks, works now"],
          tailSummary: "All tests passed.",
        },
        {
          model: () => Effect.succeed(JSON.stringify(polished)),
        },
      ),
    )
    expect(out.path).toBe("llm-polished")
    expect(out.refined).not.toBeNull()
    expect(out.refined!.keywords).toEqual(["mutex", "ordering"])
    expect(out.refined!.problem).toBe("shutdown deadlock")
  })

  test("falls back to verbatim on LLM error", async () => {
    const out = await Effect.runPromise(
      refineSextuple(
        {
          candidate,
          recentUserMessages: ["thanks, works now"],
          tailSummary: "All tests passed.",
        },
        {
          model: () => Effect.fail(new Error("offline")) as unknown as Effect.Effect<string | null, unknown>,
        },
      ),
    )
    expect(out.path).toBe("kept-verbatim")
    expect(out.refined).toEqual(candidate)
  })

  test("falls back to verbatim on parse error", async () => {
    const out = await Effect.runPromise(
      refineSextuple(
        {
          candidate,
          recentUserMessages: ["thanks, works now"],
          tailSummary: "All tests passed.",
        },
        {
          model: () => Effect.succeed("garbage non-json"),
        },
      ),
    )
    expect(out.path).toBe("kept-verbatim")
    expect(out.refined).toEqual(candidate)
  })
})

describe("memory/refining — toSextupleInput", () => {
  const source: SextupleSource = { _tag: "rollout", threadID: "t-1", timestamp: 1 }

  test("returns a valid input when fields pass validation", () => {
    const out = toSextupleInput(candidate, source, "proj-A")
    expect(out).not.toBeNull()
    expect(out!.projectID).toBe("proj-A")
    expect(out!.keywords).toEqual(["mutex", "deadlock"])
  })

  test("returns null when no keywords survive cleanup", () => {
    const out = toSextupleInput({ ...candidate, keywords: [" ", ""] }, source)
    expect(out).toBeNull()
  })

  test("returns null when problem is empty", () => {
    const out = toSextupleInput({ ...candidate, problem: "  " }, source)
    expect(out).toBeNull()
  })
})
