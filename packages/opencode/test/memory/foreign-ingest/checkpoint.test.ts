import { beforeEach, expect } from "bun:test"
import { Effect } from "effect"

import {
  ForeignIngestCheckpoint,
  layer as checkpointLayer,
} from "../../../src/memory/foreign-ingest/checkpoint"
import { Database } from "../../../src/storage"
import { testEffect } from "../../lib/effect"

beforeEach(() => {
  const db = Database.Client()
  db.run(/*sql*/ `DELETE FROM foreign_ingest_done`)
})

const it = testEffect(checkpointLayer)

it.live("isDone returns false initially, true after insertDone", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    const key = { tool: "claude_code", sourcePath: "/tmp/a.jsonl", contentHash: "h-a" }
    expect(yield* cp.isDone(key)).toBe(false)
    yield* cp.insertDone({ ...key, gitRoot: "/repo/a", doneAt: 1700000000000 })
    expect(yield* cp.isDone(key)).toBe(true)
  }),
)

it.live("insertDone replaces stale rows for same (tool, source_path, git_root)", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    yield* cp.insertDone({
      tool: "claude_code",
      sourcePath: "/tmp/a.jsonl",
      contentHash: "h-old",
      gitRoot: "/repo/a",
      doneAt: 1,
    })
    yield* cp.insertDone({
      tool: "claude_code",
      sourcePath: "/tmp/a.jsonl",
      contentHash: "h-new",
      gitRoot: "/repo/a",
      doneAt: 2,
    })
    const rows = yield* cp.listByTool("claude_code")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.contentHash).toBe("h-new")
    expect(yield* cp.isDone({ tool: "claude_code", sourcePath: "/tmp/a.jsonl", contentHash: "h-old" })).toBe(false)
    expect(yield* cp.isDone({ tool: "claude_code", sourcePath: "/tmp/a.jsonl", contentHash: "h-new" })).toBe(true)
  }),
)

it.live("insertDone is idempotent on the primary key", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    const row = {
      tool: "kiro",
      sourcePath: "/tmp/c.md",
      contentHash: "h-c",
      gitRoot: "/repo/x",
    }
    yield* cp.insertDone({ ...row, doneAt: 1 })
    yield* cp.insertDone({ ...row, doneAt: 2 })
    const rows = yield* cp.listByTool("kiro")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.doneAt).toBe(2)
  }),
)

it.live("listByTool filters and orders by done_at ascending", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    yield* cp.insertDone({
      tool: "claude_code",
      sourcePath: "/tmp/a.jsonl",
      contentHash: "h1",
      gitRoot: "",
      doneAt: 10,
    })
    yield* cp.insertDone({
      tool: "claude_code",
      sourcePath: "/tmp/b.jsonl",
      contentHash: "h2",
      gitRoot: "",
      doneAt: 5,
    })
    yield* cp.insertDone({
      tool: "cursor",
      sourcePath: "/tmp/c.json",
      contentHash: "h3",
      gitRoot: "",
      doneAt: 20,
    })
    const claude = yield* cp.listByTool("claude_code")
    expect(claude).toHaveLength(2)
    expect(claude[0]!.sourcePath).toBe("/tmp/b.jsonl")
    expect(claude[0]!.doneAt).toBe(5)
    const cursor = yield* cp.listByTool("cursor")
    expect(cursor).toHaveLength(1)
    expect(cursor[0]!.contentHash).toBe("h3")
  }),
)

it.live("listByGitRoot filters by exact match (no prefix)", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    yield* cp.insertDone({
      tool: "claude_code",
      sourcePath: "/repo-a/session.jsonl",
      contentHash: "h1",
      gitRoot: "/repo-a",
      doneAt: 10,
    })
    yield* cp.insertDone({
      tool: "claude_code",
      sourcePath: "/repo-b/session.jsonl",
      contentHash: "h2",
      gitRoot: "/repo-b",
      doneAt: 20,
    })
    const a = yield* cp.listByGitRoot("/repo-a")
    expect(a).toHaveLength(1)
    expect(a[0]!.sourcePath).toBe("/repo-a/session.jsonl")
    // Partial prefix must NOT match — exact compare only.
    const partial = yield* cp.listByGitRoot("/repo")
    expect(partial).toHaveLength(0)
  }),
)

it.live("deleteByKey removes a row and reports true once", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    const key = { tool: "cursor", sourcePath: "/tmp/d.json", contentHash: "h-d" }
    yield* cp.insertDone({ ...key, gitRoot: "", doneAt: 1 })
    expect(yield* cp.deleteByKey(key)).toBe(true)
    expect(yield* cp.isDone(key)).toBe(false)
    expect(yield* cp.deleteByKey(key)).toBe(false)
  }),
)

it.live("countByTool groups and orders by tool ASC", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    yield* cp.insertDone({ tool: "claude_code", sourcePath: "/a", contentHash: "h1", gitRoot: "", doneAt: 1 })
    yield* cp.insertDone({ tool: "claude_code", sourcePath: "/b", contentHash: "h2", gitRoot: "", doneAt: 2 })
    yield* cp.insertDone({ tool: "claude_code", sourcePath: "/c", contentHash: "h3", gitRoot: "", doneAt: 3 })
    yield* cp.insertDone({ tool: "cursor", sourcePath: "/d", contentHash: "h4", gitRoot: "", doneAt: 4 })
    yield* cp.insertDone({ tool: "codex", sourcePath: "/e", contentHash: "h5", gitRoot: "", doneAt: 5 })
    yield* cp.insertDone({ tool: "codex", sourcePath: "/f", contentHash: "h6", gitRoot: "", doneAt: 6 })

    const counts = yield* cp.countByTool()
    expect(counts).toEqual([
      { tool: "claude_code", count: 3 },
      { tool: "codex", count: 2 },
      { tool: "cursor", count: 1 },
    ])
  }),
)

it.live("countByTool is empty on fresh table", () =>
  Effect.gen(function* () {
    const cp = yield* ForeignIngestCheckpoint
    expect(yield* cp.countByTool()).toEqual([])
  }),
)
