/**
 * Tests for the round-3 `makeLlmSessionExtractor` wiring.
 *
 * The extractor is a `SessionExtractor` that takes a Phase-1 LLM bridge
 * and emits `DefectSextupleInput`s. These tests exercise success, LLM
 * timeout, parse failure, and empty-session short-circuits — all via a
 * stub `Phase1Model` so no real LLM call is issued.
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { makeLlmSessionExtractor } from "../../src/memory/foreign-ingest"
import type { IngestedSession } from "../../src/memory/foreign-ingest/adapters"
import type { ForeignSource } from "../../src/memory/schema"

function fakeSession(): IngestedSession {
  return {
    tool: "codex",
    sourceID: "fake",
    sourcePath: "/tmp/fake",
    cwd: "/tmp",
    updatedAt: 0,
    turns: [
      {
        userText: "the build broke on Windows",
        assistantText: "fixed by adding path.sep normalisation",
        reasoningText: "",
        toolCalls: [],
      },
    ],
  } as unknown as IngestedSession
}

const foreignSource: ForeignSource = {
  _tag: "foreign",
  tool: "codex",
  sourceID: "fake",
  projectID: "proj-1",
  timestamp: 0,
}

describe("makeLlmSessionExtractor", () => {
  test("forwards LLM response through parse + buildSextupleInputs", async () => {
    const body = JSON.stringify({
      rollout_summary: "fixed windows path",
      rollout_slug: "win-path",
      raw_memory: "",
      sextuples: [
        {
          keywords: ["windows", "path", "build"],
          problem: "windows build broke with unix path sep",
          root_cause: "hardcoded '/' path separator",
          solution: "use path.sep for cross-platform compatibility",
        },
      ],
    })
    const extractor = makeLlmSessionExtractor({
      model: () => Effect.succeed(body),
    })
    const out = await Effect.runPromise(extractor(fakeSession(), foreignSource))
    expect(out).toHaveLength(1)
    expect(out[0]!.problem).toContain("windows build broke")
    expect(out[0]!.projectID).toBe("proj-1")
  })

  test("returns empty array when model returns null", async () => {
    const extractor = makeLlmSessionExtractor({
      model: () => Effect.succeed(null),
    })
    const out = await Effect.runPromise(extractor(fakeSession(), foreignSource))
    expect(out).toEqual([])
  })

  test("returns empty array when model response is unparseable", async () => {
    const extractor = makeLlmSessionExtractor({
      model: () => Effect.succeed("not json at all"),
    })
    const out = await Effect.runPromise(extractor(fakeSession(), foreignSource))
    expect(out).toEqual([])
  })

  test("returns empty array when session text is empty", async () => {
    const extractor = makeLlmSessionExtractor({
      model: () => Effect.succeed("{}"),
    })
    const empty = { ...fakeSession(), turns: [] } as IngestedSession
    const out = await Effect.runPromise(extractor(empty, foreignSource))
    expect(out).toEqual([])
  })

  test("tolerates LLM failure → extracts [] (never throws)", async () => {
    const extractor = makeLlmSessionExtractor({
      model: () => Effect.fail(new Error("llm down") as never),
    })
    const out = await Effect.runPromise(extractor(fakeSession(), foreignSource))
    expect(out).toEqual([])
  })
})
