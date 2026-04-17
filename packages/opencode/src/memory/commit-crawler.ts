/**
 * MemCoder commit crawler.
 *
 * Walks recent commits in a workspace, asks an LLM "polisher" to extract a
 * `DefectSextuple` per commit, and appends the results to a per-repo JSONL
 * cache under `<dataDir>/memory/commit_memory/<repoHash>.jsonl`. Memory
 * retrieval (round-1) loads sextuples from this JSONL alongside the SQLite
 * `memory_sextuple` rows; round-3 will wire the on-startup auto-trigger.
 *
 * Algorithm:
 *   1. `git rev-list --max-count=N HEAD` → enumerate SHAs.
 *   2. Filter out SHAs we have already processed (per-repo on-disk cache).
 *   3. For each new commit, run `git show --stat --patch <sha>` and parse
 *      the sentinel-delimited output into a [`CommitRecord`].
 *   4. Build a single-shot user prompt from the embedded template.
 *   5. Call the supplied `polish` callback (round-3 will plug a real LLM
 *      client here; tests / Round-2 callers can pass a deterministic stub).
 *   6. Reject empty / trivial sextuples; persist surviving ones to JSONL +
 *      mark the SHA as processed.
 *
 * Process commits in batches of `BATCH_SIZE` with `BATCH_DELAY_MS` between
 * batches to avoid saturating any rate-limited API. Mirrors
 * `codex-rs/core/src/memories/commit_crawler.rs`.
 */

import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  type DefectSextuple,
  type SextupleSource,
  cleanKeywords,
  hashId as computeHashId,
  validateInput,
} from "./schema"

// --------------------------------------------------------------------------
// Constants — match the Rust commit_crawler defaults.
// --------------------------------------------------------------------------

/** Maximum diff bytes injected into the polisher prompt. Sized to leave room
 * for the system framing and the model output inside a 32k context window. */
export const DIFF_MAX_CHARS = 4000
/** Process commits in batches of this many before pausing. */
export const BATCH_SIZE = 10
/** Delay between batches in milliseconds. */
export const BATCH_DELAY_MS = 1_000
/** Per-call timeout for the polisher in milliseconds. */
export const POLISH_TIMEOUT_MS = 60_000

/** Embedded prompt template — verbatim copy of
 * `core/templates/memories/commit_crawler_prompt.md`. The Rust spec calls
 * for a separate `commit_polish.md` file; we inline it so the bundled
 * single-file build does not need an asset-resolver. Tests pin the literal
 * substring to flag accidental edits. */
export const PROMPT_TEMPLATE = `You are a defect archaeologist. Given a git commit (message + diff),
extract a structured memory sextuple suitable for retrieval by a code agent
working on the same repository in the future.

OUTPUT ONLY a JSON object with these fields (no markdown, no code fences, no
extra text before or after the JSON):

{
  "keywords":   ["semantic", "anchors", "3-8 words"],
  "problem":    "one-sentence symptom description (what was broken or what the user observed)",
  "root_cause": "what actually caused the bug in technical terms (file/function/api/condition)",
  "solution":   "what the fix did and why it works (mention the key code change)"
}

Guidelines for filling each field:

* keywords: 3-8 lowercase tokens that name the affected subsystem, the
  language/runtime, the API surface, the symptom keyword, and any unusual
  identifier. Prefer concrete identifiers over vague nouns. These will be
  used for embedding-based retrieval, so they should be the words a future
  agent would naturally type when hitting the same problem.
* problem: one sentence in the past tense describing the user-visible symptom
  (crash, wrong output, slow path, hang, ...). At least 20 characters.
* root_cause: one or two sentences naming the actual mechanical cause - the
  function, the data flow, the missing check, the wrong assumption. Use
  concrete identifiers from the diff when possible.
* solution: one or two sentences describing the change made and why it
  resolves the root cause. Reference the changed function or invariant.

If the commit is TRIVIAL (pure formatting, dependency bump, README/docs only,
generated files only, version bump, lint/whitespace, merge commit with no real
change, revert of a recent commit), return an empty sextuple instead and the
caller will skip it:

{"keywords": [], "problem": "", "root_cause": "", "solution": ""}

Do not invent details that are not supported by the commit message or the
diff. If the commit message is empty and the diff is opaque, return the empty
sextuple form rather than guessing.

COMMIT MESSAGE:
{{COMMIT_MESSAGE}}

DIFF (truncated to {{DIFF_MAX_CHARS}} characters):
{{DIFF}}
`

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface CommitRecord {
  readonly sha: string
  readonly author: string
  readonly timestamp: number
  readonly subject: string
  readonly body: string
  readonly diffSummary: string
}

export interface CrawlStats {
  readonly commitsWalked: number
  readonly sextuplesEmitted: number
  readonly skippedTrivial: number
  readonly errors: number
  readonly durationMs: number
}

export interface PolisherSextuple {
  readonly keywords: string[]
  readonly problem: string
  readonly rootCause: string
  readonly solution: string
}

/**
 * Caller-supplied transform from a commit prompt to a parsed
 * [`PolisherSextuple`]. Returning `undefined` means "could not polish this
 * commit" — the SHA is NOT marked processed so it'll be retried next run.
 * Returning an "empty" sextuple (no keywords, empty problem) marks the SHA
 * as trivially-skipped (processed but no JSONL row).
 */
export type CommitPolisher = (
  commit: CommitRecord,
  prompt: string,
) => Effect.Effect<PolisherSextuple | undefined, never>

// --------------------------------------------------------------------------
// On-disk paths
// --------------------------------------------------------------------------

/**
 * Stable per-repo directory hash (16 hex chars of `sha256(canonicalRepoPath)`).
 * Mirrors the Rust impl so JSONL files are interchangeable across the
 * Rust↔TS migration boundary.
 */
export function repoRootHash(repoRoot: string): string {
  let canonical: string
  try {
    canonical = path.resolve(repoRoot)
  } catch {
    canonical = repoRoot
  }
  const hasher = createHash("sha256")
  hasher.update(canonical)
  return hasher.digest("hex").slice(0, 16)
}

export function commitMemoryDir(dataDir: string): string {
  return path.join(dataDir, "memory", "commit_memory")
}

export function processedShaPath(dataDir: string, repoHash: string): string {
  return path.join(commitMemoryDir(dataDir), `${repoHash}_processed.txt`)
}

export function commitJsonlPath(dataDir: string, repoHash: string): string {
  return path.join(commitMemoryDir(dataDir), `${repoHash}.jsonl`)
}

export function readProcessedShas(filePath: string): Set<string> {
  if (!existsSync(filePath)) return new Set()
  try {
    const raw = readFileSync(filePath, "utf8")
    const out = new Set<string>()
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length > 0) out.add(trimmed)
    }
    return out
  } catch {
    return new Set()
  }
}

export function writeProcessedShas(filePath: string, shas: Iterable<string>) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const sorted = Array.from(shas).sort()
  writeFileSync(filePath, sorted.join("\n") + (sorted.length > 0 ? "\n" : ""))
}

// --------------------------------------------------------------------------
// Git plumbing
// --------------------------------------------------------------------------

/**
 * `git rev-list --max-count=<limit> HEAD` — returns the SHAs in commit
 * order (newest first). Empty array on git failure (caller logs / decides).
 */
export function listRecentShas(repoRoot: string, limit: number): string[] {
  if (limit <= 0) return []
  const result = spawnSync("git", ["-C", repoRoot, "rev-list", `--max-count=${limit}`, "HEAD"], {
    encoding: "utf8",
  })
  if (result.status !== 0) return []
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const GIT_SHOW_FORMAT = "tformat:%H%n%ae%n%at%n%s%n%b%n=== END METADATA ==="

/**
 * `git show --stat --patch <sha>` with our sentinel-delimited format. Parses
 * the result into a [`CommitRecord`]. Returns `undefined` on git failure.
 */
export function showCommit(repoRoot: string, sha: string): CommitRecord | undefined {
  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "show",
      `--format=${GIT_SHOW_FORMAT}`,
      "--stat",
      "--patch",
      "--no-color",
      sha,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
  if (result.status !== 0) return undefined
  return parseGitShowOutput(result.stdout)
}

/**
 * Parse the output of our `git show --format=…` invocation. Pure, exported
 * so tests can drive the parser without spawning git.
 */
export function parseGitShowOutput(raw: string): CommitRecord | undefined {
  const SENTINEL = "=== END METADATA ==="
  const idx = raw.indexOf(SENTINEL)
  let header: string
  let diff: string
  if (idx >= 0) {
    header = raw.slice(0, idx)
    diff = raw.slice(idx + SENTINEL.length).replace(/^\n/, "")
  } else {
    header = raw
    diff = ""
  }
  const lines = header.split("\n")
  if (lines.length === 0 || !lines[0]?.trim()) return undefined
  const sha = lines[0]!.trim()
  const author = (lines[1] ?? "").trim()
  const timestampStr = (lines[2] ?? "").trim()
  const subject = lines[3] ?? ""
  const bodyLines = lines.slice(4)
  // Trim trailing empties on the body block.
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.length === 0) bodyLines.pop()
  const body = bodyLines.join("\n").trimEnd()

  const timestamp = Number.parseInt(timestampStr, 10)
  return {
    sha,
    author,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    subject,
    body,
    diffSummary: diff.trim(),
  }
}

// --------------------------------------------------------------------------
// Prompt building + JSON parse
// --------------------------------------------------------------------------

/**
 * Substitute the commit fields into the polisher prompt template.
 */
export function buildPromptText(record: CommitRecord): string {
  let fullMessage = record.subject
  if (record.body.length > 0) {
    if (fullMessage.length > 0) fullMessage += "\n\n"
    fullMessage += record.body
  }
  if (fullMessage.length === 0) fullMessage = "(no commit message)"
  const diff = truncateChars(record.diffSummary, DIFF_MAX_CHARS)
  return PROMPT_TEMPLATE.replace("{{COMMIT_MESSAGE}}", fullMessage)
    .replace("{{DIFF_MAX_CHARS}}", String(DIFF_MAX_CHARS))
    .replace("{{DIFF}}", diff)
}

function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "\n...[diff truncated]..."
}

/**
 * Parse the polisher's JSON response. Tolerates surrounding whitespace,
 * optional ```` ```json ```` fences, and falls back to the largest balanced
 * `{...}` block when the body is wrapped in prose.
 */
export function parsePolisherJson(raw: string): PolisherSextuple | undefined {
  const trimmed = raw.trim()
  const tries: string[] = [trimmed]
  // Strip code fence.
  let stripped = trimmed
  if (stripped.startsWith("```json")) stripped = stripped.slice("```json".length)
  else if (stripped.startsWith("```")) stripped = stripped.slice("```".length)
  if (stripped.endsWith("```")) stripped = stripped.slice(0, stripped.length - "```".length)
  stripped = stripped.trim()
  if (stripped !== trimmed) tries.push(stripped)
  // Find the first { ... last }.
  const first = trimmed.indexOf("{")
  const last = trimmed.lastIndexOf("}")
  if (first >= 0 && last > first) tries.push(trimmed.slice(first, last + 1))

  for (const candidate of tries) {
    try {
      const obj = JSON.parse(candidate)
      if (obj && typeof obj === "object") {
        return {
          keywords: Array.isArray(obj.keywords) ? obj.keywords.filter((k: unknown) => typeof k === "string") : [],
          problem: typeof obj.problem === "string" ? obj.problem : "",
          rootCause: typeof obj.root_cause === "string" ? obj.root_cause : "",
          solution: typeof obj.solution === "string" ? obj.solution : "",
        }
      }
    } catch {
      // try next form
    }
  }
  return undefined
}

/**
 * True when the parsed sextuple is worth keeping. Mirrors the Rust
 * `passes_skip_criteria` rules: ≥2 keywords AND ≥20-char problem, with
 * empty solution allowed.
 */
export function passesSkipCriteria(p: PolisherSextuple): boolean {
  if (p.keywords.length === 0 && p.problem.trim().length === 0 && p.rootCause.trim().length === 0 && p.solution.trim().length === 0) {
    return false
  }
  if (p.keywords.length < 2) return false
  if (p.problem.trim().length < 20) return false
  return true
}

// --------------------------------------------------------------------------
// JSONL output
// --------------------------------------------------------------------------

/**
 * Append a single sextuple JSON line to the per-repo file. JSONL format
 * matches the Rust commit_crawler exactly (snake_case keys, `source.type`
 * discriminator) so files are interchangeable.
 */
export function appendCommitJsonl(filePath: string, record: DefectSextuple, source: SextupleSource) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const payload = {
    keywords: record.keywords,
    problem: record.problem,
    root_cause: record.rootCause,
    solution: record.solution,
    source: serializeSource(source),
    hash_id: record.hashId,
    time_created: record.timeCreated,
  }
  appendFileSync(filePath, JSON.stringify(payload) + "\n", "utf8")
}

function serializeSource(source: SextupleSource): Record<string, unknown> {
  switch (source._tag) {
    case "commit":
      return { type: "commit", repo: source.repo, sha: source.sha, timestamp: source.timestamp }
    case "rollout":
      return {
        type: "rollout",
        thread_id: source.threadID,
        project_id: source.projectID,
        timestamp: source.timestamp,
      }
    case "foreign":
      return {
        type: "foreign",
        tool: source.tool,
        source_id: source.sourceID,
        project_id: source.projectID,
        timestamp: source.timestamp,
      }
  }
}

// --------------------------------------------------------------------------
// Crawl entry point
// --------------------------------------------------------------------------

export interface CrawlInput {
  readonly repoRoot: string
  /** Where to put `memory/commit_memory/<hash>.jsonl`. Typically
   * `Global.Path.data` (or a per-test tempdir). */
  readonly dataDir: string
  /** Maximum SHAs to walk per call. */
  readonly limit: number
  /** Optional human-readable repo label stored on each sextuple's source. */
  readonly repoLabel?: string
  /** LLM polisher callback. */
  readonly polish: CommitPolisher
}

/**
 * Walk up to `limit` recent commits, polish each into a sextuple via the
 * supplied callback, persist surviving sextuples to the per-repo JSONL.
 *
 * The returned [`CrawlStats`] reports walk/emission/skip counts. Errors
 * during git or polisher calls are tallied but never thrown — partial
 * progress is preserved and the next run picks up where this one stopped.
 */
export const crawl = (input: CrawlInput) =>
  Effect.gen(function* () {
    const start = Date.now()
    const stats = {
      commitsWalked: 0,
      sextuplesEmitted: 0,
      skippedTrivial: 0,
      errors: 0,
      durationMs: 0,
    }
    if (input.limit <= 0) {
      stats.durationMs = Date.now() - start
      return stats as CrawlStats
    }

    const shas = listRecentShas(input.repoRoot, input.limit)
    stats.commitsWalked = shas.length
    if (shas.length === 0) {
      stats.durationMs = Date.now() - start
      return stats as CrawlStats
    }

    const repoHash = repoRootHash(input.repoRoot)
    const processedPath = processedShaPath(input.dataDir, repoHash)
    const jsonlPath = commitJsonlPath(input.dataDir, repoHash)
    mkdirSync(commitMemoryDir(input.dataDir), { recursive: true })

    const processed = readProcessedShas(processedPath)
    const newShas = shas.filter((s) => !processed.has(s))
    if (newShas.length === 0) {
      stats.durationMs = Date.now() - start
      return stats as CrawlStats
    }

    const repoLabel = input.repoLabel ?? input.repoRoot

    for (let batchIdx = 0; batchIdx < newShas.length; batchIdx += BATCH_SIZE) {
      if (batchIdx > 0) {
        yield* Effect.sleep(`${BATCH_DELAY_MS} millis`)
      }
      const batch = newShas.slice(batchIdx, batchIdx + BATCH_SIZE)
      for (const sha of batch) {
        const record = showCommit(input.repoRoot, sha)
        if (!record) {
          stats.errors += 1
          continue
        }
        const promptText = buildPromptText(record)
        const polished = yield* input
          .polish(record, promptText)
          .pipe(Effect.timeoutOption(`${POLISH_TIMEOUT_MS} millis`))

        if (polished._tag === "None") {
          stats.errors += 1
          continue
        }
        const sx = polished.value
        if (sx === undefined) {
          stats.errors += 1
          continue
        }
        if (!passesSkipCriteria(sx)) {
          stats.skippedTrivial += 1
          processed.add(sha)
          continue
        }

        const inputSx = {
          keywords: cleanKeywords(sx.keywords),
          problem: sx.problem,
          rootCause: sx.rootCause,
          solution: sx.solution,
          source: {
            _tag: "commit" as const,
            repo: repoLabel,
            sha: record.sha,
            timestamp: record.timestamp * 1000,
          },
        }
        const validation = validateInput(inputSx)
        if (validation) {
          stats.skippedTrivial += 1
          processed.add(sha)
          continue
        }

        const hash = computeHashId({
          problem: inputSx.problem,
          rootCause: inputSx.rootCause,
          solution: inputSx.solution,
        })
        const now = Date.now()
        const persisted = {
          id: `commit-${record.sha}`,
          hashId: hash,
          keywords: inputSx.keywords,
          problem: inputSx.problem,
          rootCause: inputSx.rootCause,
          solution: inputSx.solution,
          source: inputSx.source,
          projectID: undefined,
          timeCreated: now,
          timeUpdated: now,
        } as DefectSextuple
        try {
          appendCommitJsonl(jsonlPath, persisted, inputSx.source)
          stats.sextuplesEmitted += 1
          processed.add(sha)
        } catch {
          stats.errors += 1
        }
      }
      // Flush processed-SHA cache after each batch so a crash mid-walk
      // doesn't lose progress.
      try {
        writeProcessedShas(processedPath, processed)
      } catch {
        stats.errors += 1
      }
    }

    stats.durationMs = Date.now() - start
    return stats as CrawlStats
  })
