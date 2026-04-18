import { describe, expect, test } from "bun:test"
import { hasAppMention, isValidAppId, parseAppMentions } from "@/apps/mention"

describe("apps/mention - parseAppMentions", () => {
  test("returns empty result for input without the sigil", () => {
    const r = parseAppMentions("hello world")
    expect(r.mentions).toEqual([])
    expect(r.ids).toEqual([])
    expect(r.stripped).toBe("hello world")
  })

  test("returns empty for null / empty input without throwing", () => {
    expect(parseAppMentions("").mentions).toEqual([])
    // @ts-expect-error guard-rail: undefined input falls through
    expect(parseAppMentions(undefined).mentions).toEqual([])
  })

  test("parses a single well-formed mention", () => {
    const r = parseAppMentions("check [$GitHub](app://github) for the PR")
    expect(r.mentions).toEqual([
      { name: "GitHub", id: "github", start: 6, end: 29 },
    ])
    expect(r.ids).toEqual(["github"])
    expect(r.stripped).toBe("check $GitHub for the PR")
  })

  test("parses multiple mentions in document order", () => {
    const r = parseAppMentions("[$Notion](app://notion) plus [$GH](app://github)")
    expect(r.mentions.map((m) => m.id)).toEqual(["notion", "github"])
    expect(r.ids).toEqual(["notion", "github"])
  })

  test("deduplicates repeated ids in `ids` (mentions kept)", () => {
    const r = parseAppMentions("[$N1](app://notion) and [$N2](app://notion)")
    expect(r.mentions).toHaveLength(2)
    expect(r.ids).toEqual(["notion"])
  })

  test("rejects malformed mentions (missing scheme, bad id)", () => {
    expect(parseAppMentions("[$X](http://x)").mentions).toEqual([])
    expect(parseAppMentions("[$X](app://)").mentions).toEqual([])
    expect(parseAppMentions("[$X](app://-bad)").mentions).toEqual([])
    expect(parseAppMentions("[$](app://x)").mentions).toEqual([])
  })

  test("allows dot, dash, underscore in ids", () => {
    const r = parseAppMentions("[$Foo](app://foo.bar_baz-qux)")
    expect(r.ids).toEqual(["foo.bar_baz-qux"])
  })

  test("ignores a mention with a newline inside the name (regex anchor)", () => {
    const r = parseAppMentions("[$bad\nname](app://x)")
    expect(r.mentions).toEqual([])
  })

  test("strips markup from the text while preserving non-mention content", () => {
    const r = parseAppMentions("a [$Notion](app://notion) b [$Slack](app://slack) c")
    expect(r.stripped).toBe("a $Notion b $Slack c")
  })

  test("records byte offsets that match the original string", () => {
    const text = "aa [$B](app://b) cc"
    const r = parseAppMentions(text)
    expect(r.mentions[0].start).toBe(3)
    expect(text.slice(r.mentions[0].start, r.mentions[0].end)).toBe("[$B](app://b)")
  })

  test("is not confused by adversarial backtracking-style input", () => {
    const input = "[$" + "a".repeat(5_000) // never closes — must terminate fast
    const start = Date.now()
    const r = parseAppMentions(input)
    const elapsed = Date.now() - start
    expect(r.mentions).toEqual([])
    expect(elapsed).toBeLessThan(500)
  })
})

describe("apps/mention - hasAppMention", () => {
  test("returns true only when a valid mention is present", () => {
    expect(hasAppMention("[$X](app://x)")).toBe(true)
    expect(hasAppMention("no mention here")).toBe(false)
    expect(hasAppMention("[$X](app://)")).toBe(false)
  })

  test("fast-paths on input without the `[$` sigil", () => {
    expect(hasAppMention("")).toBe(false)
    expect(hasAppMention("plain text ok")).toBe(false)
  })
})

describe("apps/mention - isValidAppId", () => {
  test("accepts lowercase ids with dots, dashes, underscores", () => {
    expect(isValidAppId("github")).toBe(true)
    expect(isValidAppId("foo.bar_baz-qux")).toBe(true)
    expect(isValidAppId("a1")).toBe(true)
  })

  test("rejects leading punctuation and empty strings", () => {
    expect(isValidAppId("")).toBe(false)
    expect(isValidAppId("-foo")).toBe(false)
    expect(isValidAppId(".foo")).toBe(false)
  })

  test("is case-insensitive on the alphabet but preserves case in the string", () => {
    expect(isValidAppId("GitHub")).toBe(true)
  })
})
