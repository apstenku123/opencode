/**
 * Cosine-similarity retrieval over stored `DefectSextuple.embedding` vectors.
 *
 * Port of stage-1 ANN from `codex-rs/core/src/memories/retrieval.rs`. Round 1
 * is a full-scan cosine kernel — matches Rust's behavior up to its
 * `THREAD_SCAN_LIMIT=5000` guard. Good up to ~10k sextuples; if retrieval
 * latency becomes a problem at foreign-ingest scale, swap in `sqlite-vec`
 * behind this same facade.
 *
 * Explicitly out of scope for round 1:
 *  - Stage-2 LLM cross-encoder rerank.
 *  - LLM query synthesis (`query_synth.rs`).
 *  - Score-merge + `memories_retrieval_min_score` gate.
 * These land alongside the turn-hook injection in round 2.
 */

import { Context, Effect, Layer } from "effect"
import { MemoryStorage } from "./storage"
import type { DefectSextuple, MemoryStorageError } from "./schema"

// --------------------------------------------------------------------------
// Contract
// --------------------------------------------------------------------------

export interface ScoredSextuple {
  readonly record: DefectSextuple
  readonly score: number
}

export interface RetrieveInput {
  readonly queryEmbedding: Float32Array
  readonly projectID?: string
  readonly topK?: number
  /** Optional cosine-score floor; default 0 (accept everything). */
  readonly minScore?: number
}

export namespace MemoryRetrieval {
  export interface Interface {
    readonly retrieve: (input: RetrieveInput) => Effect.Effect<ScoredSextuple[], MemoryStorageError>
  }
}

export class MemoryRetrieval extends Context.Service<MemoryRetrieval, MemoryRetrieval.Interface>()(
  "@opencode/memory/MemoryRetrieval",
) {}

// --------------------------------------------------------------------------
// Pure cosine kernels (exported for tests / direct use)
// --------------------------------------------------------------------------

/**
 * Raw cosine similarity in [-1, 1]. Returns 0 if either vector is zero-length
 * or if dimensions mismatch (avoids NaN propagation into the score merge).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Score every record with a usable embedding against `queryEmbedding` and
 * return top-K by descending score. `minScore` acts as an early filter;
 * records with score strictly below are dropped.
 *
 * Stable tiebreak: higher score first, then lexicographic `hashId` — keeps
 * test expectations deterministic when two records happen to score equally.
 */
export function rankByCosine(
  queryEmbedding: Float32Array,
  records: ReadonlyArray<DefectSextuple>,
  topK: number,
  minScore = 0,
): ScoredSextuple[] {
  const scored: ScoredSextuple[] = []
  for (const record of records) {
    if (!record.embedding) continue
    const score = cosineSimilarity(queryEmbedding, record.embedding)
    if (score < minScore) continue
    scored.push({ record, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.record.hashId.localeCompare(b.record.hashId)
  })
  if (topK > 0 && scored.length > topK) scored.length = topK
  return scored
}

// --------------------------------------------------------------------------
// Layer
// --------------------------------------------------------------------------

export const layer: Layer.Layer<MemoryRetrieval, never, MemoryStorage> = Layer.effect(
  MemoryRetrieval,
  Effect.gen(function* () {
    const storage = yield* MemoryStorage
    return {
      retrieve: ({ queryEmbedding, projectID, topK = 5, minScore = 0 }: RetrieveInput) =>
        Effect.gen(function* () {
          const records = yield* storage.listEmbedded(projectID)
          return rankByCosine(queryEmbedding, records, topK, minScore)
        }),
    }
  }),
)
