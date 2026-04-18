/**
 * `opencode memory` — round-3 CLI surface for the MemCoder-style memory
 * subsystem. Subcommands mirror the HTTP RPC routes added in round-2 but
 * invoke the same handlers in-process so the CLI works without a running
 * serve daemon.
 *
 * Subcommands:
 *   - `status`  → per-project sextuple counts + foreign-ingest totals.
 *   - `reset`   → truncate project sextuples + foreign-ingest checkpoints.
 *   - `ingest`  → run the foreign-ingest pipeline (claude|cursor|codex|...).
 *   - `crawl`   → walk recent commits and emit sextuples to the JSONL cache.
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
  type ForeignIngestSources,
  type SessionExtractor,
} from "../../memory/foreign-ingest"
import { crawl } from "../../memory/commit-crawler"
import { NOOP_POLISHER } from "../../memory/auto-trigger"
import {
  layer as memoryFacadeLayer,
  memoryRetrievalLayer,
  memoryStorageLayer,
  mockEmbeddingLayer,
} from "../../memory"
import { layer as foreignIngestCheckpointLayer } from "../../memory/foreign-ingest/checkpoint"

const NO_OP_EXTRACTOR: SessionExtractor = () => Effect.succeed([])

const memoryStack = Layer.provideMerge(
  memoryFacadeLayer,
  Layer.mergeAll(memoryStorageLayer, memoryRetrievalLayer, mockEmbeddingLayer()),
)
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

      const program = ingest({
        gitRoot,
        dataDir,
        projectID: projectID ?? undefined,
        sources,
        extract: NO_OP_EXTRACTOR,
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
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const repoRoot = Instance.worktree
      const dataDir = Global.Path.data
      const stats = await Effect.runPromise(
        crawl({
          repoRoot,
          dataDir,
          limit: args.limit,
          polish: NOOP_POLISHER,
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
      .demandCommand(),
  async handler() {},
})
