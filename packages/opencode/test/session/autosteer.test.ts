import { describe, test, expect } from "bun:test"
import { SessionAutosteer } from "../../src/session/autosteer"

describe("SessionAutosteer heuristics", () => {
  describe("hasActionMarkers", () => {
    test("returns false on empty string", () => {
      expect(SessionAutosteer.hasActionMarkers("")).toBe(false)
    })

    test("detects fenced code blocks", () => {
      expect(SessionAutosteer.hasActionMarkers("here is code:\n```\nrun\n```")).toBe(true)
    })

    test("detects Edited / Created / Ran markers", () => {
      expect(SessionAutosteer.hasActionMarkers("Edited foo.ts")).toBe(true)
      expect(SessionAutosteer.hasActionMarkers("Created bar.ts")).toBe(true)
      expect(SessionAutosteer.hasActionMarkers("Ran tests")).toBe(true)
    })

    test("returns false for purely discursive text", () => {
      expect(SessionAutosteer.hasActionMarkers("I will think about it later.")).toBe(false)
    })
  })

  describe("isPlanningOnly", () => {
    test("true on planning phrase with no action marker", () => {
      expect(SessionAutosteer.isPlanningOnly("My plan is to refactor the module.")).toBe(true)
      expect(SessionAutosteer.isPlanningOnly("I will now start by reading the file.")).toBe(true)
      expect(SessionAutosteer.isPlanningOnly("here's the plan, step one is audit.")).toBe(true)
    })

    test("false when an action marker is present alongside planning language", () => {
      expect(SessionAutosteer.isPlanningOnly("I will now apply the patch:\n```\nEdited src/foo.ts\n```")).toBe(false)
      expect(SessionAutosteer.isPlanningOnly("My plan is x. Edited src/foo.ts")).toBe(false)
    })

    test("false when no planning phrase is present", () => {
      expect(SessionAutosteer.isPlanningOnly("Done — tests pass.")).toBe(false)
      expect(SessionAutosteer.isPlanningOnly("")).toBe(false)
    })

    test("case-insensitive", () => {
      expect(SessionAutosteer.isPlanningOnly("MY PLAN IS to do X")).toBe(true)
    })
  })

  describe("jaccardSimilarity", () => {
    test("1 for two empty strings", () => {
      expect(SessionAutosteer.jaccardSimilarity("", "")).toBe(1)
    })

    test("0 when one side is empty and the other is not", () => {
      expect(SessionAutosteer.jaccardSimilarity("", "hello world")).toBe(0)
      expect(SessionAutosteer.jaccardSimilarity("hello world", "")).toBe(0)
    })

    test("1 for identical strings", () => {
      expect(SessionAutosteer.jaccardSimilarity("foo bar baz", "foo bar baz")).toBe(1)
    })

    test("tokens are lowercased", () => {
      expect(SessionAutosteer.jaccardSimilarity("Foo BAR", "foo bar")).toBe(1)
    })

    test("partial overlap returns value in (0,1)", () => {
      const sim = SessionAutosteer.jaccardSimilarity("a b c d", "a b e f")
      // {a,b,c,d} vs {a,b,e,f} → intersection 2, union 6 → 2/6
      expect(sim).toBeCloseTo(2 / 6, 10)
    })
  })

  describe("detectStagnation", () => {
    test("false for empty/whitespace response", () => {
      expect(SessionAutosteer.detectStagnation("prev", "")).toBe(false)
      expect(SessionAutosteer.detectStagnation("prev", "   \n   ")).toBe(false)
    })

    test("true for planning-only response regardless of prev", () => {
      expect(SessionAutosteer.detectStagnation(undefined, "My plan is to think harder.")).toBe(true)
    })

    test("false when response has action markers even if planning phrase present", () => {
      const r = "I will now apply this:\n```\nEdited file.ts\n```"
      expect(SessionAutosteer.detectStagnation(undefined, r)).toBe(false)
    })

    test("detects Jaccard similarity above threshold", () => {
      // 9 shared tokens, one differing token each side ⇒ 9/11 ≈ 0.818; need >0.85.
      // Use 19 shared tokens + 1 differing side ⇒ 19/21 ≈ 0.905.
      const shared = "a b c d e f g h i j k l m n o p q r s"
      const prev = shared + " t"
      const cur = shared + " u"
      expect(SessionAutosteer.detectStagnation(prev, cur)).toBe(true)
    })

    test("ignores low similarity to prev when no planning phrase", () => {
      expect(SessionAutosteer.detectStagnation("completely different words", "hello universe")).toBe(false)
    })
  })

  describe("evaluate", () => {
    test("empty response leaves state unchanged and does not nudge", () => {
      const s = { previousResponse: "x", stagnationCount: 1 }
      const out = SessionAutosteer.evaluate(s, "")
      expect(out.nudge).toBe(false)
      expect(out.stagnant).toBe(false)
      expect(out.nextState).toEqual(s)
    })

    test("non-stagnant response resets counter and updates previousResponse", () => {
      const s = { previousResponse: "old stuff", stagnationCount: 3 }
      const r = "```\nEdited src/foo.ts\n```"
      const out = SessionAutosteer.evaluate(s, r)
      expect(out.nudge).toBe(false)
      expect(out.stagnant).toBe(false)
      expect(out.nextState.stagnationCount).toBe(0)
      expect(out.nextState.previousResponse).toBe(r)
    })

    test("first stagnant response bumps counter to 1 but does not nudge", () => {
      const s = { stagnationCount: 0 }
      const r = "My plan is to refactor everything."
      const out = SessionAutosteer.evaluate(s, r)
      expect(out.stagnant).toBe(true)
      expect(out.nudge).toBe(false)
      expect(out.nextState.stagnationCount).toBe(1)
    })

    test("second consecutive stagnant response fires nudge and resets counter", () => {
      const s = { previousResponse: "my plan is to think", stagnationCount: 1 }
      const r = "Here's my plan: think some more."
      const out = SessionAutosteer.evaluate(s, r)
      expect(out.stagnant).toBe(true)
      expect(out.nudge).toBe(true)
      expect(out.nextState.stagnationCount).toBe(0)
    })

    test("similarity-triggered second stagnation fires nudge", () => {
      const shared = "a b c d e f g h i j k l m n o p q r s"
      const prev = shared + " t"
      const r = shared + " u"
      const s = { previousResponse: prev, stagnationCount: 1 }
      const out = SessionAutosteer.evaluate(s, r)
      expect(out.nudge).toBe(true)
    })

    test("alternating healthy→stagnant→healthy keeps counter 0", () => {
      let s: SessionAutosteer.State = { stagnationCount: 0 }
      s = SessionAutosteer.evaluate(s, "```\nEdited a.ts\n```").nextState
      expect(s.stagnationCount).toBe(0)
      s = SessionAutosteer.evaluate(s, "My plan is to try again.").nextState
      expect(s.stagnationCount).toBe(1)
      s = SessionAutosteer.evaluate(s, "Ran tests; all green.").nextState
      expect(s.stagnationCount).toBe(0)
    })
  })

  describe("constants", () => {
    test("NUDGE_TEXT is the canned user-role message", () => {
      expect(SessionAutosteer.NUDGE_TEXT).toMatch(/execute/i)
    })

    test("STAGNATION_TRIGGER matches Rust parity", () => {
      expect(SessionAutosteer.STAGNATION_TRIGGER).toBe(2)
    })
  })

  describe("thresholds overrides", () => {
    test("custom planningPhrases replace the defaults", () => {
      // The default phrase list does not include "будем" — without override
      // the response should not classify as planning-only.
      expect(SessionAutosteer.isPlanningOnly("будем рефакторить позже")).toBe(false)
      // Supplying a custom list flips the verdict.
      expect(
        SessionAutosteer.isPlanningOnly("будем рефакторить позже", { planningPhrases: ["будем"] }),
      ).toBe(true)
    })

    test("empty planningPhrases override disables planning detection", () => {
      expect(SessionAutosteer.isPlanningOnly("My plan is to think.", { planningPhrases: [] })).toBe(false)
    })

    test("custom actionMarkers prevent planning classification", () => {
      // Default action markers don't include "STATUS:" — without override
      // the planning phrase still wins.
      expect(SessionAutosteer.isPlanningOnly("My plan is x. STATUS: done")).toBe(true)
      expect(
        SessionAutosteer.isPlanningOnly("My plan is x. STATUS: done", { actionMarkers: ["STATUS:"] }),
      ).toBe(false)
    })

    test("similarityThreshold is honored", () => {
      const a = "alpha bravo charlie delta"
      const b = "alpha bravo charlie echo" // jaccard ~ 0.6
      // Default threshold (0.85) → not stagnant.
      expect(SessionAutosteer.detectStagnation(a, b)).toBe(false)
      // Lower threshold → flagged.
      expect(SessionAutosteer.detectStagnation(a, b, { similarityThreshold: 0.5 })).toBe(true)
    })

    test("minResponseLength short-circuits short replies", () => {
      // Short planning reply normally counts as stagnant.
      expect(SessionAutosteer.detectStagnation(undefined, "My plan is x.")).toBe(true)
      // With minResponseLength gate above the message length, skipped.
      expect(
        SessionAutosteer.detectStagnation(undefined, "My plan is x.", { minResponseLength: 100 }),
      ).toBe(false)
    })

    test("custom stagnationTrigger fires on the configured count", () => {
      // trigger=1 → first stagnant reply already nudges.
      const out = SessionAutosteer.evaluate(
        { stagnationCount: 0 },
        "My plan is to start.",
        { stagnationTrigger: 1 },
      )
      expect(out.stagnant).toBe(true)
      expect(out.nudge).toBe(true)
    })
  })
})
