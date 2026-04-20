/**
 * Foreign-ingest pipeline orchestration.
 *
 * Round-2 scope (matches the spec in `/tmp/compare-codemem.md`):
 *  1. For a given git root, scan one or more adapters → [`DiscoveredSession`].
 *  2. Filter by checkpoint: skip rows whose `(tool, sourcePath, contentHash)`
 *     is already present in `foreign_ingest_done`.
 *  3. For each surviving session, run the adapter's full parser →
 *     [`IngestedSession`].
 *  4. Pass the session through the supplied `extract` callback (round-3 will
 *     plug a phase-1 LLM extractor here; round-2 callers can pass a stub
 *     that returns zero or BYO sextuples). Each emitted sextuple is stored
 *     via `Memory.addWithoutEmbedding` (BYO/foreign sources skip the live
 *     embed roundtrip — embeddings are filled by a later background pass).
 *  5. On success, write a `foreign_ingest_done` row so the session is
 *     skipped on the next run.
 *
 * Concurrency is bounded by `Effect.forEach({ concurrency })`. The pipeline
 * acquires the per-git-root advisory writer lock — concurrent runs in the
 * same repo silently no-op (matches Rust `WriterGate.AlreadyHeld`).
 *
 * What is NOT in this round (deferred to round-3):
 *  - Phase-1 LLM extraction: the `extract` callback is the wiring point but
 *    no production caller is provided.
 *  - 4-signal refining scorer.
 *  - Skill extraction / promotion.
 *  - Foreign-ingest runtime (`runtime.rs`, 2463 LOC) — lifecycle, status RPC,
 *    auto-on-session-start scheduling.
 */

import { Effect } from "effect"
import { Memory } from "../index"
import { type DefectSextupleInput, type ForeignSource } from "../schema"
import {
  type DiscoveredSession,
  type IngestedSession,
  Claude,
  Codex,
  Cursor,
  Kiro,
  OpenCodeAdapter,
  fullText as sessionFullText,
} from "./adapters"
import { ForeignIngestCheckpoint } from "./checkpoint"
import { withWriterLock } from "./writer-lock"
import {
  buildPhase1Prompt,
  parsePhase1Response,
  buildSextupleInputs,
  PHASE1_TIMEOUT_MS,
  type Phase1Model,
} from "../phase1"
import { Option } from "effect"

// --------------------------------------------------------------------------
// Source resolution
// --------------------------------------------------------------------------

/**
 * Per-tool inputs telling the orchestrator where to scan. All fields are
 * optional — callers enable only the tools they want by populating that
 * tool's entry. Missing entries are skipped silently.
 */
export interface ForeignIngestSources {
  readonly claudeProjectsDir?: string
  readonly cursorDir?: string
  readonly codexDir?: string
  readonly kiroDbPath?: string
  /**
   * If true, scan THIS OpenCode instance's own DB and re-process historical
   * sessions through the foreign pipeline. Off by default to avoid the
   * self-loop on every run.
   */
  readonly opencodeSelf?: boolean
}

function discover(sources: ForeignIngestSources): DiscoveredSession[] {
  const out: DiscoveredSession[] = []
  if (sources.claudeProjectsDir) out.push(...Claude.scanProjectsDir(sources.claudeProjectsDir))
  if (sources.cursorDir) out.push(...Cursor.scanCursorDirs(sources.cursorDir))
  if (sources.codexDir) out.push(...Codex.scanSessionsDir(sources.codexDir))
  if (sources.kiroDbPath) out.push(...Kiro.scanKiroSessions(sources.kiroDbPath))
  if (sources.opencodeSelf) out.push(...OpenCodeAdapter.scanOpenCodeSessions())
  return out
}

function parseSessionFor(d: DiscoveredSession): IngestedSession | undefined {
  switch (d.tool) {
    case "claude_code":
    case "claude_ext":
      return Claude.parseSession(d.sourcePath)
    case "cursor":
      return Cursor.parseSession(d.sourcePath)
    case "codex":
      return Codex.parseRollout(d.sourcePath)
    case "kiro": {
      // Kiro paths are encoded as `sqlite:<dbPath>#<conversationKey>`
      const dbAndKey = d.sourcePath.replace(/^sqlite:/, "")
      const hashIdx = dbAndKey.lastIndexOf("#")
      const dbPath = hashIdx >= 0 ? dbAndKey.slice(0, hashIdx) : dbAndKey
      return Kiro.parseSession(dbPath, d.sourceID)
    }
    case "opencode":
      return OpenCodeAdapter.parseSession(d.sourceID)
  }
}

// --------------------------------------------------------------------------
// Pipeline contract
// --------------------------------------------------------------------------

/**
 * Caller-supplied transform from a parsed session to a list of sextuple
 * inputs. Round-2 leaves the implementation pluggable so tests can inject
 * deterministic fakes; round-3 will provide a real LLM-backed extractor.
 *
 * Returning an empty array is fine — the session will still be marked done
 * so it isn't reprocessed.
 */
export type SessionExtractor = (
  session: IngestedSession,
  source: ForeignSource,
) => Effect.Effect<ReadonlyArray<DefectSextupleInput>, never>

export interface IngestStats {
  /** Sessions discovered from disk after scan. */
  readonly discovered: number
  /** Sessions skipped because the checkpoint already had a matching row. */
  readonly skippedDone: number
  /** Sessions that failed to parse (returned undefined). */
  readonly parseFailed: number
  /** Sessions whose extractor produced at least one sextuple. */
  readonly produced: number
  /** Total sextuple inserts (across all sessions; excludes dedup hits). */
  readonly inserted: number
  /** Wall-clock duration in ms. */
  readonly durationMs: number
}

export interface IngestInput {
  /** Absolute path to the git root that owns this run. Used by writer-lock
   * + recorded into the checkpoint row. */
  readonly gitRoot: string
  /** OpenCode data directory; used to derive the writer-lockfile path. */
  readonly dataDir: string
  /** ProjectID stamped on stored sextuples. Optional but recommended so
   * retrieval can scope to a project. */
  readonly projectID?: string
  /** Per-tool source paths. */
  readonly sources: ForeignIngestSources
  /** Session-to-sextuples transform. */
  readonly extract: SessionExtractor
  /** Optional cwd allow-list — sessions whose `cwd` doesn't fall under
   * `gitRoot` (and isn't undefined) are skipped. Defaults to true so foreign
   * tools running outside the current repo don't pollute its memory. */
  readonly filterByGitRoot?: boolean
  /** Concurrency for per-session work; defaults to 4. */
  readonly concurrency?: number
}

// --------------------------------------------------------------------------
// Pipeline run
// --------------------------------------------------------------------------

/**
 * Run the foreign-ingest pipeline for `gitRoot`. If another OpenCode process
 * already holds the writer lock, this returns `undefined` immediately. On
 * success the [`IngestStats`] tally summarises what was processed.
 */
export const ingest = (input: IngestInput) => {
  const concurrency = input.concurrency ?? 4
  const filterByRoot = input.filterByGitRoot ?? true

  const task = Effect.gen(function* () {
    const memory = yield* Memory
    const checkpoint = yield* ForeignIngestCheckpoint
    const start = Date.now()

    const discovered = discover(input.sources)
    const stats = {
      discovered: discovered.length,
      skippedDone: 0,
      parseFailed: 0,
      produced: 0,
      inserted: 0,
      durationMs: 0,
    }

    // Pre-filter for cwd ⊆ gitRoot.
    const inScope = discovered.filter((d) => {
      if (!filterByRoot) return true
      if (!d.cwd) return true
      return d.cwd === input.gitRoot || d.cwd.startsWith(input.gitRoot + "/")
    })

    // Filter by checkpoint.
    const eligible: DiscoveredSession[] = []
    for (const d of inScope) {
      const done = yield* checkpoint.isDone({
        tool: d.tool,
        sourcePath: d.sourcePath,
        contentHash: d.contentHash,
      })
      if (done) {
        stats.skippedDone += 1
      } else {
        eligible.push(d)
      }
    }

    // Per-session pipeline.
    yield* Effect.forEach(
      eligible,
      (d) =>
        Effect.gen(function* () {
          const session = parseSessionFor(d)
          if (!session) {
            stats.parseFailed += 1
            return
          }
          const source: ForeignSource = {
            _tag: "foreign",
            tool: d.tool,
            sourceID: d.sourceID,
            projectID: input.projectID,
            timestamp: d.updatedAt > 0 ? d.updatedAt : undefined,
          } as ForeignSource

          const sextuples = yield* input.extract(session, source)
          let producedAny = false
          let persistFailed = false
          for (const sx of sextuples) {
            const result = yield* memory
              .addWithoutEmbedding({ ...sx, projectID: sx.projectID ?? input.projectID })
              .pipe(
                Effect.catch(() => {
                  persistFailed = true
                  return Effect.succeed(undefined)
                }),
              )
            if (result?.inserted) {
              stats.inserted += 1
              producedAny = true
            }
          }
          if (producedAny) stats.produced += 1

          if (persistFailed) return

          // Checkpoint only after successful persistence or an explicitly
          // empty extraction so transient storage failures remain retryable.
          yield* checkpoint
            .insertDone({
              tool: d.tool,
              sourcePath: d.sourcePath,
              contentHash: d.contentHash,
              gitRoot: input.gitRoot,
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
        }),
      { concurrency },
    )

    stats.durationMs = Date.now() - start
    return stats
  })

  return withWriterLock(input.dataDir, input.gitRoot, task)
}

// --------------------------------------------------------------------------
// Real LLM-backed SessionExtractor
// --------------------------------------------------------------------------

/**
 * Build a {@link SessionExtractor} that runs the Phase-1 extractor prompt
 * against a caller-supplied model bridge. Mirrors the behavior of the
 * no-op extractor semantics (returns `[]` on any failure — the session is
 * still checkpointed) while plugging a real LLM into the pipeline.
 *
 * Intended callers: the `/memory/ingest` RPC (see
 * `src/server/instance/memory.ts`) and batch CLI flows. Both resolve a
 * Phase-1 bridge from the user's configured extraction model and pass it
 * in here — the extractor itself is storage-agnostic.
 */
export const makeLlmSessionExtractor = (opts: {
  readonly model: Phase1Model
  readonly timeoutMs?: number
}): SessionExtractor => {
  return (session, source) =>
    Effect.gen(function* () {
      const text = sessionFullText(session)
      if (!text.trim()) return [] as ReadonlyArray<DefectSextupleInput>
      const prompt = buildPhase1Prompt(text)
      const raw = yield* opts
        .model(prompt)
        .pipe(
          Effect.timeoutOption(opts.timeoutMs ?? PHASE1_TIMEOUT_MS),
          Effect.catchCause(() => Effect.succeed(Option.none<string | null>())),
          Effect.map((o) => Option.match(o, { onNone: () => null, onSome: (v) => v ?? null })),
        )
      if (!raw) return [] as ReadonlyArray<DefectSextupleInput>
      const parsed = parsePhase1Response(raw)
      if (!parsed) return [] as ReadonlyArray<DefectSextupleInput>
      return buildSextupleInputs(
        parsed,
        source,
        source.projectID,
      ) as ReadonlyArray<DefectSextupleInput>
    })
}

// --------------------------------------------------------------------------
// Re-exports
// --------------------------------------------------------------------------

export { ForeignIngestCheckpoint } from "./checkpoint"
export { layer as foreignIngestCheckpointLayer } from "./checkpoint"
export {
  type DiscoveredSession,
  type IngestedSession,
  type IngestedTurn,
  type ForeignTool,
  fullText,
  lastUserMessage,
  computeContentHash,
} from "./adapters"
export { tryAcquireWriterLock, withWriterLock, lockPathFor } from "./writer-lock"
export type { CheckpointKey, CheckpointRow, CheckpointInsert } from "./checkpoint"
