/**
 * MemCoder-style structured memory sextuple — round 1 MVP.
 *
 * Port of `codex-rs/core/src/memories/sextuple.rs`. The round-1 schema is a
 * deliberate simplification: `original_message` and `code_changes_summary`
 * from the Rust struct are omitted (they belong to the commit-crawler and
 * rollout-extraction pipelines that land in later rounds). What we do keep:
 *
 * - `keywords / problem / root_cause / solution` — MemCoder p/r/s triple plus
 *   retrieval keywords.
 * - `source` — discriminated union over the three producing pipelines (rollout
 *   session, git commit, foreign-ingest).
 * - `hashId` — sha256 over normalized (problem ⊕ root_cause ⊕ solution) for
 *   cross-source dedup. NB: the TS hash includes `solution` in addition to the
 *   `problem + 0x1f + root_cause` Rust digest; this aligns with the round-1
 *   spec in `docs/codex-rs-migration-plan.md` §3.4.
 * - `embeddingKey` — `keywords.join(" ") + " [PROBLEM] " + problem`, matching
 *   the paper's `Embed(k_i ⊕ p_i)` key.
 * - `embedding` — optional Float32Array, populated post-insert by the
 *   embedding client (kept optional so BYO-sextuple JSONL dumps can be
 *   imported without a live embedding endpoint).
 */

import { Schema } from "effect"
import { createHash } from "node:crypto"

// -- Source discriminator ---------------------------------------------------

export class RolloutSource extends Schema.TaggedClass<RolloutSource>()("rollout", {
  threadID: Schema.String,
  projectID: Schema.optional(Schema.String),
  timestamp: Schema.Number,
}) {}

export class CommitSource extends Schema.TaggedClass<CommitSource>()("commit", {
  repo: Schema.String,
  sha: Schema.String,
  timestamp: Schema.Number,
}) {}

export class ForeignSource extends Schema.TaggedClass<ForeignSource>()("foreign", {
  tool: Schema.String,
  sourceID: Schema.String,
  projectID: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
}) {}

export const SextupleSource = Schema.Union([RolloutSource, CommitSource, ForeignSource])
export type SextupleSource = Schema.Schema.Type<typeof SextupleSource>

// -- Core sextuple ----------------------------------------------------------

/**
 * Input shape accepted by `Memory.Service.store`. `hashId` is derived, not
 * provided; `embedding` is populated separately by `updateEmbedding`.
 */
export const DefectSextupleInput = Schema.Struct({
  keywords: Schema.Array(Schema.String),
  problem: Schema.String,
  rootCause: Schema.String,
  solution: Schema.String,
  source: SextupleSource,
  projectID: Schema.optional(Schema.String),
})
export type DefectSextupleInput = Schema.Schema.Type<typeof DefectSextupleInput>

/**
 * Persisted sextuple record. `hashId` is the content-derived unique key;
 * `embedding` may be absent for BYO records pending a later `updateEmbedding`
 * pass.
 */
export const DefectSextuple = Schema.Struct({
  id: Schema.String,
  hashId: Schema.String,
  keywords: Schema.Array(Schema.String),
  problem: Schema.String,
  rootCause: Schema.String,
  solution: Schema.String,
  source: SextupleSource,
  projectID: Schema.optional(Schema.String),
  embedding: Schema.optional(Schema.instanceOf(Float32Array)),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})
export type DefectSextuple = Schema.Schema.Type<typeof DefectSextuple>

// -- Errors -----------------------------------------------------------------

export class MemoryValidationError extends Schema.TaggedErrorClass<MemoryValidationError>()(
  "MemoryValidationError",
  {
    message: Schema.String,
  },
) {}

export class MemoryStorageError extends Schema.TaggedErrorClass<MemoryStorageError>()("MemoryStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class MemoryEmbeddingError extends Schema.TaggedErrorClass<MemoryEmbeddingError>()(
  "MemoryEmbeddingError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

// -- Pure helpers -----------------------------------------------------------

/**
 * Normalize a string for hashing: trim leading/trailing whitespace, collapse
 * any run of whitespace (including newlines) to a single space. This makes
 * dedup robust against formatting drift (e.g. LLM re-emitting the same
 * problem with different line breaks).
 */
export function normalizeForHash(input: string): string {
  return input.trim().replace(/\s+/g, " ")
}

/**
 * Validate an input sextuple. Rejects empty keywords/problem/solution —
 * matches Rust `DefectSextuple::new` semantics (minus `root_cause`, which
 * the Rust path also allows empty).
 */
export function validateInput(input: DefectSextupleInput): MemoryValidationError | undefined {
  const cleanedKeywords = input.keywords.map((k) => k.trim()).filter((k) => k.length > 0)
  if (cleanedKeywords.length === 0) {
    return new MemoryValidationError({ message: "keywords must contain at least one non-empty entry" })
  }
  if (input.problem.trim().length === 0) {
    return new MemoryValidationError({ message: "problem must be non-empty" })
  }
  if (input.solution.trim().length === 0) {
    return new MemoryValidationError({ message: "solution must be non-empty" })
  }
  return undefined
}

/**
 * Return a keyword-cleaned copy of the input (trims each, drops empties, and
 * deduplicates while preserving order).
 */
export function cleanKeywords(keywords: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of keywords) {
    const k = raw.trim()
    if (k.length === 0) continue
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/**
 * Embedding key per MemCoder paper: `keywords.join(" ") + " [PROBLEM] " + problem`.
 * Mirrors `DefectSextuple::embedding_key` in Rust.
 */
export function embeddingKey(input: { keywords: ReadonlyArray<string>; problem: string }): string {
  return `${input.keywords.join(" ")} [PROBLEM] ${input.problem}`
}

/**
 * SHA-256 hex digest of the content-normalized tuple
 * `(problem, root_cause, solution)`. The 0x1F (ASCII Unit Separator) byte is
 * used as a field delimiter so `"a\x1fb"` can't collide with `"ab"`.
 */
export function hashId(input: { problem: string; rootCause: string; solution: string }): string {
  const parts = [normalizeForHash(input.problem), normalizeForHash(input.rootCause), normalizeForHash(input.solution)]
  const hasher = createHash("sha256")
  hasher.update(parts[0])
  hasher.update(Uint8Array.of(0x1f))
  hasher.update(parts[1])
  hasher.update(Uint8Array.of(0x1f))
  hasher.update(parts[2])
  return hasher.digest("hex")
}

// -- Binary encode/decode for the `embedding` BLOB column -------------------

/**
 * Pack a Float32Array as a contiguous little-endian Uint8Array for storage in
 * the `memory_sextuple.embedding` BLOB column. Works across Bun / Node /
 * browser runtimes; does not assume host endianness.
 */
export function encodeEmbedding(embedding: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(embedding.length * 4)
  const view = new DataView(buf)
  for (let i = 0; i < embedding.length; i++) view.setFloat32(i * 4, embedding[i]!, true)
  return new Uint8Array(buf)
}

/**
 * Inverse of `encodeEmbedding`.
 */
export function decodeEmbedding(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new MemoryStorageError({
      message: `embedding blob length ${bytes.byteLength} is not a multiple of 4`,
    })
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}
