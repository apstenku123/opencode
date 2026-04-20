import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { MemorySextupleTable, ForeignIngestDoneTable } from "@/memory/memory.sql"
import { Instance } from "@/project/instance"
import { Database } from "@/storage"
import { tmpdir } from "../fixture/fixture"

import { deleteForProject, statusForProject } from "@/server/instance/memory"

afterEach(async () => {
  await Instance.disposeAll()
})

beforeEach(() => {
  Database.use((db) => {
    db.delete(MemorySextupleTable).run()
    db.delete(ForeignIngestDoneTable).run()
  })
})

function insertSextuple(projectID: string | null, embedded: boolean) {
  const hashID = crypto.randomUUID()
  return Database.use((db) =>
    db.insert(MemorySextupleTable).values({
      id: crypto.randomUUID(),
      hash_id: hashID,
      project_id: projectID,
      problem: `problem-${crypto.randomUUID()}`,
      root_cause: "cause",
      solution: "solution",
      keywords: ["memory"],
      source: { _tag: "rollout", threadID: hashID, timestamp: Date.now() },
      embedding: embedded ? Buffer.from(Float32Array.from([0.1, 0.2, 0.3]).buffer) : null,
      time_created: Date.now(),
      time_updated: Date.now(),
    }).run(),
  )
}

function insertCheckpoint(tool: string, gitRoot: string) {
  return Database.use((db) =>
    db.insert(ForeignIngestDoneTable).values({
      tool,
      source_path: `${gitRoot}:${tool}:${crypto.randomUUID()}`,
      content_hash: `${tool}-${crypto.randomUUID()}`,
      git_root: gitRoot,
      done_at: Date.now(),
    }).run(),
  )
}

describe("server memory helpers", () => {
  test("statusForProject(null) returns global sextuple and checkpoint counts", async () => {
    await insertSextuple("proj-a", true)
    await insertSextuple("proj-b", false)
    await insertCheckpoint("cursor", "/repo-a")
    await insertCheckpoint("cursor", "/repo-b")
    await insertCheckpoint("codex", "/repo-a")

    const status = await statusForProject(null)

    expect(status).toEqual({
      projectID: null,
      sextupleCount: 2,
      embeddedCount: 1,
      foreignIngest: [
        { tool: "codex", count: 1 },
        { tool: "cursor", count: 2 },
      ],
    })
  })

  test("deleteForProject removes only the current worktree checkpoints", async () => {
    await using repoA = await tmpdir({ git: true })
    await using repoB = await tmpdir({ git: true })

    await insertCheckpoint("cursor", repoA.path)
    await insertCheckpoint("codex", repoA.path)
    await insertCheckpoint("cursor", repoB.path)

    await Instance.provide({
      directory: repoA.path,
      fn: async () => {
        const result = await deleteForProject(Instance.project.id)
        expect(result.deletedCheckpoints).toBe(2)
      },
    })

    const remaining = Database.use((db) =>
      db
        .select({ gitRoot: ForeignIngestDoneTable.git_root, tool: ForeignIngestDoneTable.tool })
        .from(ForeignIngestDoneTable)
        .all(),
    )
    expect(remaining).toEqual([{ gitRoot: repoB.path, tool: "cursor" }])
  })

  test("deleteForProject with no bound project clears global checkpoints and sextuples", async () => {
    await insertSextuple("proj-a", true)
    await insertSextuple(null, false)
    await insertCheckpoint("cursor", "/repo-a")
    await insertCheckpoint("codex", "/repo-b")

    const result = await deleteForProject(null)

    expect(result).toEqual({ deletedSextuples: 2, deletedCheckpoints: 2 })
    expect(await statusForProject(null)).toEqual({
      projectID: null,
      sextupleCount: 0,
      embeddedCount: 0,
      foreignIngest: [],
    })
  })
})
