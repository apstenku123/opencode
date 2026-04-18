import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import {
  DEFAULT_GROUNDING_CONFIG,
  buildGroundingQuery,
  collectAvailableSearchToolsFromMap,
  computeResearchAgentCount,
  cooldownSkipReason,
  dispatcherFromAiTools,
  filterByPreferred,
  isSearchLikeToolName,
  maybeDispatchGrounding,
  type Dispatcher,
} from "@/autobest/grounding"

describe("autobest/grounding - isSearchLikeToolName", () => {
  test("matches every server hint (case-insensitive)", () => {
    for (const name of ["perplexity:ask", "exa:search", "tavily:extract", "brave:foo", "kagi:bar", "serper:baz", "searxng:x"]) {
      expect(isSearchLikeToolName(name)).toBe(true)
    }
  })

  test("matches tool-name hints regardless of server prefix", () => {
    expect(isSearchLikeToolName("anything:search")).toBe(true)
    expect(isSearchLikeToolName("anything:research")).toBe(true)
    expect(isSearchLikeToolName("anything:find_similar")).toBe(true)
    expect(isSearchLikeToolName("anything:deep_research")).toBe(true)
    expect(isSearchLikeToolName("anything:scholar")).toBe(true)
    expect(isSearchLikeToolName("anything:reasoning")).toBe(true)
  })

  test("rejects unrelated tool names", () => {
    expect(isSearchLikeToolName("filesystem:read")).toBe(false)
    expect(isSearchLikeToolName("git:commit")).toBe(false)
    expect(isSearchLikeToolName("foo")).toBe(false)
  })

  test("is case-insensitive", () => {
    expect(isSearchLikeToolName("Perplexity:ASK")).toBe(true)
  })
})

describe("autobest/grounding - filterByPreferred", () => {
  test("returns input unchanged when preferred list is empty", () => {
    expect(filterByPreferred(["a", "b", "c"], [])).toEqual(["a", "b", "c"])
  })

  test("filters by case-insensitive substring", () => {
    const out = filterByPreferred(["perplexity:ask", "exa:search", "tavily:extract"], ["EXA", "tavily"])
    expect(out).toEqual(["exa:search", "tavily:extract"])
  })

  test("ignores blank entries in preferred", () => {
    const out = filterByPreferred(["exa:search"], ["", "  "])
    expect(out).toEqual(["exa:search"])
  })

  test("returns empty when preferred excludes everything", () => {
    expect(filterByPreferred(["exa:search"], ["nope"])).toEqual([])
  })
})

describe("autobest/grounding - cooldownSkipReason", () => {
  test("returns undefined for the very first dispatch", () => {
    expect(cooldownSkipReason({ currentTurn: 5, minIntervalTurns: 8 })).toBeUndefined()
  })

  test("returns undefined when currentTurn === 0 (Rust special case)", () => {
    expect(cooldownSkipReason({ currentTurn: 0, lastGroundingTurn: 0, minIntervalTurns: 8 })).toBeUndefined()
  })

  test("returns undefined when minIntervalTurns is 0", () => {
    expect(cooldownSkipReason({ currentTurn: 1, lastGroundingTurn: 1, minIntervalTurns: 0 })).toBeUndefined()
  })

  test("emits cooldown N/M while inside the window", () => {
    expect(cooldownSkipReason({ currentTurn: 4, lastGroundingTurn: 0, minIntervalTurns: 8 })).toBe("cooldown 4/8")
    expect(cooldownSkipReason({ currentTurn: 7, lastGroundingTurn: 0, minIntervalTurns: 8 })).toBe("cooldown 7/8")
  })

  test("allows dispatch at the exact boundary", () => {
    expect(cooldownSkipReason({ currentTurn: 8, lastGroundingTurn: 0, minIntervalTurns: 8 })).toBeUndefined()
  })
})

describe("autobest/grounding - buildGroundingQuery", () => {
  test("includes the complaint reason and the tail", () => {
    const q = buildGroundingQuery({ complaintReason: "missing API docs", tail: "previous prose..." })
    expect(q).toContain("missing API docs")
    expect(q).toContain("previous prose...")
  })

  test("falls back to placeholders when fields are blank", () => {
    const q = buildGroundingQuery({ complaintReason: "" })
    expect(q).toContain("(unspecified)")
    expect(q).toContain("(none)")
  })

  test("truncates long tails at maxTailLen chars", () => {
    const q = buildGroundingQuery({ complaintReason: "x", tail: "a".repeat(20_000), maxTailLen: 100 })
    // Template adds prelude/postlude; only the tail field is truncated.
    expect(q.length).toBeLessThan(20_000)
  })
})

describe("autobest/grounding - computeResearchAgentCount", () => {
  test("zero tools yields zero agents", () => {
    expect(computeResearchAgentCount({ toolCount: 0 })).toBe(0)
  })

  test("clamps to default maxAgents=8", () => {
    expect(computeResearchAgentCount({ toolCount: 100 })).toBe(8)
  })

  test("clamps by toolCount * 2", () => {
    expect(computeResearchAgentCount({ toolCount: 2, maxAgents: 8 })).toBe(4)
  })

  test("respects agentMaxThreads cap", () => {
    expect(computeResearchAgentCount({ toolCount: 10, maxAgents: 8, agentMaxThreads: 3 })).toBe(3)
  })

  test("floor of 1 when at least one tool exists", () => {
    expect(computeResearchAgentCount({ toolCount: 1, maxAgents: 0 })).toBe(1)
  })
})

describe("autobest/grounding - collectAvailableSearchToolsFromMap", () => {
  test("filters non-search tools out", () => {
    const out = collectAvailableSearchToolsFromMap({
      "exa:search": "yes",
      "git:commit": "no",
      "perplexity:ask": "yes",
    })
    expect(Object.keys(out).sort()).toEqual(["exa:search", "perplexity:ask"])
  })

  test("applies preferred filter on top", () => {
    const out = collectAvailableSearchToolsFromMap(
      { "exa:search": 1, "perplexity:ask": 2, "tavily:extract": 3 },
      ["exa"],
    )
    expect(Object.keys(out)).toEqual(["exa:search"])
  })
})

describe("autobest/grounding - DEFAULT_GROUNDING_CONFIG", () => {
  test("matches Rust defaults (8/8/[])", () => {
    expect(DEFAULT_GROUNDING_CONFIG.minIntervalTurns).toBe(8)
    expect(DEFAULT_GROUNDING_CONFIG.maxAgents).toBe(8)
    expect(DEFAULT_GROUNDING_CONFIG.preferredTools).toEqual([])
  })
})

describe("autobest/grounding - maybeDispatchGrounding", () => {
  const noop: Dispatcher = () => Effect.void

  test("skips when no eligible search-like tools are present", async () => {
    const out = await Effect.runPromise(
      maybeDispatchGrounding({
        currentTurn: 1,
        complaintReason: "x",
        tools: ["filesystem:read", "git:status"],
        dispatcher: noop,
      }),
    )
    expect(out.kind).toBe("skipped")
    expect(out.kind === "skipped" && out.reason).toBe("no_search_tools")
  })

  test("skips with cooldown when within rate-limit window", async () => {
    const out = await Effect.runPromise(
      maybeDispatchGrounding({
        currentTurn: 3,
        lastGroundingTurn: 1,
        complaintReason: "x",
        tools: ["exa:search"],
        config: { minIntervalTurns: 8 },
        dispatcher: noop,
      }),
    )
    expect(out.kind).toBe("skipped")
    expect(out.kind === "skipped" && out.reason).toBe("cooldown 2/8")
  })

  test("skips with preferred_filter_empty when allow-list excludes all eligible tools", async () => {
    const out = await Effect.runPromise(
      maybeDispatchGrounding({
        currentTurn: 1,
        complaintReason: "x",
        tools: ["exa:search"],
        config: { preferredTools: ["nope"] },
        dispatcher: noop,
      }),
    )
    expect(out.kind).toBe("skipped")
    expect(out.kind === "skipped" && out.reason).toBe("preferred_filter_empty")
  })

  test("dispatches in parallel up to agent target and reports turn", async () => {
    const seen: string[] = []
    const out = await Effect.runPromise(
      maybeDispatchGrounding({
        currentTurn: 5,
        complaintReason: "missing context",
        tools: ["exa:search", "perplexity:ask", "tavily:extract", "git:status"],
        config: { minIntervalTurns: 0, maxAgents: 8 },
        dispatcher: (name, _q) =>
          Effect.sync(() => {
            seen.push(name)
          }),
      }),
    )
    expect(out.kind).toBe("dispatched")
    if (out.kind === "dispatched") {
      expect(out.turn).toBe(5)
      expect(out.agentsSpawned).toBe(3)
      expect([...out.toolsUsed].sort()).toEqual(["exa:search", "perplexity:ask", "tavily:extract"])
    }
    expect(seen.sort()).toEqual(["exa:search", "perplexity:ask", "tavily:extract"])
  })

  test("swallows individual dispatcher failures", async () => {
    const out = await Effect.runPromise(
      maybeDispatchGrounding({
        currentTurn: 5,
        complaintReason: "x",
        tools: ["exa:search", "perplexity:ask"],
        config: { minIntervalTurns: 0 },
        dispatcher: ((_toolName: string, _query: string) =>
          Effect.fail(new Error("boom"))) as unknown as import("../../src/autobest/grounding").Dispatcher,
      }),
    )
    expect(out.kind).toBe("dispatched")
  })

  test("first-ever dispatch ignores cooldown even with high min interval", async () => {
    const out = await Effect.runPromise(
      maybeDispatchGrounding({
        currentTurn: 0,
        complaintReason: "x",
        tools: ["exa:search"],
        config: { minIntervalTurns: 100 },
        dispatcher: noop,
      }),
    )
    expect(out.kind).toBe("dispatched")
  })
})

describe("autobest/grounding - dispatcherFromAiTools", () => {
  test("invokes underlying execute and swallows errors", async () => {
    const calls = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<string[]>([])
        const tools = {
          "exa:search": {
            execute: (args: { query: string }) => {
              return Effect.runPromise(Ref.update(ref, (a) => [...a, args.query]))
            },
          },
          "broken:tool": {
            execute: () => {
              throw new Error("kaboom")
            },
          },
        }
        const dispatch = dispatcherFromAiTools(tools)
        yield* dispatch("exa:search", "hello")
        yield* dispatch("broken:tool", "world")
        yield* dispatch("missing:tool", "ignored")
        return yield* Ref.get(ref)
      }),
    )
    expect(calls).toEqual(["hello"])
  })
})
