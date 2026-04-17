import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"

import {
  BATCH_SIZE,
  PROMPT_TEMPLATE,
  appendCommitJsonl,
  buildPromptText,
  commitJsonlPath,
  commitMemoryDir,
  crawl,
  parseGitShowOutput,
  parsePolisherJson,
  passesSkipCriteria,
  processedShaPath,
  readProcessedShas,
  repoRootHash,
  writeProcessedShas,
} from "../../src/memory/commit-crawler"
import type { CommitRecord, PolisherSextuple } from "../../src/memory/commit-crawler"
import type { CommitSource } from "../../src/memory/schema"

// --------------------------------------------------------------------------
// parseGitShowOutput — pure parser tests
// --------------------------------------------------------------------------

describe("commit-crawler/parseGitShowOutput", () => {
  test("extracts metadata from sentinel-delimited git output", () => {
    const raw =
      "abc123def\n" +
      "alice@example.com\n" +
      "1700000000\n" +
      "fix(parser): handle empty input safely\n" +
      "The parser would panic on a zero-length token list.\n" +
      "This switches to a saturating subtraction.\n" +
      "=== END METADATA ===\n" +
      " src/parser.rs | 4 ++--\n" +
      " 1 file changed, 2 insertions(+), 2 deletions(-)\n" +
      "\n" +
      "diff --git a/src/parser.rs b/src/parser.rs\n" +
      "--- a/src/parser.rs\n" +
      "+++ b/src/parser.rs\n" +
      "@@ -10,4 +10,4 @@\n" +
      "-    let last = tokens.len() - 1;\n" +
      "+    let last = tokens.len().saturating_sub(1);\n"
    const rec = parseGitShowOutput(raw)!
    expect(rec.sha).toBe("abc123def")
    expect(rec.author).toBe("alice@example.com")
    expect(rec.timestamp).toBe(1_700_000_000)
    expect(rec.subject).toBe("fix(parser): handle empty input safely")
    expect(rec.body).toContain("zero-length token list")
    expect(rec.body).toContain("saturating subtraction")
    expect(rec.diffSummary).toContain("src/parser.rs")
    expect(rec.diffSummary).toContain("saturating_sub")
  })

  test("handles empty body and only stat block", () => {
    const raw =
      "deadbeef\n" +
      "bob@example.com\n" +
      "1234\n" +
      "chore: bump version\n" +
      "\n" +
      "=== END METADATA ===\n" +
      " Cargo.toml | 2 +-\n"
    const rec = parseGitShowOutput(raw)!
    expect(rec.sha).toBe("deadbeef")
    expect(rec.subject).toBe("chore: bump version")
    expect(rec.body.trim()).toBe("")
    expect(rec.diffSummary).toContain("Cargo.toml")
  })

  test("returns undefined when sha line is missing", () => {
    expect(parseGitShowOutput("")).toBeUndefined()
  })
})

// --------------------------------------------------------------------------
// parsePolisherJson + passesSkipCriteria
// --------------------------------------------------------------------------

describe("commit-crawler/parsePolisherJson", () => {
  test("parses raw JSON object", () => {
    const raw =
      '{"keywords":["a","b"],"problem":"x","root_cause":"y","solution":"z"}'
    const sx = parsePolisherJson(raw)!
    expect(sx.keywords).toEqual(["a", "b"])
    expect(sx.problem).toBe("x")
    expect(sx.rootCause).toBe("y")
    expect(sx.solution).toBe("z")
  })

  test("strips ```json fences", () => {
    const sx = parsePolisherJson(
      "```json\n" + '{"keywords":["x"],"problem":"y","root_cause":"","solution":""}\n```',
    )!
    expect(sx.keywords).toEqual(["x"])
  })

  test("falls back to first { ... last } block when wrapped in prose", () => {
    const raw =
      'Here is the JSON: {"keywords":["one"],"problem":"a","root_cause":"b","solution":"c"} (end)'
    const sx = parsePolisherJson(raw)!
    expect(sx.problem).toBe("a")
  })

  test("returns undefined for non-JSON text", () => {
    expect(parsePolisherJson("nothing here")).toBeUndefined()
  })

  test("filters non-string keywords entries", () => {
    const sx = parsePolisherJson('{"keywords":["ok",1,null,"also"],"problem":"","root_cause":"","solution":""}')!
    expect(sx.keywords).toEqual(["ok", "also"])
  })
})

describe("commit-crawler/passesSkipCriteria", () => {
  const valid: PolisherSextuple = {
    keywords: ["parser", "panic", "empty-input"],
    problem: "the parser panicked when handed an empty token list",
    rootCause: "tokens.len() - 1 underflowed",
    solution: "use saturating_sub on tokens.len()",
  }
  test("rejects fully-empty sextuple", () => {
    expect(passesSkipCriteria({ keywords: [], problem: "", rootCause: "", solution: "" })).toBe(false)
  })
  test("rejects single-keyword sextuple", () => {
    expect(passesSkipCriteria({ ...valid, keywords: ["onlyone"] })).toBe(false)
  })
  test("rejects short problem (< 20 chars)", () => {
    expect(passesSkipCriteria({ ...valid, problem: "too short" })).toBe(false)
  })
  test("accepts well-formed sextuple", () => {
    expect(passesSkipCriteria(valid)).toBe(true)
  })
})

// --------------------------------------------------------------------------
// repoRootHash + processed-SHA file IO
// --------------------------------------------------------------------------

describe("commit-crawler/repoRootHash", () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "occ-cc-"))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("hash is deterministic for same path", () => {
    const a = repoRootHash(tmp)
    const b = repoRootHash(tmp)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test("hash differs across paths", () => {
    const other = mkdtempSync(path.join(tmpdir(), "occ-cc2-"))
    expect(repoRootHash(other)).not.toBe(repoRootHash(tmp))
    rmSync(other, { recursive: true, force: true })
  })
})

describe("commit-crawler/processed-SHA cache", () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "occ-cc-"))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("read returns empty set for missing file", () => {
    expect(readProcessedShas(path.join(tmp, "nonexistent")).size).toBe(0)
  })

  test("write then read round-trips", () => {
    const file = path.join(tmp, "processed.txt")
    writeProcessedShas(file, ["sha-c", "sha-a", "sha-b"])
    // File should be sorted on disk for determinism.
    const raw = readFileSync(file, "utf8")
    expect(raw).toBe("sha-a\nsha-b\nsha-c\n")
    const back = readProcessedShas(file)
    expect([...back].sort()).toEqual(["sha-a", "sha-b", "sha-c"])
  })

  test("commitMemoryDir + processedShaPath + commitJsonlPath are derived from dataDir + repoHash", () => {
    const hash = repoRootHash("/repo/x")
    expect(commitMemoryDir("/data")).toBe(path.join("/data", "memory", "commit_memory"))
    expect(processedShaPath("/data", hash)).toBe(path.join("/data", "memory", "commit_memory", `${hash}_processed.txt`))
    expect(commitJsonlPath("/data", hash)).toBe(path.join("/data", "memory", "commit_memory", `${hash}.jsonl`))
  })
})

// --------------------------------------------------------------------------
// buildPromptText + appendCommitJsonl
// --------------------------------------------------------------------------

describe("commit-crawler/buildPromptText", () => {
  test("substitutes commit fields and reports DIFF_MAX_CHARS", () => {
    const rec: CommitRecord = {
      sha: "abc",
      author: "x",
      timestamp: 0,
      subject: "fix: bug",
      body: "details here",
      diffSummary: "diff body",
    }
    const prompt = buildPromptText(rec)
    expect(prompt).toContain("fix: bug")
    expect(prompt).toContain("details here")
    expect(prompt).toContain("diff body")
    // Template character bounds are also reported.
    expect(prompt).toContain("4000")
  })

  test("uses '(no commit message)' when subject and body are empty", () => {
    const rec: CommitRecord = { sha: "x", author: "", timestamp: 0, subject: "", body: "", diffSummary: "" }
    expect(buildPromptText(rec)).toContain("(no commit message)")
  })

  test("template carries the keyword extraction guidance verbatim", () => {
    expect(PROMPT_TEMPLATE).toContain("defect archaeologist")
    expect(PROMPT_TEMPLATE).toContain("3-8 lowercase tokens")
  })
})

describe("commit-crawler/appendCommitJsonl", () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "occ-cc-jsonl-"))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("writes newline-delimited JSON with snake_case source", () => {
    const file = path.join(tmp, "out.jsonl")
    const source: CommitSource = {
      _tag: "commit",
      repo: "repo",
      sha: "deadbeef",
      timestamp: 1234,
    } as CommitSource
    appendCommitJsonl(
      file,
      {
        id: "x",
        hashId: "h",
        keywords: ["a"],
        problem: "p",
        rootCause: "rc",
        solution: "s",
        source,
        timeCreated: 1,
        timeUpdated: 1,
      } as any,
      source,
    )
    appendCommitJsonl(
      file,
      {
        id: "y",
        hashId: "h2",
        keywords: ["b"],
        problem: "p2",
        rootCause: "rc2",
        solution: "s2",
        source,
        timeCreated: 2,
        timeUpdated: 2,
      } as any,
      source,
    )
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!)
    expect(first.problem).toBe("p")
    expect(first.root_cause).toBe("rc")
    expect(first.source.type).toBe("commit")
    expect(first.source.sha).toBe("deadbeef")
  })
})

// --------------------------------------------------------------------------
// crawl orchestration — uses real spawn() for git, requires git presence.
// --------------------------------------------------------------------------

describe("commit-crawler/crawl", () => {
  let tmpData: string
  let tmpRepo: string

  beforeAll(async () => {
    tmpData = mkdtempSync(path.join(tmpdir(), "occ-cc-data-"))
    tmpRepo = mkdtempSync(path.join(tmpdir(), "occ-cc-repo-"))
    const { execSync } = await import("node:child_process")
    execSync("git init -q", { cwd: tmpRepo })
    execSync("git config user.email t@t.com && git config user.name t", { cwd: tmpRepo })
    writeFileSync(path.join(tmpRepo, "a.txt"), "hello\n")
    execSync("git add . && git commit -q -m 'fix: bug in handler that crashed on empty input'", {
      cwd: tmpRepo,
      env: { ...process.env, GIT_COMMITTER_DATE: "1700000000 +0000", GIT_AUTHOR_DATE: "1700000000 +0000" },
    })
  })

  afterAll(() => {
    rmSync(tmpData, { recursive: true, force: true })
    rmSync(tmpRepo, { recursive: true, force: true })
  })

  test("walks one commit with stub polisher and writes JSONL + processed-SHA cache", async () => {
    const stats = await Effect.runPromise(
      crawl({
        repoRoot: tmpRepo,
        dataDir: tmpData,
        limit: 5,
        polish: () =>
          Effect.succeed({
            keywords: ["bug", "handler", "empty-input"],
            problem: "handler crashed when receiving an empty input payload",
            rootCause: "missing length guard before slicing",
            solution: "added an explicit length check before slicing the buffer",
          }),
      }),
    )
    expect(stats.commitsWalked).toBe(1)
    expect(stats.sextuplesEmitted).toBe(1)

    const repoHash = repoRootHash(tmpRepo)
    const jsonlPath = commitJsonlPath(tmpData, repoHash)
    const processed = readProcessedShas(processedShaPath(tmpData, repoHash))
    expect(processed.size).toBe(1)
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const obj = JSON.parse(lines[0]!)
    expect(obj.problem).toContain("crashed")
    expect(obj.source.type).toBe("commit")

    // Second run should be a no-op — processed cache already covers the SHA.
    const stats2 = await Effect.runPromise(
      crawl({
        repoRoot: tmpRepo,
        dataDir: tmpData,
        limit: 5,
        polish: () => Effect.succeed(undefined),
      }),
    )
    expect(stats2.sextuplesEmitted).toBe(0)
  })

  test("limit=0 returns empty stats without spawning git", async () => {
    const stats = await Effect.runPromise(
      crawl({
        repoRoot: tmpRepo,
        dataDir: mkdtempSync(path.join(tmpdir(), "occ-cc-data2-")),
        limit: 0,
        polish: () => Effect.succeed(undefined),
      }),
    )
    expect(stats.commitsWalked).toBe(0)
    expect(stats.sextuplesEmitted).toBe(0)
  })

  test("BATCH_SIZE constant is exported and matches Rust default", () => {
    expect(BATCH_SIZE).toBe(10)
  })
})
