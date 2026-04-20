/**
 * `/memory/*` HTTP RPC routes.
 *
 * Round-2 deliverables:
 *  - `POST /memory/reset`   — truncate `memory_sextuple` for the current
 *                             project; emits `Memory.Event.Reset` on the bus.
 *  - `GET  /memory/status`  — per-project counts (sextuples,
 *                             foreign-ingest checkpoints by tool).
 *  - `POST /memory/ingest`  — manually trigger the foreign-ingest pipeline
 *                             for the current project.
 *
 * Routes return JSON. Schemas are declared with Zod + hono-openapi so the
 * generated OpenAPI spec stays accurate.
 */

import { Effect, Layer } from "effect"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import path from "node:path"
import z from "zod"

import { Bus } from "../../bus"
import { BusEvent } from "../../bus/bus-event"
import { Database, eq, sql as drizzleSql } from "../../storage"
import { Instance } from "../../project/instance"
import {
  layer as memoryFacadeLayer,
  memoryRetrievalLayer,
  memoryStorageLayer,
  autoEmbeddingLayer,
} from "../../memory"
import { layer as foreignIngestCheckpointLayer } from "../../memory/foreign-ingest/checkpoint"
import { ForeignIngestDoneTable, MemorySextupleTable } from "../../memory/memory.sql"
import {
  ingest,
  makeLlmSessionExtractor,
  type ForeignIngestSources,
  type SessionExtractor,
} from "../../memory/foreign-ingest"
import { makeMemoryBridge } from "../../memory/llm-bridge"
import { crawl } from "../../memory/commit-crawler"
import { NOOP_POLISHER } from "../../memory/auto-trigger"
import { Config } from "../../config"
import { Provider } from "../../provider"

// --------------------------------------------------------------------------
// Bus event
// --------------------------------------------------------------------------

/**
 * Fired after a successful `/memory/reset` so subscribers (TUI, sync,
 * downstream extractors) can flush their caches. Mirrors the Rust
 * `Memory::Event::Reset` event emitted by `control::reset_all_memories`.
 */
export const MemoryResetEvent = BusEvent.define(
  "memory.reset",
  z.object({
    projectID: z.string().nullable(),
    deletedSextuples: z.number().int().min(0),
    deletedCheckpoints: z.number().int().min(0),
  }),
)

export const MemoryIngestStartedEvent = BusEvent.define(
  "memory.ingest.started",
  z.object({ gitRoot: z.string(), projectID: z.string().nullable() }),
)

export const MemoryIngestCompletedEvent = BusEvent.define(
  "memory.ingest.completed",
  z.object({
    gitRoot: z.string(),
    projectID: z.string().nullable(),
    discovered: z.number().int(),
    inserted: z.number().int(),
    durationMs: z.number().int(),
  }),
)

export const MemoryCrawlCompletedEvent = BusEvent.define(
  "memory.crawl.completed",
  z.object({
    repoRoot: z.string(),
    commitsWalked: z.number().int(),
    sextuplesEmitted: z.number().int(),
    durationMs: z.number().int(),
  }),
)

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

const ResetResponse = z
  .object({
    projectID: z.string().nullable(),
    deletedSextuples: z.number().int(),
    deletedCheckpoints: z.number().int(),
  })
  .meta({ ref: "MemoryResetResponse" })

const StatusResponse = z
  .object({
    projectID: z.string().nullable(),
    sextupleCount: z.number().int(),
    embeddedCount: z.number().int(),
    foreignIngest: z.array(
      z.object({
        tool: z.string(),
        count: z.number().int(),
      }),
    ),
  })
  .meta({ ref: "MemoryStatus" })

const MemoryListItem = z
  .object({
    id: z.string(),
    hashId: z.string(),
    projectID: z.string().nullable(),
    keywords: z.array(z.string()),
    problem: z.string(),
    rootCause: z.string(),
    solution: z.string(),
    embedded: z.boolean(),
    timeCreated: z.number().int(),
    timeUpdated: z.number().int(),
  })
  .meta({ ref: "MemoryListItem" })

const ListResponse = z
  .object({
    projectID: z.string().nullable(),
    items: z.array(MemoryListItem),
  })
  .meta({ ref: "MemoryListResponse" })

const ForeignIngestSessionDetailRequest = z
  .object({
    tool: z.string().min(1),
    sourceID: z.string().min(1),
    gitRoot: z.string().optional(),
  })
  .meta({ ref: "ForeignIngestSessionDetailRequest" })

const ForeignIngestSessionDetail = z
  .object({
    tool: z.string(),
    sourceID: z.string(),
    sourcePath: z.string(),
    contentHash: z.string().nullable(),
    updatedAt: z.number().int().nullable(),
    state: z.enum(["pending", "done"]),
    storedSextuplesCount: z.number().int(),
    storedSkillsCount: z.number().int(),
    ingestedAt: z.number().int().nullable(),
  })
  .meta({ ref: "ForeignIngestSessionDetail" })

const ForeignIngestSessionDetailResponse = z
  .object({
    projectID: z.string().nullable(),
    gitRoot: z.string().nullable(),
    detail: ForeignIngestSessionDetail,
  })
  .meta({ ref: "ForeignIngestSessionDetailResponse" })

const IngestRequestBody = z
  .object({
    gitRoot: z.string().optional(),
    sources: z
      .object({
        claudeProjectsDir: z.string().optional(),
        cursorDir: z.string().optional(),
        codexDir: z.string().optional(),
        kiroDbPath: z.string().optional(),
        opencodeSelf: z.boolean().optional(),
      })
      .optional(),
    concurrency: z.number().int().positive().max(32).optional(),
    extract: z
      .boolean()
      .optional()
      .describe(
        "When true, run the Phase-1 LLM extractor on each ingested session. Requires `memories.extractionModel` (or `model`) to be configured. Default false.",
      ),
  })
  .meta({ ref: "MemoryIngestRequest" })

const MemoryExtractionFormatSchema = z.record(z.string(), z.unknown())

const IngestResponse = z
  .object({
    skipped: z.boolean(),
    discovered: z.number().int(),
    inserted: z.number().int(),
    skippedDone: z.number().int(),
    parseFailed: z.number().int(),
    produced: z.number().int(),
    durationMs: z.number().int(),
  })
  .meta({ ref: "MemoryIngestResponse" })

const CrawlRequestBody = z
  .object({
    repoRoot: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .meta({ ref: "MemoryCrawlRequest" })

const CrawlResponse = z
  .object({
    repoRoot: z.string(),
    commitsWalked: z.number().int(),
    sextuplesEmitted: z.number().int(),
    skippedTrivial: z.number().int(),
    errors: z.number().int(),
    durationMs: z.number().int(),
  })
  .meta({ ref: "MemoryCrawlResponse" })

// --------------------------------------------------------------------------
// Layer composition
// --------------------------------------------------------------------------

/**
 * Round-2 wiring: the Memory facade isn't yet part of `AppLayer`, so we
 * provide it on a per-request basis. The mock embedding layer is used when
 * the real provider is not configured — round-3 swaps in the
 * `openAICompatLayer` once the embedding-config plumbing lands.
 */
const memoryStack = (() => {
  const retrieval = Layer.provide(memoryRetrievalLayer, memoryStorageLayer)
  return Layer.provideMerge(
    memoryFacadeLayer,
    Layer.mergeAll(memoryStorageLayer, retrieval, autoEmbeddingLayer()),
  )
})()

const ingestStack = Layer.provideMerge(memoryStack, foreignIngestCheckpointLayer)

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

const NO_OP_EXTRACTOR: SessionExtractor = () => Effect.succeed([])

/**
 * Resolve an extractor backed by a real LLM bridge from the configured
 * `memories.extractionModel` (or session default `cfg.model`). Falls
 * back to the no-op extractor when no model is available — the session
 * is still checkpointed so it isn't reprocessed.
 */
const resolveLlmExtractor = Effect.gen(function* () {
  const cfg = yield* Config.Service.use((svc) => svc.get())
  const spec = cfg.memories?.extractionModel?.trim() || cfg.model?.trim()
  if (!spec) return NO_OP_EXTRACTOR
  const formatSchema = MemoryExtractionFormatSchema.optional().parse(
    (cfg.memories as { extractionFormatSchema?: Record<string, unknown> } | undefined)
      ?.extractionFormatSchema,
  )
  const bridge = yield* makeMemoryBridge({
    modelSpec: spec,
    formatSchema,
    schemaName: formatSchema ? "Phase1Extraction" : undefined,
  }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined as undefined)),
  )
  if (!bridge) return NO_OP_EXTRACTOR
  return makeLlmSessionExtractor({ model: bridge })
})

export const MemoryRoutes = () =>
  new Hono()
    .post(
      "/reset",
      describeRoute({
        summary: "Reset memory for the current project",
        description:
          "Truncate `memory_sextuple` and `foreign_ingest_done` rows scoped to the current project, then emit `memory.reset` on the bus.",
        operationId: "memory.reset",
        responses: {
          200: {
            description: "Reset complete",
            content: { "application/json": { schema: resolver(ResetResponse) } },
          },
        },
      }),
      async (c) => {
        const projectID = currentProjectID()
        const result = await deleteForProject(projectID)
        await Bus.publish(MemoryResetEvent, {
          projectID,
          deletedSextuples: result.deletedSextuples,
          deletedCheckpoints: result.deletedCheckpoints,
        })
        return c.json({
          projectID,
          deletedSextuples: result.deletedSextuples,
          deletedCheckpoints: result.deletedCheckpoints,
        })
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Memory status for the current project",
        description: "Return per-project sextuple counts plus per-tool foreign-ingest checkpoint counts.",
        operationId: "memory.status",
        responses: {
          200: {
            description: "Status payload",
            content: { "application/json": { schema: resolver(StatusResponse) } },
          },
        },
      }),
      async (c) => {
        const projectID = currentProjectID()
        const status = await statusForProject(projectID)
        return c.json(status)
      },
    )
    .get(
      "/list",
      describeRoute({
        summary: "List memory sextuples for the current project",
        description:
          "Return stored memory sextuples for the current project ordered by newest first. This is a read-only introspection surface for debugging and parity checks.",
        operationId: "memory.list",
        responses: {
          200: {
            description: "Memory sextuple list",
            content: { "application/json": { schema: resolver(ListResponse) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const projectID = currentProjectID()
        const items = await listForProject(projectID, query.limit)
        return c.json({
          projectID,
          items,
        })
      },
    )
    .get(
      "/session-detail",
      describeRoute({
        summary: "Get foreign-ingest session detail for the current project",
        description:
          "Return exact-root foreign-ingest detail for one `(tool, sourceID, gitRoot)` session, including stored sextuple counts scoped to the resolved project/worktree.",
        operationId: "memory.sessionDetail",
        responses: {
          200: {
            description: "Foreign-ingest session detail",
            content: { "application/json": { schema: resolver(ForeignIngestSessionDetailResponse) } },
          },
        },
      }),
      validator("query", ForeignIngestSessionDetailRequest),
      async (c) => {
        const query = c.req.valid("query")
        const projectID = currentProjectID()
        const body = await sessionDetailForProject({
          projectID,
          tool: query.tool,
          sourceID: query.sourceID,
          gitRoot: query.gitRoot,
        })
        return c.json(body)
      },
    )
    .post(
      "/ingest",
      describeRoute({
        summary: "Trigger foreign-ingest for the current project",
        description:
          "Run the foreign-ingest pipeline (Claude / Cursor / Codex / OpenCode-self / Kiro) bounded to the current git root. The pipeline acquires a per-git-root advisory writer lock — if another OpenCode instance is already ingesting, this returns `skipped: true`.",
        operationId: "memory.ingest",
        responses: {
          200: {
            description: "Ingest result",
            content: { "application/json": { schema: resolver(IngestResponse) } },
          },
        },
      }),
      validator("json", IngestRequestBody.optional()),
      async (c) => {
        const body = (c.req.valid("json") ?? {}) as z.infer<typeof IngestRequestBody>
        const projectID = currentProjectID()
        const gitRoot = body.gitRoot ?? Instance.worktree
        const dataDir = (await import("../../global")).Global.Path.data
        const sources: ForeignIngestSources = body.sources ?? {}

        await Bus.publish(MemoryIngestStartedEvent, { gitRoot, projectID })

        const extractor = body.extract
          ? await Effect.runPromise(
              resolveLlmExtractor.pipe(
                Effect.provide(Config.defaultLayer),
                Effect.provide(Provider.defaultLayer),
              ) as Effect.Effect<SessionExtractor, unknown, never>,
            ).catch(() => NO_OP_EXTRACTOR)
          : NO_OP_EXTRACTOR

        const program = ingest({
          gitRoot,
          dataDir,
          projectID: projectID ?? undefined,
          sources,
          extract: extractor,
          concurrency: body.concurrency,
        }).pipe(Effect.provide(ingestStack))

        const stats = await Effect.runPromise(program as Effect.Effect<any, any, never>).catch((err) => {
          // Surface as 500 to caller but keep harness exposure simple.
          throw err
        })

        if (!stats) {
          // Lock held by another process.
          return c.json({
            skipped: true,
            discovered: 0,
            inserted: 0,
            skippedDone: 0,
            parseFailed: 0,
            produced: 0,
            durationMs: 0,
          })
        }
        await Bus.publish(MemoryIngestCompletedEvent, {
          gitRoot,
          projectID,
          discovered: stats.discovered,
          inserted: stats.inserted,
          durationMs: stats.durationMs,
        })
        return c.json({
          skipped: false,
          discovered: stats.discovered,
          inserted: stats.inserted,
          skippedDone: stats.skippedDone,
          parseFailed: stats.parseFailed,
          produced: stats.produced,
          durationMs: stats.durationMs,
        })
      },
    )
    .post(
      "/crawl",
      describeRoute({
        summary: "Run the commit crawler for the current repo",
        description:
          "Walk up to `limit` recent commits in the given repo and extract sextuples into the per-repo JSONL cache. The round-3 default polisher is a no-op — SHAs remain pending until the real LLM polisher is wired.",
        operationId: "memory.crawl",
        responses: {
          200: {
            description: "Crawl stats",
            content: { "application/json": { schema: resolver(CrawlResponse) } },
          },
        },
      }),
      validator("json", CrawlRequestBody.optional()),
      async (c) => {
        const body = (c.req.valid("json") ?? {}) as z.infer<typeof CrawlRequestBody>
        const repoRoot = body.repoRoot ?? Instance.worktree
        const dataDir = (await import("../../global")).Global.Path.data
        const limit = body.limit ?? 50
        const stats = await Effect.runPromise(
          crawl({ repoRoot, dataDir, limit, polish: NOOP_POLISHER }),
        )
        await Bus.publish(MemoryCrawlCompletedEvent, {
          repoRoot,
          commitsWalked: stats.commitsWalked,
          sextuplesEmitted: stats.sextuplesEmitted,
          durationMs: stats.durationMs,
        })
        return c.json({
          repoRoot,
          commitsWalked: stats.commitsWalked,
          sextuplesEmitted: stats.sextuplesEmitted,
          skippedTrivial: stats.skippedTrivial,
          errors: stats.errors,
          durationMs: stats.durationMs,
        })
      },
    )

// --------------------------------------------------------------------------
// Internal helpers (exported for tests)
// --------------------------------------------------------------------------

export function currentProjectID(): string | null {
  try {
    return Instance.current.project.id
  } catch {
    return null
  }
}

export interface ResetCounts {
  readonly deletedSextuples: number
  readonly deletedCheckpoints: number
}

/**
 * Truncate `memory_sextuple` and `foreign_ingest_done` for a given project
 * scope. When `projectID === null`, every row is deleted (used by the
 * "no project bound" code path so a global reset is always available).
 *
 * Foreign-ingest checkpoints are scoped by `git_root === Instance.worktree`
 * because checkpoint rows aren't keyed by `project_id` — the writer-lock
 * already binds them to a repo root.
 */
export async function deleteForProject(projectID: string | null): Promise<ResetCounts> {
  return Database.use((db) => {
    const sxResult = projectID
      ? db.delete(MemorySextupleTable).where(eq(MemorySextupleTable.project_id, projectID)).run()
      : db.delete(MemorySextupleTable).run()
    let chResult: any
    if (projectID) {
      let gitRoot: string | undefined
      try {
        gitRoot = Instance.worktree
      } catch {
        gitRoot = undefined
      }
      if (gitRoot) {
        chResult = db.delete(ForeignIngestDoneTable).where(eq(ForeignIngestDoneTable.git_root, gitRoot)).run()
      } else {
        chResult = { changes: 0 }
      }
    } else {
      chResult = db.delete(ForeignIngestDoneTable).run()
    }
    return {
      deletedSextuples: Number((sxResult as unknown as { changes?: number })?.changes ?? 0),
      deletedCheckpoints: Number((chResult as unknown as { changes?: number })?.changes ?? 0),
    }
  })
}

export async function statusForProject(projectID: string | null) {
  return Database.use((db) => {
    const sxQuery = projectID
      ? db
          .select({
            total: drizzleSql<number>`COUNT(*)`,
            embedded: drizzleSql<number>`SUM(CASE WHEN ${MemorySextupleTable.embedding} IS NOT NULL THEN 1 ELSE 0 END)`,
          })
          .from(MemorySextupleTable)
          .where(eq(MemorySextupleTable.project_id, projectID))
      : db
          .select({
            total: drizzleSql<number>`COUNT(*)`,
            embedded: drizzleSql<number>`SUM(CASE WHEN ${MemorySextupleTable.embedding} IS NOT NULL THEN 1 ELSE 0 END)`,
          })
          .from(MemorySextupleTable)
    const [counts] = sxQuery.all()
    const gitRoot = projectID
      ? (() => {
          try {
            return Instance.worktree
          } catch {
            return undefined
          }
        })()
      : undefined
    const checkpointQuery = db
      .select({
        tool: ForeignIngestDoneTable.tool,
        count: drizzleSql<number>`COUNT(*)`,
      })
      .from(ForeignIngestDoneTable)
    const checkpointRows = (gitRoot
      ? checkpointQuery.where(eq(ForeignIngestDoneTable.git_root, gitRoot))
      : checkpointQuery
    )
      .groupBy(ForeignIngestDoneTable.tool)
      .all()

    return {
      projectID,
      sextupleCount: Number(counts?.total ?? 0),
      embeddedCount: Number(counts?.embedded ?? 0),
      foreignIngest: checkpointRows.map((r) => ({ tool: String(r.tool), count: Number(r.count) })),
    }
  })
}

export async function listForProject(projectID: string | null, limit?: number) {
  const program = Effect.gen(function* () {
    const memory = yield* Memory
    const rows = yield* memory.listByProject(projectID ?? undefined, limit)
    return rows.map((row: Awaited<typeof rows>[number]) => ({
      id: row.id,
      hashId: row.hashId,
      projectID: row.projectID ?? null,
      keywords: row.keywords,
      problem: row.problem,
      rootCause: row.rootCause,
      solution: row.solution,
      embedded: row.embedding !== undefined,
      timeCreated: row.timeCreated,
      timeUpdated: row.timeUpdated,
    }))
  }).pipe(Effect.provide(memoryStack))

  return Effect.runPromise(program as Effect.Effect<any, any, never>)
}

export async function sessionDetailForProject(input: {
  projectID: string | null
  tool: string
  sourceID: string
  gitRoot?: string
}) {
  return Database.use((db) => {
    const resolvedGitRoot =
      input.gitRoot ??
      (input.projectID
        ? (() => {
            try {
              return Instance.worktree
            } catch {
              return undefined
            }
          })()
        : undefined)

    const checkpointBase = db
      .select()
      .from(ForeignIngestDoneTable)
      .where(eq(ForeignIngestDoneTable.tool, input.tool))
      .all()
      .filter((row) => {
        if (resolvedGitRoot === undefined) return true
        return row.git_root === resolvedGitRoot
      })

    const checkpoint = checkpointBase.find((row) => {
      const sourcePath = row.source_path
      const base = path.basename(sourcePath)
      const stem = base.replace(/\.(jsonl|json|db)$/i, "")
      return sourcePath === input.sourceID || stem === input.sourceID || sourcePath.endsWith(`:${input.sourceID}`)
    })

    const sextupleBase = db
      .select()
      .from(MemorySextupleTable)
      .all()
      .filter((row) => {
        if (input.projectID !== null && row.project_id !== input.projectID) return false
        const source = row.source as unknown as Record<string, unknown>
        if (source.type !== "foreign") return false
        if (source.tool !== input.tool) return false
        if (source.source_id !== input.sourceID) return false
        return true
      })

    const detailRows = sextupleBase.sort((a, b) => b.time_updated - a.time_updated)
    const latest = detailRows[0]
    const sourcePath = checkpoint?.source_path ?? input.sourceID
    const updatedAt = checkpoint?.done_at ?? latest?.time_updated ?? null

    return {
      projectID: input.projectID,
      gitRoot: resolvedGitRoot ?? null,
      detail: {
        tool: input.tool,
        sourceID: input.sourceID,
        sourcePath,
        contentHash: checkpoint?.content_hash ?? null,
        updatedAt,
        state: checkpoint ? "done" : "pending",
        storedSextuplesCount: detailRows.length,
        storedSkillsCount: 0,
        ingestedAt: checkpoint?.done_at ?? null,
      },
    }
  })
}
