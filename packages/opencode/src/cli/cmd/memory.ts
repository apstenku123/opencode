/**
 * `opencode memory` — round-3 CLI surface for the MemCoder-style memory
 * subsystem. Subcommands mirror the HTTP RPC routes added in round-2 but
 * invoke the same handlers in-process so the CLI works without a running
 * serve daemon.
 *
 * Subcommands:
 *   - `status`   → per-project sextuple counts + foreign-ingest totals.
 *   - `reset`    → truncate project sextuples + foreign-ingest checkpoints.
 *   - `ingest`   → run the foreign-ingest pipeline (claude|cursor|codex|...).
 *   - `crawl`    → walk recent commits and emit sextuples to the JSONL cache.
 *   - `seed`     → insert a sextuple from JSON on stdin (test-harness aid).
 *   - `retrieve` → query the memory store, print scored hits as JSON.
 */

import type { Argv } from "yargs"
import { Effect, Layer } from "effect"
import * as prompts from "@clack/prompts"
import { EOL } from "os"

import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Global } from "../../global"
import { Instance } from "../../project/instance"
import {
  currentProjectID,
  deleteForProject,
  statusForProject,
} from "../../server/instance/memory"
import {
  ingest,
  makeLlmSessionExtractor,
  type ForeignIngestSources,
  type SessionExtractor,
} from "../../memory/foreign-ingest"
import {
  crawl,
  type CommitPolisher,
  type CommitRecord,
  parsePolisherJson,
} from "../../memory/commit-crawler"
import { NOOP_POLISHER } from "../../memory/auto-trigger"
import {
  Memory,
  layer as memoryFacadeLayer,
  memoryRetrievalLayer,
  memoryStorageLayer,
  mockEmbeddingLayer,
  makeMemoryBridge,
  type RetrievalMode,
} from "../../memory"
import { layer as foreignIngestCheckpointLayer } from "../../memory/foreign-ingest/checkpoint"
import { Config } from "../../config"
import { Provider } from "../../provider"
import { AppRuntime } from "../../effect/app-runtime"

const NO_OP_EXTRACTOR: SessionExtractor = () => Effect.succeed([])

/**
 * Resolve the configured extraction model (or the session default when
 * unset) into a `SessionExtractor` backed by a real LLM bridge. Returns
 * the no-op extractor when no model is available — mirrors the observer's
 * graceful fallback.
 */
const resolveLlmExtractor = Effect.gen(function* () {
  const cfg = yield* Config.Service.use((svc) => svc.get())
  const spec = cfg.memories?.extractionModel?.trim() || cfg.model?.trim()
  if (!spec) return NO_OP_EXTRACTOR
  const formatSchema = (
    cfg.memories as { extractionFormatSchema?: Record<string, unknown> } | undefined
  )?.extractionFormatSchema
  const bridge = yield* makeMemoryBridge({
    modelSpec: spec,
    formatSchema,
    schemaName: formatSchema ? "Phase1Extraction" : undefined,
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined as undefined)))
  if (!bridge) return NO_OP_EXTRACTOR
  return makeLlmSessionExtractor({ model: bridge })
})

const memoryStack = (() => {
  // `memoryRetrievalLayer` needs `MemoryStorage` → wire it through
  // explicitly (matches `defaultLayer` composition in `memory/index.ts`).
  const retrieval = Layer.provide(memoryRetrievalLayer, memoryStorageLayer)
  const deps = Layer.mergeAll(memoryStorageLayer, retrieval, mockEmbeddingLayer())
  return Layer.provideMerge(memoryFacadeLayer, deps)
})()
const ingestStack = Layer.provideMerge(memoryStack, foreignIngestCheckpointLayer)

// --------------------------------------------------------------------------
// `memory status`
// --------------------------------------------------------------------------

const StatusCommand = cmd({
  command: "status",
  describe: "show per-project memory counts and foreign-ingest totals",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      describe: "output as JSON",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const projectID = currentProjectID()
      const status = await statusForProject(projectID)
      if (args.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + EOL)
        return
      }
      UI.empty()
      prompts.intro("Memory status")
      prompts.log.info(`Project: ${status.projectID ?? "(global)"}`)
      prompts.log.info(
        `Sextuples: ${status.sextupleCount} (${status.embeddedCount} embedded)`,
      )
      if (status.foreignIngest.length === 0) {
        prompts.log.info("Foreign ingest: (none)")
      } else {
        prompts.log.info("Foreign ingest:")
        for (const row of status.foreignIngest) {
          prompts.log.info(`  ${row.tool}: ${row.count}`)
        }
      }
      prompts.outro("Done")
    })
  },
})

// --------------------------------------------------------------------------
// `memory reset`
// --------------------------------------------------------------------------

const ResetCommand = cmd({
  command: "reset",
  describe: "truncate memory sextuples and foreign-ingest checkpoints",
  builder: (yargs: Argv) =>
    yargs
      .option("yes", {
        describe: "skip confirmation prompt",
        type: "boolean",
        default: false,
        alias: "y",
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const projectID = currentProjectID()
      if (!args.yes) {
        UI.empty()
        prompts.intro("Memory reset")
        const scope = projectID ? `project ${projectID}` : "all projects (no project bound)"
        const confirm = await prompts.confirm({
          message: `Delete all memories for ${scope}? This cannot be undone.`,
          initialValue: false,
        })
        if (prompts.isCancel(confirm) || !confirm) {
          prompts.outro("Cancelled")
          return
        }
      }
      const result = await deleteForProject(projectID)
      if (args.json) {
        process.stdout.write(
          JSON.stringify({ projectID, ...result }, null, 2) + EOL,
        )
        return
      }
      prompts.log.success(
        `Deleted ${result.deletedSextuples} sextuple(s) and ${result.deletedCheckpoints} checkpoint(s)`,
      )
      prompts.outro("Done")
    })
  },
})

// --------------------------------------------------------------------------
// `memory ingest`
// --------------------------------------------------------------------------

export const INGEST_TOOLS = ["claude", "claude_ext", "cursor", "codex", "kiro", "opencode"] as const
export type IngestTool = (typeof INGEST_TOOLS)[number]

export function sourcesForTool(tool: IngestTool, dir: string): ForeignIngestSources {
  switch (tool) {
    case "claude":
    case "claude_ext":
      return { claudeProjectsDir: dir }
    case "cursor":
      return { cursorDir: dir }
    case "codex":
      return { codexDir: dir }
    case "kiro":
      return { kiroDbPath: dir }
    case "opencode":
      return { opencodeSelf: true }
  }
}

const IngestCommand = cmd({
  command: "ingest",
  describe: "run the foreign-ingest pipeline for a given tool + path",
  builder: (yargs: Argv) =>
    yargs
      .option("tool", {
        describe: "foreign tool to ingest from",
        choices: INGEST_TOOLS as unknown as string[],
        demandOption: true,
        type: "string",
      })
      .option("path", {
        describe:
          "source directory (e.g. ~/.claude/projects for claude, ~/.cursor for cursor)",
        type: "string",
      })
      .option("concurrency", {
        describe: "per-session concurrency",
        type: "number",
      })
      .option("extract", {
        describe:
          "run the Phase-1 LLM extractor on each ingested session — requires `memories.extractionModel` (or `model`) to be configured",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    const tool = args.tool as IngestTool
    if (tool !== "opencode" && !args.path) {
      UI.error(`--path is required for --tool=${tool}` + EOL)
      process.exit(1)
    }
    await bootstrap(process.cwd(), async () => {
      const projectID = currentProjectID()
      const gitRoot = Instance.worktree
      const dataDir = Global.Path.data
      const sources = sourcesForTool(tool, args.path ?? "")

      const extractor: SessionExtractor = args.extract
        ? await AppRuntime.runPromise(resolveLlmExtractor).catch(() => NO_OP_EXTRACTOR)
        : NO_OP_EXTRACTOR

      const program = ingest({
        gitRoot,
        dataDir,
        projectID: projectID ?? undefined,
        sources,
        extract: extractor,
        concurrency: args.concurrency,
      }).pipe(Effect.provide(ingestStack))

      const stats = await Effect.runPromise(program as Effect.Effect<any, any, never>)
      if (args.json) {
        process.stdout.write(
          JSON.stringify(stats ?? { skipped: true }, null, 2) + EOL,
        )
        return
      }
      UI.empty()
      prompts.intro(`Memory ingest (${tool})`)
      if (!stats) {
        prompts.log.warn("Skipped — another process holds the writer lock")
        prompts.outro("Done")
        return
      }
      prompts.log.info(`Discovered:    ${stats.discovered}`)
      prompts.log.info(`Skipped done:  ${stats.skippedDone}`)
      prompts.log.info(`Parse failed:  ${stats.parseFailed}`)
      prompts.log.info(`Produced:      ${stats.produced}`)
      prompts.log.info(`Inserted:      ${stats.inserted}`)
      prompts.log.info(`Duration:      ${stats.durationMs}ms`)
      prompts.outro("Done")
    })
  },
})

// --------------------------------------------------------------------------
// `memory crawl`
// --------------------------------------------------------------------------

/**
 * Resolve an LLM-backed {@link CommitPolisher} from the configured
 * `memories.polishModel` / `memories.extractionModel` / `cfg.model` spec.
 * Returns {@link NOOP_POLISHER} when no spec is configured — matches the
 * graceful-degrade contract of the auto-trigger + observer paths.
 *
 * The bridge call-prompt format follows the inline `PROMPT_TEMPLATE` in
 * `commit-crawler.ts` — the JSON response is parsed via
 * {@link parsePolisherJson} so prose-wrapped or fenced responses still
 * land in the JSONL cache.
 */
const resolveLlmPolisher = Effect.gen(function* () {
  const cfg = yield* Config.Service.use((svc) => svc.get())
  const spec =
    cfg.memories?.polishModel?.trim() ||
    cfg.memories?.extractionModel?.trim() ||
    cfg.model?.trim()
  if (!spec) return NOOP_POLISHER
  // Polish schema precedence: the dedicated `polishFormatSchema` (flat
  // `{keywords, problem, root_cause, solution}` shape matching
  // `PolisherSextuple`) wins, falling back to `extractionFormatSchema`
  // when callers want a single schema for both paths. When both are
  // unset the bridge stays on the free-form text path.
  const memCfg = cfg.memories as
    | {
        polishFormatSchema?: Record<string, unknown>
        extractionFormatSchema?: Record<string, unknown>
      }
    | undefined
  const formatSchema = memCfg?.polishFormatSchema ?? memCfg?.extractionFormatSchema
  const bridge = yield* makeMemoryBridge({
    modelSpec: spec,
    formatSchema,
    schemaName: formatSchema ? "PolisherSextuple" : undefined,
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined as undefined)))
  if (!bridge) return NOOP_POLISHER
  const polisher: CommitPolisher = (_commit: CommitRecord, prompt: string) =>
    Effect.gen(function* () {
      const raw = yield* bridge(prompt)
      if (!raw) return undefined
      return parsePolisherJson(raw)
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  return polisher
})

const CrawlCommand = cmd({
  command: "crawl",
  describe: "walk recent commits in the current repo and emit sextuples",
  builder: (yargs: Argv) =>
    yargs
      .option("limit", {
        describe: "maximum commits to walk",
        type: "number",
        default: 50,
      })
      .option("polish", {
        describe:
          "run a real LLM polisher on each commit — requires `memories.polishModel` / `memories.extractionModel` / `model` to be configured",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const repoRoot = Instance.worktree
      const dataDir = Global.Path.data
      const polisher: CommitPolisher = args.polish
        ? await AppRuntime.runPromise(resolveLlmPolisher).catch(() => NOOP_POLISHER)
        : NOOP_POLISHER
      const stats = await Effect.runPromise(
        crawl({
          repoRoot,
          dataDir,
          limit: args.limit,
          polish: polisher,
        }),
      )
      if (args.json) {
        process.stdout.write(JSON.stringify({ repoRoot, ...stats }, null, 2) + EOL)
        return
      }
      UI.empty()
      prompts.intro("Memory crawl")
      prompts.log.info(`Repo:              ${repoRoot}`)
      prompts.log.info(`Commits walked:    ${stats.commitsWalked}`)
      prompts.log.info(`Sextuples emitted: ${stats.sextuplesEmitted}`)
      prompts.log.info(`Skipped trivial:   ${stats.skippedTrivial}`)
      prompts.log.info(`Errors:            ${stats.errors}`)
      prompts.log.info(`Duration:          ${stats.durationMs}ms`)
      prompts.outro("Done")
    })
  },
})

// --------------------------------------------------------------------------
// `memory seed` — insert a sextuple from JSON on stdin (test-harness aid)
// --------------------------------------------------------------------------

const SeedCommand = cmd({
  command: "seed",
  describe:
    "insert a sextuple from the JSON body on stdin (embeds via mock embedder). Intended for e2e harnesses that need to prime the memory store before a live turn.",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      describe: "output result as JSON",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      process.stdin.on("data", (c: Buffer) => chunks.push(c))
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      process.stdin.on("error", reject)
    })
    let body: any
    try {
      body = JSON.parse(raw)
    } catch (err) {
      UI.error(`invalid JSON on stdin: ${(err as Error).message}${EOL}`)
      process.exit(1)
    }
    const keywords = Array.isArray(body?.keywords)
      ? body.keywords.filter((k: unknown) => typeof k === "string")
      : []
    const problem = typeof body?.problem === "string" ? body.problem : ""
    const rootCause =
      typeof body?.rootCause === "string"
        ? body.rootCause
        : typeof body?.root_cause === "string"
          ? body.root_cause
          : ""
    const solution = typeof body?.solution === "string" ? body.solution : ""
    await bootstrap(process.cwd(), async () => {
      const projectID = currentProjectID() ?? undefined
      const program = Effect.gen(function* () {
        const memory = yield* Memory
        const res = yield* memory.add({
          keywords,
          problem,
          rootCause,
          solution,
          projectID,
          source: {
            _tag: "foreign" as const,
            tool: typeof body?.source?.tool === "string" ? body.source.tool : "seed",
            sourceID:
              typeof body?.source?.sourceID === "string"
                ? body.source.sourceID
                : `seed-${Date.now()}`,
            projectID,
            timestamp: Date.now(),
          },
        })
        return res
      }).pipe(Effect.provide(memoryStack))
      const result = await Effect.runPromise(program as Effect.Effect<any, any, never>)
      if (args.json) {
        process.stdout.write(
          JSON.stringify(
            {
              inserted: result.inserted,
              embedded: result.embedded,
              hashId: result.record?.hashId,
              id: result.record?.id,
            },
            null,
            2,
          ) + EOL,
        )
        return
      }
      UI.empty()
      prompts.intro("Memory seed")
      prompts.log.info(`inserted: ${result.inserted}`)
      prompts.log.info(`embedded: ${result.embedded}`)
      prompts.log.info(`hashId:   ${result.record?.hashId}`)
      prompts.outro("Done")
    })
  },
})

// --------------------------------------------------------------------------
// `memory retrieve` — query the memory store, print scored hits as JSON
// --------------------------------------------------------------------------

const RetrieveCommand = cmd({
  command: "retrieve",
  describe: "retrieve scored sextuples matching a query (cosine | bm25 | hybrid)",
  builder: (yargs: Argv) =>
    yargs
      .option("query", {
        describe: "query text",
        type: "string",
        demandOption: true,
      })
      .option("mode", {
        describe: "retrieval mode",
        choices: ["cosine", "bm25", "hybrid"] as const,
        default: "hybrid" as const,
      })
      .option("top-k", {
        describe: "max number of hits to return",
        type: "number",
        default: 5,
      })
      .option("min-score", {
        describe: "minimum score floor",
        type: "number",
        default: 0,
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: true,
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const projectID = currentProjectID() ?? undefined
      const program = Effect.gen(function* () {
        const memory = yield* Memory
        const hits = yield* memory.retrieve({
          queryText: args.query as string,
          projectID,
          topK: args["top-k"] as number,
          minScore: args["min-score"] as number,
          mode: args.mode as RetrievalMode,
        })
        return hits
      }).pipe(Effect.provide(memoryStack))
      const hits = await Effect.runPromise(program as Effect.Effect<any, any, never>)
      const rows = (hits as ReadonlyArray<any>).map((h) => ({
        score: h.score,
        hashId: h.record?.hashId,
        problem: h.record?.problem,
        rootCause: h.record?.rootCause,
        solution: h.record?.solution,
        keywords: h.record?.keywords,
      }))
      if (args.json) {
        process.stdout.write(JSON.stringify({ mode: args.mode, hits: rows }, null, 2) + EOL)
        return
      }
      UI.empty()
      prompts.intro(`Memory retrieve (${args.mode})`)
      for (const row of rows) {
        prompts.log.info(`[${row.score.toFixed(3)}] ${row.problem}`)
      }
      prompts.outro("Done")
    })
  },
})

// --------------------------------------------------------------------------
// Top-level `memory` command
// --------------------------------------------------------------------------

export const MemoryCommand = cmd({
  command: "memory",
  describe: "manage MemCoder-style long-term memory",
  builder: (yargs: Argv) =>
    yargs
      .command(StatusCommand)
      .command(ResetCommand)
      .command(IngestCommand)
      .command(CrawlCommand)
      .command(SeedCommand)
      .command(RetrieveCommand)
      .demandCommand(),
  async handler() {},
})
