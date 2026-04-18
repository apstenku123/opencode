/**
 * Local TF-IDF embedding fallback (no network, deterministic).
 *
 * Direct port of `core/src/skills/embedding.rs`'s `LocalTfIdf` provider:
 *
 *   1. Tokenise the input into lowercase alpha-numeric words.
 *   2. Count term frequencies.
 *   3. Apply a log-TF transform: `1 + ln(count)`.
 *   4. Hash each term to a bucket in `[0, vocab_size)` (djb2) and accumulate.
 *   5. L2-normalise the result so cosine similarity is meaningful.
 *
 * The Rust implementation lives at
 * `/Volumes/external/sources/codex_git/codex-rs/core/src/skills/embedding.rs`
 * around line 389 (`fn tfidf_embed`). This TS port keeps byte-for-byte
 * algorithm parity (same hash, same log-TF formula, same bucket modulus).
 */

import { Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { cosineSimilarity, EmbeddingError, EmbeddingService } from "./index"

/**
 * Default vocabulary size for the local fallback. Matches the Rust constant
 * `DEFAULT_EMBEDDING_DIM = 384` — a lightweight footprint that still
 * captures useful semantic signal.
 */
export const DEFAULT_TFIDF_VOCAB_SIZE = 384

/**
 * Compute a single TF-IDF-style embedding for `text`. Pure function; safe to
 * call from anywhere. Returns a zero vector for empty input.
 */
export function tfidfEmbed(text: string, vocabSize = DEFAULT_TFIDF_VOCAB_SIZE): Float32Array {
  const dim = vocabSize > 0 ? vocabSize : DEFAULT_TFIDF_VOCAB_SIZE

  // Tokenise: split on non-alphanumeric, drop empties.
  const tokens = text.split(/[^A-Za-z0-9]+/u).filter((t) => t.length > 0)
  if (tokens.length === 0) return new Float32Array(dim)

  // Count term frequencies (lowercased keys).
  const tf = new Map<string, number>()
  for (const tok of tokens) {
    const lower = tok.toLowerCase()
    tf.set(lower, (tf.get(lower) ?? 0) + 1)
  }

  // Hash each unique term into a bucket and accumulate the log-TF weight.
  const vec = new Float32Array(dim)
  for (const [term, count] of tf) {
    const bucket = simpleHash(term) % dim
    const logTf = 1 + Math.log(count)
    vec[bucket]! += logTf
  }

  // L2-normalise so cosine similarity reduces to dot product.
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm
  }
  return vec
}

/**
 * Simple non-cryptographic djb2 hash for TF-IDF bucket assignment. Matches
 * the Rust `simple_hash` in `embedding.rs` byte-for-byte (5381 seed, *33,
 * additive byte) so the two ports produce identical bucket assignments for
 * the same input.
 *
 * Uses `BigInt` to faithfully emulate Rust's `u64` `wrapping_mul(33)` /
 * `wrapping_add(b)` arithmetic; JS `number` would lose precision past 2^53.
 */
function simpleHash(s: string): number {
  let hash = 5381n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x80) {
      hash = (hash * 33n + BigInt(code)) & mask
    } else {
      // Encode the codepoint as UTF-8 bytes to match the Rust `s.bytes()`
      // iterator semantics for non-ASCII inputs (skill names with spaces
      // already exclude these, but tokenisation downstream may surface
      // them indirectly).
      const bytes = new TextEncoder().encode(s.charAt(i))
      for (const b of bytes) hash = (hash * 33n + BigInt(b)) & mask
    }
  }
  // Project into JS safe-integer range; only the bucket modulus matters.
  return Number(hash & 0x7fffffffffffn)
}

/**
 * Build an {@link EmbeddingService} layer backed by the local TF-IDF fallback.
 */
export function localTfIdfLayer(options?: { vocabSize?: number }): Layer.Layer<EmbeddingService> {
  return Layer.succeed(EmbeddingService, makeImpl(options))
}

/**
 * Lower-level factory used by the memory shim (and any caller that needs to
 * wrap the impl into its own service tag without re-implementing the math).
 */
export function makeImpl(options?: { vocabSize?: number }): EmbeddingService.Interface {
  const vocabSize = options?.vocabSize ?? DEFAULT_TFIDF_VOCAB_SIZE
  const _err = (msg: string): EmbeddingError => new EmbeddingError({ message: msg })
  void _err
  return {
    embed: (text) => Effect.sync(() => tfidfEmbed(text, vocabSize)),
    embedBatch: (texts) => Effect.sync(() => texts.map((t) => tfidfEmbed(t, vocabSize))),
    providerName: "tfidf",
  }
}

// --------------------------------------------------------------------------
// In-memory document corpus (Rust parity: `SkillEmbeddingStore` but JSON-backed)
// --------------------------------------------------------------------------

/**
 * On-disk serialisation format for a {@link LocalTfIdfCorpus}. Vectors are
 * stored as plain number arrays rather than `Float32Array` so the file is
 * portable JSON — callers can inspect it with any JSON tool.
 */
export interface LocalTfIdfCorpusFile {
  readonly version: 1
  readonly vocabSize: number
  readonly documents: ReadonlyArray<{ readonly id: string; readonly text: string; readonly vector: number[] }>
}

/**
 * Result of a corpus query. `score` is the cosine similarity between the
 * query vector and the stored document vector (both L2-normalised, so the
 * score is bounded in `[-1, 1]`).
 */
export interface LocalTfIdfQueryResult {
  readonly id: string
  readonly text: string
  readonly score: number
}

/**
 * Lightweight in-memory TF-IDF document corpus.
 *
 * Mirrors the `SkillEmbeddingStore` surface from
 * `codex-rs/core/src/skills/embedding.rs` but backs persistence with a JSON
 * file instead of SQLite — matches the TS port's "no native deps" posture
 * while keeping the same upsert/remove/query ergonomics.
 *
 * Thread-safety: single-owner. Callers that mutate from multiple fibers
 * should serialise access externally (the skill registry already does).
 */
export class LocalTfIdfCorpus {
  private readonly vocabSize: number
  private readonly docs = new Map<string, { text: string; vector: Float32Array }>()

  constructor(options?: { vocabSize?: number }) {
    this.vocabSize = options?.vocabSize ?? DEFAULT_TFIDF_VOCAB_SIZE
  }

  /** Number of documents currently in the corpus. */
  size(): number {
    return this.docs.size
  }

  /** Stable iterable of document IDs (insertion order, like `Map`). */
  ids(): string[] {
    return Array.from(this.docs.keys())
  }

  /** Insert or overwrite a document by `id`. Recomputes its TF-IDF vector. */
  upsert(id: string, text: string): void {
    const vector = tfidfEmbed(text, this.vocabSize)
    this.docs.set(id, { text, vector })
  }

  /** Remove a document. Returns `true` iff the id was present. */
  remove(id: string): boolean {
    return this.docs.delete(id)
  }

  /** Retrieve the stored text for a document, or `undefined` when absent. */
  getText(id: string): string | undefined {
    return this.docs.get(id)?.text
  }

  /** Retrieve the stored vector for a document, or `undefined` when absent. */
  getVector(id: string): Float32Array | undefined {
    const entry = this.docs.get(id)
    return entry ? entry.vector : undefined
  }

  /**
   * Rank the corpus by cosine similarity against `query`. Returns the top
   * `topK` documents sorted by descending score; documents with a zero or
   * negative score are included only when `topK` forces it (callers that
   * want strict positivity should filter the returned list themselves).
   */
  query(query: string, topK = 5): LocalTfIdfQueryResult[] {
    if (this.docs.size === 0 || topK <= 0) return []
    const qv = tfidfEmbed(query, this.vocabSize)
    // When the query has zero norm, every score is 0 — short-circuit.
    let qNorm = 0
    for (let i = 0; i < qv.length; i++) qNorm += qv[i]! * qv[i]!
    if (qNorm === 0) return []

    const scored: LocalTfIdfQueryResult[] = []
    for (const [id, entry] of this.docs) {
      const score = cosineSimilarity(qv, entry.vector)
      scored.push({ id, text: entry.text, score })
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return scored.slice(0, topK)
  }

  /** Serialise the corpus to a JSON-ready object. */
  toJSON(): LocalTfIdfCorpusFile {
    const documents: Array<{ id: string; text: string; vector: number[] }> = []
    for (const [id, entry] of this.docs) {
      documents.push({ id, text: entry.text, vector: Array.from(entry.vector) })
    }
    return { version: 1, vocabSize: this.vocabSize, documents }
  }

  /** Replace the corpus contents from a previously-serialised snapshot. */
  loadFromJSON(data: LocalTfIdfCorpusFile): void {
    if (data.version !== 1) {
      throw new Error(`LocalTfIdfCorpus: unsupported file version ${String((data as any).version)}`)
    }
    if (data.vocabSize !== this.vocabSize) {
      throw new Error(
        `LocalTfIdfCorpus: vocabSize mismatch (file=${data.vocabSize}, corpus=${this.vocabSize}) — re-index required`,
      )
    }
    this.docs.clear()
    for (const doc of data.documents) {
      this.docs.set(doc.id, { text: doc.text, vector: Float32Array.from(doc.vector) })
    }
  }

  /**
   * Write the corpus to `filePath` atomically (temp-file + rename). Creates
   * parent directories as needed. Safe to call from an Effect via
   * {@link LocalTfIdfCorpus.saveEffect}.
   */
  async save(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    const payload = JSON.stringify(this.toJSON())
    await fs.writeFile(tmp, payload, "utf8")
    await fs.rename(tmp, filePath)
  }

  /** Effect wrapper around {@link save}. */
  saveEffect(filePath: string): Effect.Effect<void, EmbeddingError> {
    return Effect.tryPromise({
      try: () => this.save(filePath),
      catch: (cause) =>
        new EmbeddingError({
          message: cause instanceof Error ? cause.message : `failed to save corpus to ${filePath}`,
          cause,
        }),
    })
  }

  /**
   * Load a corpus from `filePath`. Returns `null` when the file does not
   * exist (cold-start case — caller should start with an empty corpus);
   * other errors propagate.
   */
  static async load(filePath: string, options?: { vocabSize?: number }): Promise<LocalTfIdfCorpus | null> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null
      throw err
    }
    const data = JSON.parse(raw) as LocalTfIdfCorpusFile
    const corpus = new LocalTfIdfCorpus({ vocabSize: options?.vocabSize ?? data.vocabSize })
    corpus.loadFromJSON(data)
    return corpus
  }

  /** Effect wrapper around {@link LocalTfIdfCorpus.load}. */
  static loadEffect(
    filePath: string,
    options?: { vocabSize?: number },
  ): Effect.Effect<LocalTfIdfCorpus | null, EmbeddingError> {
    return Effect.tryPromise({
      try: () => LocalTfIdfCorpus.load(filePath, options),
      catch: (cause) =>
        new EmbeddingError({
          message: cause instanceof Error ? cause.message : `failed to load corpus from ${filePath}`,
          cause,
        }),
    })
  }
}
