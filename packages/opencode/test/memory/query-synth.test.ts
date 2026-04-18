import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  buildQueryPrompt,
  fallbackQuery,
  locateBalancedObject,
  parseQueryResponse,
  regexKeywordQuery,
  synthesizeMemoryQuery,
  truncateWithEllipsis,
  USER_PROMPT_MAX_BYTES,
  FALLBACK_MAX_BYTES,
  QUERY_SYNTH_TEMPLATE,
} from "../../src/memory/query-synth"

describe("memory/query-synth — pure helpers", () => {
  test("truncateWithEllipsis preserves short strings verbatim", () => {
    expect(truncateWithEllipsis("hello", 100)).toBe("hello")
    expect(truncateWithEllipsis("", 10)).toBe("")
  })

  test("truncateWithEllipsis cuts on a UTF-8 char boundary", () => {
    const s = "a".repeat(10) + "🦀🦀🦀🦀"
    const cut = truncateWithEllipsis(s, 12)
    expect(cut.endsWith("…")).toBe(true)
    // Must remain valid UTF-8 (no replacement chars from a mid-codepoint slice).
    expect(cut).not.toContain("\uFFFD")
  })

  test("buildQueryPrompt substitutes placeholders + truncates", () => {
    const huge = "Q".repeat(USER_PROMPT_MAX_BYTES + 5_000)
    const prompt = buildQueryPrompt(huge, null)
    const qsCount = (prompt.match(/Q/g) ?? []).length
    expect(qsCount).toBeLessThanOrEqual(USER_PROMPT_MAX_BYTES)
    expect(qsCount).toBeGreaterThan(USER_PROMPT_MAX_BYTES - 4)
    // Ellipsis present in the truncated payload.
    expect(prompt).toContain("…")
    // Placeholders fully substituted.
    expect(prompt).not.toContain("{user_prompt}")
    expect(prompt).not.toContain("{cwd_context_or_none}")
  })

  test("buildQueryPrompt renders cwdContext when supplied", () => {
    const prompt = buildQueryPrompt("fix the thing", "repo: opencode branch: dev")
    expect(prompt).toContain("fix the thing")
    expect(prompt).toContain("repo: opencode branch: dev")
    expect(prompt).not.toContain("(none)")
  })

  test("buildQueryPrompt uses (none) when cwdContext is empty/whitespace", () => {
    expect(buildQueryPrompt("do work", null)).toContain("(none)")
    expect(buildQueryPrompt("do work", "")).toContain("(none)")
    expect(buildQueryPrompt("do work", "   ")).toContain("(none)")
  })

  test("buildQueryPrompt preserves non-English text", () => {
    const russian = "почини баг в обработчике вебсокета"
    expect(buildQueryPrompt(russian, null)).toContain(russian)
  })

  test("template carries the verbatim {query: ...} schema rule", () => {
    expect(QUERY_SYNTH_TEMPLATE).toContain('Output ONLY a JSON object on a single line: {"query": "..."}')
  })
})

describe("memory/query-synth — parseQueryResponse", () => {
  test("direct JSON returns the trimmed query", () => {
    const r = parseQueryResponse('{"query": "sqlx migration drift ignore_missing"}')
    expect(r).toBe("sqlx migration drift ignore_missing")
  })

  test("strips ```json fences", () => {
    const raw = '```json\n{"query": "refactor websocket retry logic"}\n```'
    expect(parseQueryResponse(raw)).toBe("refactor websocket retry logic")
  })

  test("strips bare ``` fences", () => {
    const raw = '```\n{"query": "plain fence ok"}\n```'
    expect(parseQueryResponse(raw)).toBe("plain fence ok")
  })

  test("returns empty string for empty query field (caller decides fallback)", () => {
    expect(parseQueryResponse('{"query": ""}')).toBe("")
  })

  test("returns missing_query_field error when field is absent", () => {
    const r = parseQueryResponse('{"unrelated": "field"}')
    expect(typeof r).toBe("object")
    expect((r as { kind: string }).kind).toBe("missing_query_field")
  })

  test("returns invalid_json error for non-JSON garbage", () => {
    const r = parseQueryResponse("not json at all")
    expect(typeof r).toBe("object")
    expect((r as { kind: string }).kind).toBe("invalid_json")
  })

  test("locates {\"query\": ...} embedded after prose", () => {
    const r = parseQueryResponse('Sure, here you go:\n{"query": "embedded query"} thanks!')
    expect(r).toBe("embedded query")
  })

  test("locateBalancedObject is string-aware (braces inside quotes don't confuse depth)", () => {
    const s = '{"a": "}}}}", "b": 1}xx'
    expect(locateBalancedObject(s)).toBe('{"a": "}}}}", "b": 1}')
  })
})

describe("memory/query-synth — fallbackQuery + regex extractor", () => {
  test("fallbackQuery trims leading/trailing whitespace", () => {
    expect(fallbackQuery("  short prompt  ")).toBe("short prompt")
    expect(fallbackQuery("    ")).toBe("")
  })

  test("fallbackQuery caps at FALLBACK_MAX_BYTES on a char boundary", () => {
    const huge = "y".repeat(5_000)
    const out = fallbackQuery(huge)
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(FALLBACK_MAX_BYTES)
    expect(out.length).toBeGreaterThan(FALLBACK_MAX_BYTES - 5)
  })

  test("regexKeywordQuery extracts code-shaped identifiers + drops stop words", () => {
    const out = regexKeywordQuery("Please fix the SqlxMigration drift in sqlite/state_db.rs")
    // Code identifiers preserved; "the"/"in"/"please" dropped.
    expect(out).toContain("SqlxMigration")
    expect(out).toContain("sqlite/state_db.rs")
    expect(out.toLowerCase()).not.toContain("please")
    expect(out.toLowerCase()).not.toContain(" the ")
  })

  test("regexKeywordQuery returns empty on empty input", () => {
    expect(regexKeywordQuery("")).toBe("")
    expect(regexKeywordQuery("   ")).toBe("")
  })
})

describe("memory/query-synth — synthesizeMemoryQuery", () => {
  test("source=empty when prompt is whitespace-only", async () => {
    const out = await Effect.runPromise(synthesizeMemoryQuery({ userPrompt: "  " }))
    expect(out.source).toBe("empty")
    expect(out.query).toBe("")
  })

  test("source=regex when no model is supplied", async () => {
    const out = await Effect.runPromise(
      synthesizeMemoryQuery({ userPrompt: "fix the SqlxMigration drift" }),
    )
    expect(out.source).toBe("regex")
    expect(out.query).toContain("SqlxMigration")
  })

  test("source=llm when the model returns a valid response", async () => {
    const out = await Effect.runPromise(
      synthesizeMemoryQuery({
        userPrompt: "deadlock on shutdown",
        model: () => Effect.succeed('{"query": "deadlock on shutdown mutex ordering"}'),
      }),
    )
    expect(out.source).toBe("llm")
    expect(out.query).toBe("deadlock on shutdown mutex ordering")
  })

  test("falls back to regex when model returns null", async () => {
    const out = await Effect.runPromise(
      synthesizeMemoryQuery({
        userPrompt: "fix the SqlxMigration drift",
        model: () => Effect.succeed(null),
      }),
    )
    expect(out.source).toBe("regex")
    expect(out.query).toContain("SqlxMigration")
  })

  test("falls back to regex when model returns unparseable text", async () => {
    const out = await Effect.runPromise(
      synthesizeMemoryQuery({
        userPrompt: "deadlock on shutdown",
        model: () => Effect.succeed("garbage non-json"),
      }),
    )
    expect(out.source).toBe("regex")
    expect(out.query.length).toBeGreaterThan(0)
  })

  test("falls back when model returns empty query string", async () => {
    const out = await Effect.runPromise(
      synthesizeMemoryQuery({
        userPrompt: "fix the SqlxMigration drift",
        model: () => Effect.succeed('{"query": ""}'),
      }),
    )
    expect(out.source).toBe("regex")
    expect(out.query).toContain("SqlxMigration")
  })

  test("model-call failure is caught and degraded (no thrown error)", async () => {
    const out = await Effect.runPromise(
      synthesizeMemoryQuery({
        userPrompt: "fix the SqlxMigration drift",
        model: () => Effect.fail(new Error("network down")) as unknown as Effect.Effect<string | null, unknown>,
      }),
    )
    expect(out.source).toBe("regex")
    expect(out.query).toContain("SqlxMigration")
  })
})
