import { beforeEach, expect } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { memoryStorageLayer, MemoryStorage } from "../../src/memory"
import { Database } from "../../src/storage"
import { testEffect } from "../lib/effect"
import type { DefectSextupleInput } from "../../src/memory/schema"

beforeEach(() => {
  const db = Database.Client()
  db.run(/*sql*/ `DELETE FROM memory_sextuple`)
})

const it = testEffect(memoryStorageLayer)

const sample = (overrides: Partial<DefectSextupleInput> = {}): DefectSextupleInput => ({
  keywords: ["race", "lock"],
  problem: "deadlock on shutdown",
  rootCause: "mutex acquired in reverse order by logger vs. timer",
  solution: "unify ordering; acquire logger lock first, then timer",
  source: { _tag: "rollout", threadID: "thr-123", timestamp: 1_700_000_000_000 },
  projectID: "proj-demo",
  ...overrides,
})

it.live("store inserts a new record and returns inserted=true", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const { inserted, record } = yield* storage.store(sample())
    expect(inserted).toBe(true)
    expect(record.hashId).toMatch(/^[0-9a-f]{64}$/)
    expect(record.keywords).toEqual(["race", "lock"])
    expect(record.projectID).toBe("proj-demo")
    expect(record.embedding).toBeUndefined()
  }),
)

it.live("store is idempotent on hash_id collision", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const first = yield* storage.store(sample())
    const second = yield* storage.store(sample({ keywords: ["race", "lock", "extra"] }))
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    // Same hash_id because problem/root_cause/solution are identical — only
    // keywords changed, which doesn't enter the hash.
    expect(second.record.hashId).toBe(first.record.hashId)
    const list = yield* storage.listByProject("proj-demo")
    expect(list).toHaveLength(1)
  }),
)

it.live("store normalizes keywords (trim + dedup) before persisting", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const { record } = yield* storage.store(
      sample({ keywords: ["  a ", "b", "", "a", "c"] }),
    )
    expect(record.keywords).toEqual(["a", "b", "c"])
  }),
)

it.live("getByHash returns stored record", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const { record } = yield* storage.store(sample())
    const opt = yield* storage.getByHash(record.hashId)
    expect(Option.isSome(opt)).toBe(true)
    const hit = Option.getOrThrow(opt)
    expect(hit.hashId).toBe(record.hashId)
    expect(hit.problem).toBe(record.problem)
  }),
)

it.live("getByHash returns none for unknown hash", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const opt = yield* storage.getByHash("0".repeat(64))
    expect(Option.isNone(opt)).toBe(true)
  }),
)

it.live("listByProject scopes results and respects limit", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    yield* storage.store(sample({ problem: "p1", projectID: "proj-A" }))
    yield* storage.store(sample({ problem: "p2", projectID: "proj-A" }))
    yield* storage.store(sample({ problem: "p3", projectID: "proj-B" }))

    const a = yield* storage.listByProject("proj-A")
    expect(a).toHaveLength(2)
    for (const row of a) expect(row.projectID).toBe("proj-A")

    const b = yield* storage.listByProject("proj-B")
    expect(b).toHaveLength(1)
    expect(b[0]!.problem).toBe("p3")

    const aLimited = yield* storage.listByProject("proj-A", 1)
    expect(aLimited).toHaveLength(1)
  }),
)

it.live("listByProject with undefined project returns all records", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    yield* storage.store(sample({ problem: "p1", projectID: "proj-A" }))
    yield* storage.store(sample({ problem: "p2", projectID: undefined }))
    const all = yield* storage.listByProject(undefined)
    expect(all).toHaveLength(2)
  }),
)

it.live("updateEmbedding persists Float32 vector and is decoded on read", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const { record } = yield* storage.store(sample())
    const embedding = Float32Array.from([0.1, -0.2, 3.14, -42.5])
    yield* storage.updateEmbedding(record.hashId, embedding)

    const reread = Option.getOrThrow(yield* storage.getByHash(record.hashId))
    expect(reread.embedding).toBeInstanceOf(Float32Array)
    expect(reread.embedding?.length).toBe(embedding.length)
    for (let i = 0; i < embedding.length; i++) {
      expect(reread.embedding?.[i]).toBeCloseTo(embedding[i]!, 6)
    }
  }),
)

it.live("updateEmbedding fails on unknown hash", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const exit = yield* storage.updateEmbedding("0".repeat(64), Float32Array.of(1, 2, 3)).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.live("listEmbedded filters to records with an embedding", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const a = yield* storage.store(sample({ problem: "p1", projectID: "proj-A" }))
    yield* storage.store(sample({ problem: "p2", projectID: "proj-A" }))
    yield* storage.updateEmbedding(a.record.hashId, Float32Array.of(1, 2, 3))

    const embedded = yield* storage.listEmbedded("proj-A")
    expect(embedded).toHaveLength(1)
    expect(embedded[0]!.hashId).toBe(a.record.hashId)
    expect(embedded[0]!.embedding).toBeInstanceOf(Float32Array)
  }),
)

it.live("store rejects invalid input (empty keywords)", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const exit = yield* storage.store(sample({ keywords: [] })).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause) as { _tag?: string }
      expect(err._tag).toBe("MemoryValidationError")
    }
  }),
)

it.live("deleteByHash removes a row", () =>
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    const { record } = yield* storage.store(sample())
    const deleted = yield* storage.deleteByHash(record.hashId)
    expect(deleted).toBe(true)
    const opt = yield* storage.getByHash(record.hashId)
    expect(Option.isNone(opt)).toBe(true)
  }),
)
