import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Hono } from "hono"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@/project/instance"
import { Database } from "@/storage"
import { ForeignIngestDoneTable, MemorySextupleTable } from "@/memory/memory.sql"
import { AppRuntime } from "@/effect/app-runtime"
import { Log } from "@/util"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Identifier } from "@/id/id"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

beforeEach(() => {
  mock.restore()
})

const phase1Schema = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          problem: { type: "string" },
          rootCause: { type: "string" },
          solution: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["problem", "rootCause", "solution", "keywords"],
      },
    },
  },
  required: ["entries"],
} satisfies Record<string, unknown>

async function insertCheckpoint(tool: string, gitRoot: string) {
  await Database.use((db) =>
    db.insert(ForeignIngestDoneTable).values({
      tool,
      source_path: `${gitRoot}:${tool}`,
      content_hash: `${tool}-hash-${gitRoot}`,
      git_root: gitRoot,
      done_at: Date.now(),
    }),
  )
}

async function insertCheckpointRow(input: {
  tool: string
  gitRoot: string
  sourcePath: string
  contentHash: string
  doneAt: number
}) {
  await Database.use((db) =>
    db.insert(ForeignIngestDoneTable).values({
      tool: input.tool,
      source_path: input.sourcePath,
      content_hash: input.contentHash,
      git_root: input.gitRoot,
      done_at: input.doneAt,
    }),
  )
}

async function insertForeignSextuple(input: {
  projectID: string
  tool: string
  sourceID: string
  problem: string
  timeCreated: number
}) {
  await Database.use((db) =>
    db.insert(MemorySextupleTable).values({
      id: Identifier.descending("memory"),
      hash_id: `${input.tool}-${input.sourceID}-${input.timeCreated}`,
      project_id: input.projectID,
      keywords: [input.tool, input.sourceID],
      problem: input.problem,
      root_cause: "foreign root cause",
      solution: "foreign solution",
      source: {
        type: "foreign",
        tool: input.tool,
        source_id: input.sourceID,
        project_id: input.projectID,
        timestamp: input.timeCreated,
      } as never,
      embedding: null,
      time_created: input.timeCreated,
      time_updated: input.timeCreated,
    }),
  )
}

async function buildMemoryApp() {
  const { MemoryRoutes } = await import("@/server/instance/memory")
  return new Hono().route("/memory", MemoryRoutes())
}

describe("memory routes", () => {
  test("GET /memory/status scopes checkpoint counts to the current worktree", async () => {
    await using repoA = await tmpdir({ git: true })
    await using repoB = await tmpdir({ git: true })
    const app = await buildMemoryApp()

    await Instance.provide({
      directory: repoA.path,
      fn: async () => {
        await insertCheckpoint("opencode", repoA.path)
        await insertCheckpoint("cursor", repoA.path)
        await insertCheckpoint("cursor", repoB.path)

        const status = await (await app.request("/memory/status")).json() as {
          foreignIngest: Array<{ tool: string; count: number }>
        }

        expect(status.foreignIngest).toEqual([
          { tool: "cursor", count: 1 },
          { tool: "opencode", count: 1 },
        ])
      },
    })
  })

  test("POST /memory/ingest wires retrieval deps and extraction schema through the HTTP route", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "test/server",
        memories: {
          enabled: true,
          extractionModel: "test/server",
          extractionFormatSchema: phase1Schema,
        },
      },
    })

    let bridgeInput:
      | {
          formatSchema?: Record<string, unknown>
          schemaName?: string
        }
      | undefined
    void mock.module("@/memory/llm-bridge", async () => {
      return {
        makeMemoryBridge(input: {
          formatSchema?: Record<string, unknown>
          schemaName?: string
          modelSpec: unknown
        }) {
          bridgeInput = input
          return Effect.succeed(() =>
            Effect.succeed(
              JSON.stringify({
                rollout_summary: "",
                rollout_slug: "memory-http-test",
                raw_memory: "",
                sextuples: [],
              }),
            ),
          )
        },
      }
    })
    const app = await buildMemoryApp()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Database.use((db) => {
          db.insert(SessionTable).values({
            id: SessionID.make("session-1"),
            project_id: Instance.project.id,
            workspace_id: null,
            parent_id: null,
            slug: "memory-http-test",
            directory: tmp.path,
            title: "memory-http-test",
            version: "test",
            share_url: null,
            summary_additions: null,
            summary_deletions: null,
            summary_files: null,
            summary_diffs: null,
            revert: null,
            permission: null,
            time_created: 1,
            time_updated: 2,
            time_compacting: null,
            time_archived: null,
          }).run()
          db.insert(MessageTable).values([
            {
              id: MessageID.make("message-user-1"),
              session_id: SessionID.make("session-1"),
              time_created: 3,
              time_updated: 3,
              data: { role: "user" } as never,
            },
            {
              id: MessageID.make("message-assistant-1"),
              session_id: SessionID.make("session-1"),
              time_created: 4,
              time_updated: 4,
              data: { role: "assistant" } as never,
            },
          ]).run()
          db.insert(PartTable).values([
            {
              id: PartID.make("part-user-1"),
              message_id: MessageID.make("message-user-1"),
              session_id: SessionID.make("session-1"),
              time_created: 3,
              time_updated: 3,
              data: { type: "text", text: "Investigate flaky auth state" } as never,
            },
            {
              id: PartID.make("part-assistant-1"),
              message_id: MessageID.make("message-assistant-1"),
              session_id: SessionID.make("session-1"),
              time_created: 4,
              time_updated: 4,
              data: { type: "text", text: "Try invalidating the cache" } as never,
            },
          ]).run()
        })

        const res = await app.request("/memory/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ extract: true, sources: { opencodeSelf: true } }),
        })

        expect(res.status).toBe(200)
        const body = await res.json() as { skipped: boolean; produced: number }
        expect(body.skipped).toBe(false)
        expect(body.produced).toBe(0)
        expect(bridgeInput?.formatSchema).toEqual(phase1Schema)
        expect(bridgeInput?.schemaName).toBe("Phase1Extraction")
      },
    })
  })

  test("GET /memory/session-detail returns exact-root scoped foreign session detail", async () => {
    await using repoA = await tmpdir({ git: true })
    await using repoB = await tmpdir({ git: true })
    const app = await buildMemoryApp()

    await Instance.provide({
      directory: repoA.path,
      fn: async () => {
        const projectID = Instance.project.id
        await insertCheckpointRow({
          tool: "cursor",
          gitRoot: repoA.path,
          sourcePath: `${repoA.path}/session-123.json`,
          contentHash: "hash-a",
          doneAt: 200,
        })
        await insertCheckpointRow({
          tool: "cursor",
          gitRoot: repoB.path,
          sourcePath: `${repoB.path}/session-123.json`,
          contentHash: "hash-b",
          doneAt: 300,
        })

        await insertForeignSextuple({
          projectID,
          tool: "cursor",
          sourceID: "session-123",
          problem: "repo A memory",
          timeCreated: 100,
        })
        await insertForeignSextuple({
          projectID,
          tool: "cursor",
          sourceID: "session-123",
          problem: "repo A memory newer",
          timeCreated: 150,
        })

        const res = await app.request("/memory/session-detail?tool=cursor&sourceID=session-123")
        expect(res.status).toBe(200)
        const body = await res.json() as {
          projectID: string | null
          gitRoot: string | null
          detail: {
            tool: string
            sourceID: string
            sourcePath: string
            contentHash: string | null
            state: string
            storedSextuplesCount: number
            storedSkillsCount: number
            ingestedAt: number | null
          }
        }

        expect(body.projectID).toBe(projectID)
        expect(body.gitRoot).toBe(repoA.path)
        expect(body.detail.tool).toBe("cursor")
        expect(body.detail.sourceID).toBe("session-123")
        expect(body.detail.sourcePath).toBe(`${repoA.path}/session-123.json`)
        expect(body.detail.contentHash).toBe("hash-a")
        expect(body.detail.state).toBe("done")
        expect(body.detail.storedSextuplesCount).toBe(2)
        expect(body.detail.storedSkillsCount).toBe(0)
        expect(body.detail.ingestedAt).toBe(200)
      },
    })
  })

  test("GET /memory/session-detail returns pending detail when only sextuples exist", async () => {
    await using repo = await tmpdir({ git: true })
    const app = await buildMemoryApp()

    await Instance.provide({
      directory: repo.path,
      fn: async () => {
        const projectID = Instance.project.id
        await insertForeignSextuple({
          projectID,
          tool: "opencode",
          sourceID: "session-pending",
          problem: "pending memory",
          timeCreated: 123,
        })

        const res = await app.request("/memory/session-detail?tool=opencode&sourceID=session-pending")
        expect(res.status).toBe(200)
        const body = await res.json() as {
          gitRoot: string | null
          detail: { state: string; contentHash: string | null; storedSextuplesCount: number; ingestedAt: number | null }
        }

        expect(body.gitRoot).toBe(repo.path)
        expect(body.detail.state).toBe("pending")
        expect(body.detail.contentHash).toBeNull()
        expect(body.detail.storedSextuplesCount).toBe(1)
        expect(body.detail.ingestedAt).toBeNull()
      },
    })
  })
})
