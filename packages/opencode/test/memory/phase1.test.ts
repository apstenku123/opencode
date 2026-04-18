import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import {
  buildPhase1Prompt,
  buildSextupleInputs,
  layer as memoryFacadeLayer,
  Memory,
  memoryRetrievalLayer,
  memoryStorageLayer,
  mockEmbeddingLayer,
  parsePhase1Response,
  redactSecrets,
  runPhase1,
  sanitizeJsonControlChars,
  tailBiasedTruncate,
  PHASE1_SYSTEM_PROMPT,
} from "../../src/memory"
import { Database } from "../../src/storage"
import { testEffect } from "../lib/effect"
import type { SextupleSource } from "../../src/memory/schema"

beforeEach(() => {
  Database.Client().run(/*sql*/ `DELETE FROM memory_sextuple`)
})

describe("memory/phase1 — pure helpers", () => {
  test("tailBiasedTruncate keeps short input verbatim", () => {
    expect(tailBiasedTruncate("short payload", 1024)).toBe("short payload")
  })

  test("tailBiasedTruncate splits 30/70 head/tail and elides middle", () => {
    const head = "H".repeat(300)
    const tail = "T".repeat(700)
    const middle = "M".repeat(2000)
    const out = tailBiasedTruncate(head + middle + tail, 1000, 0.3)
    expect(out).toContain("H")
    expect(out).toContain("T")
    expect(out).toContain("bytes elided")
    // Tail must be preserved (defects usually live there).
    expect(out.endsWith("T".repeat(50))).toBe(true)
  })

  test("sanitizeJsonControlChars strips NUL/CR but keeps tab and newline", () => {
    const dirty = "a\u0000b\u0008c\u000bd\te\nf\rg"
    const clean = sanitizeJsonControlChars(dirty)
    expect(clean).toBe("abcd\te\nfg")
  })

  test("redactSecrets replaces API key shapes", () => {
    const dirty = `OPENAI=sk-ABCDEFGHIJKLMNOPQRSTUVWX
GH=ghp_AAAAAAAAAAAAAAAAAAAAAAAAA
ANTHROPIC=sk-ant-ZZZZZZZZZZZZZZZZZZZZZ
AWS=AKIAIOSFODNN7EXAMPLE
auth header: Authorization: Bearer eyJabcdefghijklmnopqrstuv`
    const clean = redactSecrets(dirty)
    expect(clean).toContain("[REDACTED_SECRET]")
    expect(clean).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX")
    expect(clean).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAA")
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(clean).not.toContain("eyJabcdefghijklmnopqrstuv")
  })

  test("redactSecrets strips PEM private key blocks", () => {
    const block = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA...
-----END OPENSSH PRIVATE KEY-----`
    expect(redactSecrets(block)).toBe("[REDACTED_SECRET]")
  })

  test("buildPhase1Prompt substitutes the rollout text + sanitizes secrets", () => {
    const prompt = buildPhase1Prompt(
      "user prompt mentioning sk-ABCDEFGHIJKLMNOPQRSTUVWX in passing",
    )
    expect(prompt).toContain("MemCoder Phase-1 extractor")
    expect(prompt).toContain("[REDACTED_SECRET]")
    expect(prompt).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX")
  })

  test("PHASE1_SYSTEM_PROMPT carries the sextuples JSON schema", () => {
    expect(PHASE1_SYSTEM_PROMPT).toContain('"sextuples":')
    expect(PHASE1_SYSTEM_PROMPT).toContain('"keywords":')
    expect(PHASE1_SYSTEM_PROMPT).toContain('"root_cause":')
  })
})

describe("memory/phase1 — parsePhase1Response", () => {
  test("parses a valid response with sextuples", () => {
    const raw = JSON.stringify({
      rollout_summary: "fixed deadlock",
      rollout_slug: "fix-deadlock",
      raw_memory: "x",
      sextuples: [
        {
          keywords: ["mutex", "deadlock"],
          problem: "service deadlocked on shutdown",
          root_cause: "lock-ordering inversion",
          solution: "unify lock acquisition order",
        },
      ],
    })
    const out = parsePhase1Response(raw)
    expect(out).not.toBeNull()
    expect(out!.rolloutSlug).toBe("fix-deadlock")
    expect(out!.sextuples).toHaveLength(1)
    expect(out!.sextuples[0]!.keywords).toEqual(["mutex", "deadlock"])
  })

  test("tolerates fenced JSON + surrounding chatter", () => {
    const raw = `Here you go:\n\`\`\`json\n${JSON.stringify({
      rollout_summary: "",
      rollout_slug: "",
      raw_memory: "",
      sextuples: [],
    })}\n\`\`\``
    const out = parsePhase1Response(raw)
    expect(out).not.toBeNull()
    expect(out!.sextuples).toEqual([])
  })

  test("drops sextuples missing required fields", () => {
    const raw = JSON.stringify({
      rollout_summary: "",
      rollout_slug: "",
      raw_memory: "",
      sextuples: [
        {
          // missing keywords
          problem: "p",
          root_cause: "r",
          solution: "s",
        },
        {
          keywords: ["k"],
          problem: "valid problem",
          root_cause: "valid cause",
          solution: "valid solution",
        },
      ],
    })
    const out = parsePhase1Response(raw)
    expect(out!.sextuples).toHaveLength(1)
    expect(out!.sextuples[0]!.problem).toBe("valid problem")
  })

  test("returns null on garbage", () => {
    expect(parsePhase1Response("not json")).toBeNull()
  })

  test("strips JSON control chars before parsing", () => {
    // Embed a NUL byte that would otherwise break JSON.parse.
    const raw = `{"rollout_summary":"a\u0000b","rollout_slug":"","raw_memory":"","sextuples":[]}`
    const out = parsePhase1Response(raw)
    expect(out).not.toBeNull()
    expect(out!.rolloutSummary).toBe("ab")
  })
})

describe("memory/phase1 — buildSextupleInputs", () => {
  const source: SextupleSource = { _tag: "rollout", threadID: "t-1", timestamp: 1 }

  test("converts response sextuples to validated inputs", () => {
    const inputs = buildSextupleInputs(
      {
        rolloutSummary: "",
        rolloutSlug: "",
        rawMemory: "",
        sextuples: [
          { keywords: ["a", "b"], problem: "p", rootCause: "r", solution: "s" },
        ],
      },
      source,
      "proj-A",
    )
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.projectID).toBe("proj-A")
  })

  test("dedup-cleans keywords + drops invalid candidates", () => {
    const inputs = buildSextupleInputs(
      {
        rolloutSummary: "",
        rolloutSlug: "",
        rawMemory: "",
        sextuples: [
          { keywords: ["a", " a ", "b"], problem: "p", rootCause: "r", solution: "s" },
          { keywords: [], problem: "p", rootCause: "r", solution: "s" }, // dropped: no keywords
          { keywords: ["k"], problem: "", rootCause: "r", solution: "s" }, // dropped: no problem
        ],
      },
      source,
    )
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.keywords).toEqual(["a", "b"])
  })
})

// --------------------------------------------------------------------------
// runPhase1 end-to-end (uses Memory facade with mock embedder)
// --------------------------------------------------------------------------

const facadeDeps = Layer.mergeAll(
  memoryStorageLayer,
  Layer.provide(memoryRetrievalLayer, memoryStorageLayer),
  mockEmbeddingLayer({ dimension: 16 }),
)
const facadeLayer = Layer.provide(memoryFacadeLayer, facadeDeps)
const it = testEffect(facadeLayer)

const source: SextupleSource = { _tag: "rollout", threadID: "live-1", timestamp: 1 }

it.live("runPhase1 returns no-model when bridge is omitted", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* runPhase1(memory, {
      rolloutText: "fixed deadlock by reordering locks",
      source,
    })
    expect(out.reason).toBe("no-model")
    expect(out.stored).toEqual([])
  }),
)

it.live("runPhase1 returns llm-error when bridge fails", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* runPhase1(memory, {
      rolloutText: "rollout text",
      source,
      model: () => Effect.fail(new Error("offline")) as unknown as Effect.Effect<string | null, unknown>,
    })
    expect(out.reason).toBe("llm-error")
    expect(out.stored).toEqual([])
  }),
)

it.live("runPhase1 persists valid extracted sextuples", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const llmResponse = JSON.stringify({
      rollout_summary: "fixed shutdown deadlock",
      rollout_slug: "fix-deadlock",
      raw_memory: "",
      sextuples: [
        {
          keywords: ["mutex", "deadlock"],
          problem: "service deadlocked on shutdown",
          root_cause: "lock-ordering inversion",
          solution: "unify lock acquisition order",
        },
      ],
    })
    const out = yield* runPhase1(memory, {
      rolloutText: "during shutdown the logger and timer race for the same mutex",
      source,
      model: () => Effect.succeed(llmResponse),
    })
    expect(out.reason).toBe("ok")
    expect(out.stored).toHaveLength(1)
    expect(out.stored[0]!.inserted).toBe(true)

    // Idempotent re-insert (same hash) should set inserted=false.
    const out2 = yield* runPhase1(memory, {
      rolloutText: "different rollout text",
      source,
      model: () => Effect.succeed(llmResponse),
    })
    expect(out2.stored).toHaveLength(1)
    expect(out2.stored[0]!.inserted).toBe(false)
  }),
)

it.live("runPhase1 returns no-sextuples when extractor finds none", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* runPhase1(memory, {
      rolloutText: "no defect-resolution moments here",
      source,
      model: () =>
        Effect.succeed(
          JSON.stringify({ rollout_summary: "", rollout_slug: "", raw_memory: "", sextuples: [] }),
        ),
    })
    expect(out.reason).toBe("no-sextuples")
    expect(out.stored).toEqual([])
  }),
)

it.live("Memory.runPhase1 facade entry-point persists records", () =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const out = yield* memory.runPhase1({
      rolloutText: "rollout",
      source,
      model: () =>
        Effect.succeed(
          JSON.stringify({
            rollout_summary: "",
            rollout_slug: "",
            raw_memory: "",
            sextuples: [
              {
                keywords: ["facade-test"],
                problem: "facade insertion",
                root_cause: "wiring round-2 surfaces",
                solution: "ship runPhase1 on Memory",
              },
            ],
          }),
        ),
    })
    expect(out.reason).toBe("ok")
    expect(out.stored).toHaveLength(1)
  }),
)
