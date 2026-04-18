/**
 * Opportunistic commit-crawler auto-trigger.
 *
 * On instance bootstrap, if `memories.enabled` is set in config, fork a
 * background `crawl()` pass over the current git worktree — but only when
 * the on-disk "last crawl" marker indicates we haven't run in the past
 * {@link AUTO_TRIGGER_COOLDOWN_MS}. This preserves the round-1 contract
 * that memory operations are off-by-default AND cheap-by-default: the
 * marker is flushed even on failure so a broken polisher never pins the
 * crawler in a retry loop.
 *
 * The crawler callback is a no-op polisher by default — round-3 wires
 * `/memory/{status,reset,ingest,crawl}` + the CLI surface but the real
 * LLM polisher lands alongside the phase-1 extractor plumbing. Until
 * then, `autoTrigger` is a scheduling shim that burns the marker + calls
 * `crawl` with an empty polisher so the SHA-walk + JSONL plumbing stays
 * exercised in production instances.
 */

import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { Global } from "../global"
import { Instance } from "../project/instance"
import { Config } from "../config"
import { Log } from "../util"
import {
  type CommitPolisher,
  type CrawlStats,
  commitMemoryDir,
  crawl,
} from "./commit-crawler"

const log = Log.create({ service: "memory.auto-trigger" })

/** 24 hours in ms — matches the Rust MemCoder heuristic. */
export const AUTO_TRIGGER_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Commits processed per auto-trigger invocation; round-3 keeps this low
 * so a first-time crawl across a big repo happens over several sessions
 * instead of stalling bootstrap. */
export const AUTO_TRIGGER_COMMIT_LIMIT = 50

/**
 * Per-repo marker file recording when the auto-trigger last ran.
 * Co-located with commit-crawler state so a `memory reset` that nukes
 * `memory/commit_memory/` also forgets the cooldown.
 */
export function autoTriggerMarkerPath(dataDir: string, repoRoot: string): string {
  const repoHash = (() => {
    const canonical = path.resolve(repoRoot)
    // SHA is overkill here — but match commit-crawler's hash so support
    // tooling only needs to know one scheme per repo.
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
  })()
  return path.join(commitMemoryDir(dataDir), `${repoHash}_autotrigger.txt`)
}

export function readLastTriggerAt(markerPath: string): number {
  if (!existsSync(markerPath)) return 0
  try {
    const raw = readFileSync(markerPath, "utf8").trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function writeLastTriggerAt(markerPath: string, timestamp: number): void {
  try {
    mkdirSync(path.dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, String(timestamp))
  } catch {
    // Best-effort; a failed flush just means we'll retry sooner next run.
  }
}

/** No-op polisher used when the real LLM-backed polisher hasn't landed.
 * Returns `undefined` for every commit — each SHA is tallied as an error
 * so it stays pending for the next real run. */
export const NOOP_POLISHER: CommitPolisher = () => Effect.succeed(undefined)

export interface AutoTriggerInput {
  readonly repoRoot: string
  readonly dataDir?: string
  readonly now?: number
  readonly cooldownMs?: number
  readonly limit?: number
  readonly polish?: CommitPolisher
}

export interface AutoTriggerResult {
  readonly triggered: boolean
  readonly reason:
    | "ran"
    | "disabled"
    | "cooldown"
    | "no-repo"
  readonly stats?: CrawlStats
}

/**
 * Decide whether the crawler should run and, if so, execute it.
 *
 * The cooldown check is separate from `crawl` invocation so callers can
 * skip the entire layer-stack assembly when a crawl isn't due.
 */
export const autoTrigger = (input: AutoTriggerInput) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const cooldown = input.cooldownMs ?? AUTO_TRIGGER_COOLDOWN_MS
    const dataDir = input.dataDir ?? Global.Path.data
    const markerPath = autoTriggerMarkerPath(dataDir, input.repoRoot)
    const lastAt = readLastTriggerAt(markerPath)
    if (lastAt > 0 && now - lastAt < cooldown) {
      return { triggered: false, reason: "cooldown" } as AutoTriggerResult
    }
    // Burn the marker BEFORE running — even if the crawl crashes we
    // respect the cooldown and don't retry-storm.
    writeLastTriggerAt(markerPath, now)
    const exit = yield* Effect.exit(
      crawl({
        repoRoot: input.repoRoot,
        dataDir,
        limit: input.limit ?? AUTO_TRIGGER_COMMIT_LIMIT,
        polish: input.polish ?? NOOP_POLISHER,
      }),
    )
    if (exit._tag === "Failure") {
      log.warn("auto-trigger crawl failed", { cause: String(exit.cause) })
      return { triggered: true, reason: "ran" } as AutoTriggerResult
    }
    return { triggered: true, reason: "ran", stats: exit.value } as AutoTriggerResult
  })

/**
 * Bootstrap hook: resolve config + worktree, then fork `autoTrigger` in
 * the background. Never throws — a failed read, missing repo, or disabled
 * config all short-circuit silently.
 */
export const autoTriggerOnBootstrap = Effect.gen(function* () {
  const cfg = yield* Config.Service.use((svc) => svc.get())
  if (!cfg.memories?.enabled) {
    return { triggered: false, reason: "disabled" } as AutoTriggerResult
  }
  let repoRoot: string
  try {
    repoRoot = Instance.worktree
  } catch {
    return { triggered: false, reason: "no-repo" } as AutoTriggerResult
  }
  return yield* autoTrigger({ repoRoot })
}).pipe(Effect.withSpan("Memory.autoTriggerOnBootstrap"))
