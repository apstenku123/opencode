import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  STEP_A_PROMPT,
  extract,
  fallbackRegex,
  findJsonObject,
  parseStepAJson,
  truncateTail,
} from "@/autobest/llm-extract"

describe("autobest/llm-extract", () => {
  describe("truncateTail", () => {
    test("returns input unchanged when below limit", () => {
      expect(truncateTail("hello world", 6000)).toBe("hello world")
    })

    test("truncates to byte budget at char boundary", () => {
      const text = "a".repeat(10_000)
      const result = truncateTail(text, 100)
      expect(result.length).toBeLessThanOrEqual(100)
      expect(result.length).toBeGreaterThan(50)
    })

    test("preserves UTF-8 multi-byte chars at boundary", () => {
      const text = "hello " + "\u{1F600}".repeat(1000) // 4 bytes each
      const result = truncateTail(text, 100)
      // Decoding must not throw and must not produce replacement chars for clean cuts.
      expect(result).not.toContain("\uFFFD")
    })
  })

  describe("findJsonObject", () => {
    test("returns direct JSON object", () => {
      expect(findJsonObject('{"items":["a"]}')).toBe('{"items":["a"]}')
    })

    test("strips code fences", () => {
      expect(findJsonObject('```json\n{"items":["a"]}\n```')).toBe('{"items":["a"]}')
    })

    test("extracts first balanced object from surrounding prose", () => {
      const text = 'prefix text {"items":["one","two"],"complaint":false} trailing'
      expect(findJsonObject(text)).toBe('{"items":["one","two"],"complaint":false}')
    })

    test("handles nested objects", () => {
      const text = '{"a":{"b":{"c":1}},"d":2}'
      expect(findJsonObject(text)).toBe('{"a":{"b":{"c":1}},"d":2}')
    })

    test("tolerates quoted braces inside strings", () => {
      const text = '{"items":["curly { inside"],"complaint":false}'
      expect(findJsonObject(text)).toBe(text)
    })

    test("returns undefined for no object", () => {
      expect(findJsonObject("no json here")).toBeUndefined()
    })
  })

  describe("parseStepAJson", () => {
    test("parses plain items array", () => {
      const parsed = parseStepAJson('{"items":["alpha","beta"],"complaint":false,"complaint_reason":null}')
      expect(parsed).toEqual({ items: ["alpha", "beta"], complaint: false })
    })

    test("extracts complaint + reason", () => {
      const parsed = parseStepAJson('{"items":[],"complaint":true,"complaint_reason":"needs API docs"}')
      expect(parsed).toEqual({ items: [], complaint: true, complaintReason: "needs API docs" })
    })

    test("drops non-string items", () => {
      const parsed = parseStepAJson('{"items":["a",1,null,"b"],"complaint":false}')
      expect(parsed?.items).toEqual(["a", "b"])
    })

    test("handles code fences around JSON", () => {
      const parsed = parseStepAJson('```json\n{"items":["x"],"complaint":false}\n```')
      expect(parsed?.items).toEqual(["x"])
    })

    test("returns undefined on malformed payload", () => {
      expect(parseStepAJson("not json")).toBeUndefined()
      expect(parseStepAJson('{"items":[')).toBeUndefined()
    })
  })

  describe("fallbackRegex", () => {
    test("matches markdown bullet syntax", () => {
      const out = fallbackRegex("- first thing\n- second\n* third")
      expect(out.map((c) => c.key)).toEqual(["first thing", "second", "third"])
      expect(out.every((c) => c.reason?.includes("bullet-fallback"))).toBe(true)
    })

    test("matches numbered list syntax", () => {
      const out = fallbackRegex("1. alpha\n2) beta")
      expect(out.map((c) => c.key)).toEqual(["alpha", "beta"])
    })

    test("assigns descending score by line position", () => {
      const out = fallbackRegex("- first\n- second\n- third")
      expect(out[0].score).toBeGreaterThan(out[1].score)
      expect(out[1].score).toBeGreaterThan(out[2].score)
    })

    test("returns empty array for prose without bullets", () => {
      expect(fallbackRegex("this is a plain paragraph without bullets.")).toEqual([])
    })
  })

  describe("extract (Effect)", () => {
    test("falls back to regex when LLM unavailable", async () => {
      const result = await Effect.runPromise(extract("- one\n- two\n- three", { useLlm: false }))
      expect(result.candidates.map((c) => c.key)).toEqual(["one", "two", "three"])
      expect(result.reason).toBe("regex-fallback")
      expect(result.modelUsed).toBe("regex-fallback")
      expect(result.stepKind).toBe("a")
      expect(result.complaint).toBe(false)
    })

    test("uses LLM output when available", async () => {
      const mockModel = (_prompt: string) =>
        Effect.succeed('{"items":["rerun failing test","tighten repro"],"complaint":false,"complaint_reason":null}')
      const result = await Effect.runPromise(
        extract("anything", { model: mockModel, modelID: "gpt-4.1" }),
      )
      expect(result.candidates.map((c) => c.key)).toEqual(["rerun failing test", "tighten repro"])
      expect(result.reason).toBe("llm-step-a")
      expect(result.modelUsed).toBe("gpt-4.1")
      expect(result.candidates.every((c) => c.reason?.includes("llm-step-a"))).toBe(true)
      // Scores descending by index.
      expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score)
    })

    test("propagates complaint + reason", async () => {
      const mockModel = (_prompt: string) =>
        Effect.succeed('{"items":[],"complaint":true,"complaint_reason":"missing API contract"}')
      const result = await Effect.runPromise(extract("help me find the contract", { model: mockModel }))
      expect(result.complaint).toBe(true)
      expect(result.complaintReason).toBe("missing API contract")
      expect(result.candidates).toEqual([])
      expect(result.reason).toBe("llm-step-a-empty")
    })

    test("drops items shorter than minItemChars", async () => {
      const mockModel = (_prompt: string) =>
        Effect.succeed('{"items":["ok","this-item-is-fine","a"],"complaint":false}')
      const result = await Effect.runPromise(extract("x", { model: mockModel, minItemChars: 5 }))
      expect(result.candidates.map((c) => c.key)).toEqual(["this-item-is-fine"])
    })

    test("caps candidates at maxItems", async () => {
      const mockModel = (_prompt: string) =>
        Effect.succeed('{"items":["aaaaa","bbbbb","ccccc","ddddd","eeeee","fffff"],"complaint":false}')
      const result = await Effect.runPromise(extract("x", { model: mockModel, maxItems: 3 }))
      expect(result.candidates.map((c) => c.key)).toEqual(["aaaaa", "bbbbb", "ccccc"])
    })

    test("falls back to regex on LLM error", async () => {
      const mockModel = (_prompt: string) => Effect.fail(new Error("upstream timeout"))
      const result = await Effect.runPromise(extract("- bullet one\n- bullet two", { model: mockModel }))
      expect(result.candidates.map((c) => c.key)).toEqual(["bullet one", "bullet two"])
      expect(result.reason).toBe("llm-error-regex-fallback")
    })

    test("falls back to regex on LLM parse failure", async () => {
      const mockModel = (_prompt: string) => Effect.succeed("not json at all")
      const result = await Effect.runPromise(extract("- fallback one\n- fallback two", { model: mockModel }))
      expect(result.candidates.map((c) => c.key)).toEqual(["fallback one", "fallback two"])
      expect(result.reason).toBe("llm-parse-fail-regex-fallback")
    })

    test("reports empty result when both LLM parse and regex yield nothing", async () => {
      const mockModel = (_prompt: string) => Effect.succeed("garbage")
      const result = await Effect.runPromise(extract("prose without bullets", { model: mockModel }))
      expect(result.candidates).toEqual([])
      expect(result.reason).toBe("llm-parse-fail-empty")
    })

    test("STEP_A_PROMPT injects the tail", async () => {
      let captured = ""
      const mockModel = (prompt: string) => {
        captured = prompt
        return Effect.succeed('{"items":[],"complaint":false}')
      }
      await Effect.runPromise(extract("HELLO-TAIL-CONTENT", { model: mockModel }))
      expect(captured).toContain("HELLO-TAIL-CONTENT")
      expect(STEP_A_PROMPT).toContain("{{TAIL}}")
    })
  })
})
