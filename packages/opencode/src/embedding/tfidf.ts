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
import { EmbeddingError, EmbeddingService } from "./index"

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
