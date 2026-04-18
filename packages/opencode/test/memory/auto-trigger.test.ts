import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { Effect } from "effect"

import {
  AUTO_TRIGGER_COOLDOWN_MS,
  NOOP_POLISHER,
  autoTrigger,
  autoTriggerMarkerPath,
  readLastTriggerAt,
  writeLastTriggerAt,
} from "../../src/memory/auto-trigger"

// --------------------------------------------------------------------------
// marker IO
// --------------------------------------------------------------------------

describe("memory/auto-trigger/marker", () => {
  let dataDir: string
  let repoRoot: string

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "occ-at-data-"))
    repoRoot = mkdtempSync(path.join(tmpdir(), "occ-at-repo-"))
  })
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test("marker path lives under memory/commit_memory/<hash>_autotrigger.txt", () => {
    const p = autoTriggerMarkerPath(dataDir, repoRoot)
    expect(p.startsWith(path.join(dataDir, "memory", "commit_memory"))).toBe(true)
    expect(p.endsWith("_autotrigger.txt")).toBe(true)
  })

  test("read returns 0 when marker absent", () => {
    const p = autoTriggerMarkerPath(dataDir, repoRoot)
    expect(readLastTriggerAt(p)).toBe(0)
  })

  test("write + read roundtrip", () => {
    const p = autoTriggerMarkerPath(dataDir, repoRoot)
    writeLastTriggerAt(p, 1_700_000_000_000)
    expect(readLastTriggerAt(p)).toBe(1_700_000_000_000)
    expect(existsSync(p)).toBe(true)
  })

  test("read tolerates garbage contents", () => {
    const p = autoTriggerMarkerPath(dataDir, repoRoot)
    writeLastTriggerAt(p, 5)
    // Overwrite with non-numeric junk.
    const fs = require("node:fs") as typeof import("node:fs")
    fs.writeFileSync(p, "not-a-number")
    expect(readLastTriggerAt(p)).toBe(0)
  })
})

// --------------------------------------------------------------------------
// autoTrigger behavior
// --------------------------------------------------------------------------

function initEmptyRepo(dir: string): void {
  spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" })
  spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { encoding: "utf8" })
  spawnSync("git", ["-C", dir, "config", "user.name", "test"], { encoding: "utf8" })
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "initial"], { encoding: "utf8" })
}

describe("memory/auto-trigger/autoTrigger", () => {
  let dataDir: string
  let repoRoot: string

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "occ-at-run-data-"))
    repoRoot = mkdtempSync(path.join(tmpdir(), "occ-at-run-repo-"))
    initEmptyRepo(repoRoot)
  })
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test("first call triggers a crawl and writes the marker", async () => {
    const result = await Effect.runPromise(
      autoTrigger({
        repoRoot,
        dataDir,
        now: 1_000_000,
        limit: 10,
        polish: NOOP_POLISHER,
      }),
    )
    expect(result.triggered).toBe(true)
    expect(result.reason).toBe("ran")
    expect(result.stats?.commitsWalked).toBeGreaterThanOrEqual(1)
    // NOOP polisher returns undefined → every SHA is an error (not emitted).
    expect(result.stats?.sextuplesEmitted ?? -1).toBe(0)

    const marker = autoTriggerMarkerPath(dataDir, repoRoot)
    expect(readLastTriggerAt(marker)).toBe(1_000_000)
  })

  test("second call within cooldown is skipped", async () => {
    const result = await Effect.runPromise(
      autoTrigger({
        repoRoot,
        dataDir,
        now: 1_000_000 + 60_000, // 60s after last
        cooldownMs: AUTO_TRIGGER_COOLDOWN_MS,
        polish: NOOP_POLISHER,
      }),
    )
    expect(result.triggered).toBe(false)
    expect(result.reason).toBe("cooldown")
    expect(result.stats).toBeUndefined()
  })

  test("call after cooldown expires triggers again", async () => {
    const later = 1_000_000 + AUTO_TRIGGER_COOLDOWN_MS + 1
    const result = await Effect.runPromise(
      autoTrigger({
        repoRoot,
        dataDir,
        now: later,
        cooldownMs: AUTO_TRIGGER_COOLDOWN_MS,
        polish: NOOP_POLISHER,
      }),
    )
    expect(result.triggered).toBe(true)
    expect(result.reason).toBe("ran")

    const marker = autoTriggerMarkerPath(dataDir, repoRoot)
    expect(readLastTriggerAt(marker)).toBe(later)
  })

  test("marker is burned BEFORE crawl runs (no retry-storm on failure)", async () => {
    // Create a fresh repo to isolate from the previous tests.
    const repo2 = mkdtempSync(path.join(tmpdir(), "occ-at-burn-"))
    const data2 = mkdtempSync(path.join(tmpdir(), "occ-at-burn-data-"))
    initEmptyRepo(repo2)
    try {
      const throwingPolisher = () => Effect.die("simulated polisher crash")
      const result = await Effect.runPromise(
        autoTrigger({
          repoRoot: repo2,
          dataDir: data2,
          now: 42,
          polish: throwingPolisher as never,
        }).pipe(Effect.orElseSucceed(() => ({ triggered: true, reason: "ran" as const }))),
      )
      // Even though the crawl died, the marker should already be flushed.
      const marker = autoTriggerMarkerPath(data2, repo2)
      expect(readLastTriggerAt(marker)).toBe(42)
      expect(result.triggered).toBe(true)
    } finally {
      rmSync(repo2, { recursive: true, force: true })
      rmSync(data2, { recursive: true, force: true })
    }
  })
})
