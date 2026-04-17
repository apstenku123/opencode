import { describe, expect, test } from "bun:test"
import {
  cleanKeywords,
  decodeEmbedding,
  embeddingKey,
  encodeEmbedding,
  hashId,
  normalizeForHash,
  validateInput,
  type DefectSextupleInput,
} from "../../src/memory/schema"

describe("memory/schema — pure helpers", () => {
  test("normalizeForHash collapses whitespace and trims", () => {
    expect(normalizeForHash("  hello\n\tworld  ")).toBe("hello world")
    expect(normalizeForHash("a\n\n\nb")).toBe("a b")
    expect(normalizeForHash("nochange")).toBe("nochange")
  })

  test("cleanKeywords trims, drops empties, dedupes while preserving order", () => {
    expect(cleanKeywords(["a", " b ", "", "a", "c"])).toEqual(["a", "b", "c"])
    expect(cleanKeywords([])).toEqual([])
    expect(cleanKeywords(["  "])).toEqual([])
  })

  test("embeddingKey formats per MemCoder paper", () => {
    expect(embeddingKey({ keywords: ["race", "lock"], problem: "deadlock on shutdown" })).toBe(
      "race lock [PROBLEM] deadlock on shutdown",
    )
  })

  test("hashId is stable across whitespace variations", () => {
    const h1 = hashId({ problem: "  hello\nworld  ", rootCause: "why", solution: "do x" })
    const h2 = hashId({ problem: "hello world", rootCause: "why", solution: "do x" })
    expect(h1).toBe(h2)
  })

  test("hashId differs when any tuple field changes", () => {
    const base = { problem: "p", rootCause: "r", solution: "s" }
    expect(hashId(base)).not.toBe(hashId({ ...base, problem: "p2" }))
    expect(hashId(base)).not.toBe(hashId({ ...base, rootCause: "r2" }))
    expect(hashId(base)).not.toBe(hashId({ ...base, solution: "s2" }))
  })

  test("hashId produces 64-char hex (sha256)", () => {
    const h = hashId({ problem: "p", rootCause: "r", solution: "s" })
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  test("0x1F separator: cannot collide across field boundaries", () => {
    // "ab" with empty second field is distinct from "a"+"b" — the 0x1F
    // separator guarantees injectivity of the concatenated pre-image.
    const h1 = hashId({ problem: "ab", rootCause: "", solution: "" })
    const h2 = hashId({ problem: "a", rootCause: "b", solution: "" })
    const h3 = hashId({ problem: "a", rootCause: "", solution: "b" })
    expect(h1).not.toBe(h2)
    expect(h2).not.toBe(h3)
    expect(h1).not.toBe(h3)
  })

  describe("validateInput", () => {
    const base: DefectSextupleInput = {
      keywords: ["a"],
      problem: "p",
      rootCause: "r",
      solution: "s",
      source: { _tag: "rollout", threadID: "t1", timestamp: 0 },
    }

    test("accepts a well-formed input", () => {
      expect(validateInput(base)).toBeUndefined()
    })

    test("rejects empty keywords", () => {
      const err = validateInput({ ...base, keywords: [] })
      expect(err?.message).toMatch(/keywords/)
    })

    test("rejects all-whitespace keywords", () => {
      const err = validateInput({ ...base, keywords: ["", "   "] })
      expect(err?.message).toMatch(/keywords/)
    })

    test("rejects empty problem", () => {
      const err = validateInput({ ...base, problem: "   " })
      expect(err?.message).toMatch(/problem/)
    })

    test("rejects empty solution", () => {
      const err = validateInput({ ...base, solution: "" })
      expect(err?.message).toMatch(/solution/)
    })

    test("accepts empty rootCause (per MemCoder: root_cause is optional)", () => {
      expect(validateInput({ ...base, rootCause: "" })).toBeUndefined()
    })
  })

  describe("embedding encode/decode", () => {
    test("round-trips a typical vector", () => {
      const original = Float32Array.from([0.1, -0.2, 3.14, -42.5, 0, 1e-20])
      const bytes = encodeEmbedding(original)
      expect(bytes.byteLength).toBe(original.length * 4)
      const decoded = decodeEmbedding(bytes)
      expect(decoded.length).toBe(original.length)
      for (let i = 0; i < original.length; i++) {
        expect(decoded[i]).toBeCloseTo(original[i]!, 6)
      }
    })

    test("round-trips the empty vector", () => {
      const bytes = encodeEmbedding(new Float32Array())
      expect(bytes.byteLength).toBe(0)
      expect(decodeEmbedding(bytes).length).toBe(0)
    })

    test("decode rejects non-multiple-of-4 byte length", () => {
      expect(() => decodeEmbedding(new Uint8Array([1, 2, 3]))).toThrow(/multiple of 4/)
    })

    test("is endian-independent (we write little-endian)", () => {
      // Known bytes for Float32 1.0 little-endian = [0x00, 0x00, 0x80, 0x3F]
      const bytes = encodeEmbedding(Float32Array.of(1))
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x00, 0x00, 0x80, 0x3f])
      expect(decodeEmbedding(bytes)[0]).toBe(1)
    })
  })
})
