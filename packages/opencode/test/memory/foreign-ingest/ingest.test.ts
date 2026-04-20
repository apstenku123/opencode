import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"

import * as CrossSpawnSpawner from "../../../src/effect/cross-spawn-spawner"
import { ingest } from "../../../src/memory/foreign-ingest"
import { ForeignIngestCheckpoint } from "../../../src/memory/foreign-ingest/checkpoint"
import { Memory } from "../../../src/memory"
import { ForeignSource, MemoryStorageError } from "../../../src/memory/schema"
import { Instance } from "../../../src/project/instance"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../../src/session/session.sql"
import { Database } from "../../../src/storage"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const checkpointLayer = (calls: Array<{ sourcePath: string }>) =>
  Layer.succeed(ForeignIngestCheckpoint, {
    isDone: () => Effect.succeed(false),
    insertDone: (row) => Effect.sync(() => void calls.push({ sourcePath: row.sourcePath })),
    listByTool: () => Effect.succeed([]),
    listByGitRoot: () => Effect.succeed([]),
    deleteByKey: () => Effect.succeed(false),
    countByTool: () => Effect.succeed([]),
  })

const memoryLayer = (mode: "fail" | "unused") =>
  Layer.succeed(Memory, {
    add: () => Effect.die("unused"),
    addWithoutEmbedding: () =>
      mode === "fail"
        ? Effect.fail(new MemoryStorageError({ message: "write failed" }))
        : Effect.die("unused"),
    retrieve: () => Effect.die("unused"),
    enrichPrompt: () => Effect.die("unused"),
    runPhase1: () => Effect.die("unused"),
    enrichPromptForSession: () => Effect.die("unused"),
    extractFromTurn: () => Effect.die("unused"),
    runPhase1OnTurn: () => Effect.die("unused"),
    embed: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    listByProject: () => Effect.die("unused"),
    retrieveByEmbedding: () => Effect.die("unused"),
  })

const seedSession = (dir: string, sessionID: string) =>
  Effect.sync(() => {
    const userMessageID = `message-user-${sessionID}`
    const assistantMessageID = `message-assistant-${sessionID}`
    const userPartID = `part-user-${sessionID}`
    const assistantPartID = `part-assistant-${sessionID}`
    Database.use((db) => {
      db.insert(SessionTable)
        .values({
          id: SessionID.make(sessionID),
          project_id: Instance.project.id,
          workspace_id: null,
          parent_id: null,
          slug: "foreign-ingest-test",
          directory: dir,
          title: "foreign-ingest-test",
          version: "1",
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
        })
        .run()
      db.insert(MessageTable)
        .values([
          {
            id: MessageID.make(userMessageID),
            session_id: SessionID.make(sessionID),
            time_created: 3,
            time_updated: 3,
            data: { role: "user" } as never,
          },
          {
            id: MessageID.make(assistantMessageID),
            session_id: SessionID.make(sessionID),
            time_created: 4,
            time_updated: 4,
            data: { role: "assistant" } as never,
          },
        ])
        .run()
      db.insert(PartTable)
        .values([
          {
            id: PartID.make(userPartID),
            message_id: MessageID.make(userMessageID),
            session_id: SessionID.make(sessionID),
            time_created: 3,
            time_updated: 3,
            data: { type: "text", text: "problem" } as never,
          },
          {
            id: PartID.make(assistantPartID),
            message_id: MessageID.make(assistantMessageID),
            session_id: SessionID.make(sessionID),
            time_created: 4,
            time_updated: 4,
            data: { type: "text", text: "solution" } as never,
          },
        ])
        .run()
    })
  })

describe("foreign ingest checkpointing", () => {
  const itFail = testEffect(Layer.mergeAll(memoryLayer("fail"), CrossSpawnSpawner.defaultLayer))

  itFail.live("does not checkpoint when persistence fails", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const failedCheckpointCalls: Array<{ sourcePath: string }> = []
        yield* seedSession(dir, "session-fail")
        const result = yield* ingest({
          gitRoot: dir,
          dataDir: dir,
          sources: { opencodeSelf: true },
          extract: () =>
            Effect.succeed([
              {
                problem: "problem",
                rootCause: "context",
                solution: "solution",
                keywords: ["k"],
                source: new ForeignSource({
                  tool: "opencode",
                  sourceID: "session-fail",
                  projectID: Instance.project.id,
                }),
              },
            ]),
        }).pipe(Effect.provide(checkpointLayer(failedCheckpointCalls)))

        expect(result?.parseFailed).toBe(0)
        expect(result?.inserted).toBe(0)
        expect(result?.skippedDone).toBe(0)
        expect(failedCheckpointCalls).toHaveLength(0)
      }),
    ),
  )

  const itUnused = testEffect(Layer.mergeAll(memoryLayer("unused"), CrossSpawnSpawner.defaultLayer))

  itUnused.live("still checkpoints explicitly empty extraction results", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const emptyCheckpointCalls: Array<{ sourcePath: string }> = []
        yield* seedSession(dir, "session-empty")
        yield* ingest({
          gitRoot: dir,
          dataDir: dir,
          sources: { opencodeSelf: true },
          extract: () => Effect.succeed([]),
        }).pipe(Effect.provide(checkpointLayer(emptyCheckpointCalls)))

        expect(emptyCheckpointCalls).toHaveLength(1)
        expect(emptyCheckpointCalls[0]!.sourcePath).toBe("opencode-db:session-empty")
      }),
    ),
  )
})
