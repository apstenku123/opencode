import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  buildTurnRolloutText,
  DEFAULT_HOOKS_CONFIG,
  ENRICHMENT_SCRATCH_KEY,
  enrichUserPromptWithMemories,
  extractAndRefineTurnSextuples,
  formatSimilarProblemsBlock,
  isInjectedContextFragment,
  layer as memoryFacadeLayer,
  Memory,
  memoryRetrievalLayer,
  memoryStorageLayer,
  mockEmbeddingLayer,
  pickRecentUserMessages,
  registerMemoryTurnObserver,
  truncateChars,
  FIELD_CHAR_LIMIT,
} from "../../src/memory"
import type { DefectSextuple, SextupleSource } from "../../src/memory/schema"
import type { ScoredSextuple } from "../../src/memory/retrieval"
import { Database } from "../../src/storage"
import { testEffect } from "../lib/effect"
import { AdaptiveState } from "../../src/session/adaptive"

beforeEach(() => {
  Database.Client().run(/*sql*/ `DELETE FROM memory_sextuple`)
})

const fakeRecord = (id: string, problem = `problem ${id}`): DefectSextuple =>
  ({
    id: `mem-${id}`,
    hashId: id,
    keywords: ["k"],
    problem,
    rootCause: `root ${id}`,
    solution: `sol ${id}`,
    source: { _tag: "rollout", threadID: "t", timestamp: 0 },
    timeCreated: 0,
    timeUpdated: 0,
  }) as DefectSextuple

describe("memory/turn-hooks — pure helpers", () => {
  test("truncateChars preserves short strings", () => {
    expect(truncateChars("hi")).toBe("hi")
  })

  test("truncateChars cuts + appends ... when exceeding the limit", () => {
    const out = truncateChars("a".repeat(FIELD_CHAR_LIMIT + 50))
    expect(out.length).toBe(FIELD_CHAR_LIMIT)
    expect(out.endsWith("...")).toBe(true)
  })

  test("formatSimilarProblemsBlock emits the <similar_past_problems> wrapper", () => {
    const block = formatSimilarProblemsBlock([
      { record: fakeRecord("a"), score: 0.9 } satisfies ScoredSextuple,
      { record: fakeRecord("b"), score: 0.7 } satisfies ScoredSextuple,
    ])
    expect(block.startsWith("<similar_past_problems>")).toBe(true)
    expect(block.endsWith("</similar_past_problems>")).toBe(true)
    expect(block).toContain("1. PROBLEM: problem a")
    expect(block).toContain("2. PROBLEM: problem b")
  })

  test("formatSimilarProblemsBlock returns empty string on no hits", () => {
    expect(formatSimilarProblemsBlock([])).toBe("")
  })

  test("isInjectedContextFragment recognises round-trip markers", () => {
    expect(isInjectedContextFragment("<turn_aborted>boom</turn_aborted>")).toBe(true)
    expect(isInjectedContextFragment("<similar_past_problems>...")).toBe(true)
    expect(isInjectedContextFragment("regular user prompt")).toBe(false)
    expect(isInjectedContextFragment("")).toBe(false)
  })

  test("pickRecentUserMessages drops empties + injected markers + clamps to limit", () => {
    const out = pickRecentUserMessages(
      ["", "first real", "<similar_past_problems>injected", "second", "third", "fourth", "fifth"],
      4,
    )
    expect(out).toEqual(["second", "third", "fourth", "fifth"])
  })

  test("buildTurnRolloutText interleaves user messages + assistant turn", () => {
    const out = buildTurnRolloutText("assistant turn body", ["user one", "user two"])
    expect(out).toContain("[user 1] user one")
    expect(out).toContain("[user 2] user two")
    expect(out).toContain("[assistant turn]")
    expect(out).toContain("assistant turn body")
  })

  test("buildTurnRolloutText falls back to bare summary when no user msgs", () => {
    expect(buildTurnRolloutText("just the summary", [])).toBe("just the summary")
  })
})

// --------------------------------------------------------------------------
// Memory-backed enrichment + extraction (mock embedder, no live LLM)
// --------------------------------------------------------------------------

const facadeDeps = Layer.mergeAll(
  memoryStorageLayer,
  Layer.provide(memoryRetrievalLayer, memoryStorageLayer),
  mockEmbeddingLayer({ dimension: 16 }),
)
const facadeLayer = Layer.provide(memoryFacadeLayer, facadeDeps)
const it = testEffect(facadeLayer)

const seedSource: SextupleSource = { _tag: "rollout", threadID: "seed", timestamp: 0 }

it.live("memory.enrichPromptForSession → delegates to enrichUserPromptWithMemories", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    yield* memory.add({
      keywords: ["session", "retrieve"],
      problem: "session-level retrieve integration",
      rootCause: "facade plumbed",
      solution: "call enrichPromptForSession",
      source: seedSource,
    })
    const out = yield* memory.enrichPromptForSession("ses-1" as never, "session retrieve sample", {
      minScore: -1,
      topK: 1,
    })
    expect(out.block).not.toBeNull()
    expect(out.block!).toContain("session-level retrieve integration")
  }),
)

it.live("memory.extractFromTurn splits user/assistant events + runs refining gate", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const llmResponse = JSON.stringify({
      rollout_summary: "fixed a bug",
      rollout_slug: "bug-fix",
      raw_memory: "",
      sextuples: [
        {
          keywords: ["mutex", "race"],
          problem: "mutex race on shutdown",
          root_cause: "two consumers pull without coordination",
          solution: "add shutdown barrier and coordinate drain",
        },
      ],
    })
    const out = yield* memory.extractFromTurn({
      turnEvents: [
        { role: "user", text: "thanks, it works now" },
        { role: "assistant", text: "fixed the deadlock — All tests passed." },
      ],
      source: { _tag: "rollout", threadID: "live", timestamp: 0 },
      extractionModel: () => Effect.succeed(llmResponse),
    })
    expect(out.reason).toBe("ok")
    expect(out.persisted).toHaveLength(1)
  }),
)

it.live("enrichUserPromptWithMemories returns block when stored sextuples match", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    yield* memory.add({
      keywords: ["deadlock", "mutex"],
      problem: "deadlock on shutdown",
      rootCause: "lock-ordering inversion",
      solution: "unify lock acquisition order",
      source: seedSource,
    })

    const out = yield* memory.enrichPrompt({
      userPrompt: "we hit a deadlock on shutdown again — same mutex pair",
      // Skip both LLMs → pure cosine path through the regex query.
      minScore: -1,
      topK: 1,
    })
    expect(out.block).not.toBeNull()
    expect(out.block!).toContain("deadlock on shutdown")
    expect(out.hits).toHaveLength(1)
    expect(out.reason).toBe("ok")
  }),
)

it.live("enrichUserPromptWithMemories mode=hybrid returns BM25-biased block without embeddings", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    // Seed with addWithoutEmbedding so only the BM25 channel fires.
    yield* memory.addWithoutEmbedding({
      keywords: ["deadlock", "mutex"],
      problem: "deadlock on shutdown",
      rootCause: "lock-ordering inversion",
      solution: "unify lock acquisition order",
      source: seedSource,
    })
    yield* memory.addWithoutEmbedding({
      keywords: ["timeout"],
      problem: "timeout in network call",
      rootCause: "no retry",
      solution: "backoff + retry",
      source: seedSource,
    })
    const out = yield* enrichUserPromptWithMemories({
      memory,
      userPrompt: "deadlock mutex shutdown",
      topK: 2,
      // Use minScore=-1 since hybrid min-max normalises to [0,1] and stage-2
      // rerank's default minScore=0.4 would drop the second candidate.
      minScore: -1,
      retrievalMode: "hybrid",
    })
    // Stage-1 must have at least surfaced BM25 candidates. Block content
    // may or may not render depending on stage-2 merge; we only assert
    // the BM25 channel fired.
    expect(out.stage1.length).toBeGreaterThan(0)
    expect(out.stage1.some((h) => (h as any).bm25Score !== undefined)).toBe(true)
    // With minScore=-1 the deadlock record should be the top stage-1 hit.
    expect(out.stage1[0]!.record.problem).toBe("deadlock on shutdown")
  }),
)

it.live("enrichUserPromptWithMemories returns block null when stage-1 is empty", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* memory.enrichPrompt({
      userPrompt: "no records exist for this prompt",
      minScore: -1,
    })
    expect(out.block).toBeNull()
    expect(out.reason).toBe("stage1-empty")
  }),
)

it.live("enrichUserPromptWithMemories returns empty-prompt for whitespace input", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* memory.enrichPrompt({ userPrompt: "  " })
    expect(out.block).toBeNull()
    expect(out.reason).toBe("empty-prompt")
  }),
)

it.live("extractAndRefineTurnSextuples persists refined sextuples that clear the gate", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const llmResponse = JSON.stringify({
      rollout_summary: "fixed shutdown deadlock",
      rollout_slug: "deadlock-fix",
      raw_memory: "",
      sextuples: [
        {
          keywords: ["mutex", "deadlock"],
          problem: "service deadlocked on shutdown",
          root_cause: "lock-ordering inversion between logger and timer",
          solution: "unify lock-ordering: every consumer takes logger lock first",
        },
      ],
    })
    const out = yield* extractAndRefineTurnSextuples({
      memory,
      turnSummary: "fixed the deadlock — All tests passed.",
      recentUserMessages: ["thanks, it works now"],
      source: { _tag: "rollout", threadID: "live", timestamp: 0 },
      extractionModel: () => Effect.succeed(llmResponse),
    })
    expect(out.reason).toBe("ok")
    expect(out.persisted).toHaveLength(1)
    expect(out.outputs).toHaveLength(1)
    expect(out.outputs[0]!.path).toBe("kept-verbatim") // no polish model supplied
  }),
)

it.live("extractAndRefineTurnSextuples drops candidates rejected by the gate", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const llmResponse = JSON.stringify({
      rollout_summary: "",
      rollout_slug: "",
      raw_memory: "",
      sextuples: [
        {
          keywords: ["mutex"],
          problem: "p",
          root_cause: "r",
          solution: "s",
        },
      ],
    })
    const out = yield* extractAndRefineTurnSextuples({
      memory,
      turnSummary: "test failed: panic in init", // objective=0
      recentUserMessages: ["still broken, doesn't work"], // sentiment=0
      source: { _tag: "rollout", threadID: "live", timestamp: 0 },
      extractionModel: () => Effect.succeed(llmResponse),
    })
    expect(out.persisted).toEqual([])
    expect(out.outputs[0]!.path).toBe("gate-rejected")
  }),
)

it.live("extractAndRefineTurnSextuples short-circuits on empty turn", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* extractAndRefineTurnSextuples({
      memory,
      turnSummary: "  ",
      recentUserMessages: ["something"],
      source: { _tag: "rollout", threadID: "x", timestamp: 0 },
      extractionModel: () => Effect.succeed("never used"),
    })
    expect(out.reason).toBe("empty-turn")
  }),
)

// --------------------------------------------------------------------------
// AdaptiveHooks observer surface
// --------------------------------------------------------------------------

describe("memory/turn-hooks — registerMemoryTurnObserver", () => {
  test("preIteration is a no-op when memories are disabled", () =>
    Effect.gen(function* () {
      const observer = registerMemoryTurnObserver({
        memory: stubMemory(),
        resolveUserPrompt: () => Effect.succeed("anything"),
        resolveTurn: () => Effect.succeed(null),
        source: () => Effect.succeed({ _tag: "rollout", threadID: "x", timestamp: 0 } as SextupleSource),
        config: () => Effect.succeed({ ...DEFAULT_HOOKS_CONFIG, enabled: false }),
      })
      const state = AdaptiveState.empty()
      // Pre-seed scratch with a stale block; the observer should clear it
      // because retrieval is disabled.
      state.scratch[ENRICHMENT_SCRATCH_KEY] = "stale block"
      yield* observer.preIteration!(state, {
        sessionID: "ses-1" as never,
        step: 1,
      })
      expect(state.scratch[ENRICHMENT_SCRATCH_KEY]).toBeUndefined()
    }).pipe(Effect.runPromise))

  test("postIteration returns Continue when extraction is disabled", () =>
    Effect.gen(function* () {
      const observer = registerMemoryTurnObserver({
        memory: stubMemory(),
        resolveUserPrompt: () => Effect.succeed(null),
        resolveTurn: () => Effect.succeed({ turnSummary: "x", recentUserMessages: [] }),
        source: () => Effect.succeed({ _tag: "rollout", threadID: "x", timestamp: 0 } as SextupleSource),
        config: () =>
          Effect.succeed({
            ...DEFAULT_HOOKS_CONFIG,
            enabled: true,
            extractionEnabled: false,
          }),
      })
      const state = AdaptiveState.empty()
      const directive = yield* observer.postIteration!(state, {
        sessionID: "ses-1" as never,
        step: 1,
        defaultOutcome: "break",
      })
      expect(directive.kind).toBe("continue")
    }).pipe(Effect.runPromise))
})

function stubMemory(): Memory.Interface {
  return {
    add: () => Effect.die("stub.add"),
    addWithoutEmbedding: () => Effect.die("stub.addWithoutEmbedding"),
    embed: () => Effect.die("stub.embed"),
    get: () => Effect.die("stub.get"),
    listByProject: () => Effect.die("stub.listByProject"),
    retrieve: () => Effect.die("stub.retrieve"),
    retrieveByEmbedding: () => Effect.die("stub.retrieveByEmbedding"),
    enrichPrompt: () => Effect.die("stub.enrichPrompt"),
    runPhase1: () => Effect.die("stub.runPhase1"),
    enrichPromptForSession: () => Effect.die("stub.enrichPromptForSession"),
    extractFromTurn: () => Effect.die("stub.extractFromTurn"),
    runPhase1OnTurn: () => Effect.die("stub.runPhase1OnTurn"),
  }
}
