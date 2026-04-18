/**
 * Retrieval over stored `DefectSextuple` records.
 *
 * Three ranking modes are supported by the service surface:
 *   - `"cosine"` — full-scan cosine over `embedding` vectors (round-1 default).
 *   - `"bm25"`   — lexical BM25 over `(problem ⊕ root_cause ⊕ solution ⊕ keywords)`
 *                  documents. Requires no embedding provider; falls through
 *                  cleanly on an empty corpus.
 *   - `"hybrid"` — min-max normalised BM25 + cosine blend with configurable
 *                  weights (defaults `0.4 * bm25 + 0.6 * embedding`). Mirrors
 *                  the blend defined in `src/skill/retrieval.ts` so both
 *                  subsystems produce comparable scores.
 *
 * Explicitly out of scope for this round:
 *   - Stage-2 LLM cross-encoder rerank (that's `./rerank.ts`).
 *   - LLM query synthesis (`./query-synth.ts`).
 *   - sqlite-vec ANN index. Full-scan is fine up to ~10k sextuples; the
 *     hybrid layer sits on top of the same full-scan list.
 */

import { Context, Effect, Layer } from "effect"
import { MemoryStorage } from "./storage"
import type { DefectSextuple, MemoryStorageError } from "./schema"
import { Bm25MemoryIndex, sextupleDocText, type Bm25Hit } from "./bm25-index"

// --------------------------------------------------------------------------
// Contract
// --------------------------------------------------------------------------

export interface ScoredSextuple {
  readonly record: DefectSextuple
  readonly score: number
  /** BM25 channel score (0 when not used). */
  readonly bm25Score?: number
  /** Cosine channel score (0 when not used). */
  readonly cosineScore?: number
}

export interface RetrieveInput {
  readonly queryEmbedding: Float32Array
  readonly projectID?: string
  readonly topK?: number
  /** Optional cosine-score floor; default 0 (accept everything). */
  readonly minScore?: number
}

export type RetrievalMode = "cosine" | "bm25" | "hybrid"

export const DEFAULT_BM25_WEIGHT = 0.4
export const DEFAULT_EMBEDDING_WEIGHT = 0.6

export interface HybridWeights {
  readonly bm25Weight?: number
  readonly embeddingWeight?: number
}

export namespace MemoryRetrieval {
  export interface Interface {
    readonly retrieve: (input: RetrieveInput) => Effect.Effect<ScoredSextuple[], MemoryStorageError>
    /**
     * Pure BM25 ranking. Accepts the free-text query; the caller does not
     * need an embedding vector for this path.
     */
    readonly retrieveBm25: (input: {
      readonly queryText: string
      readonly projectID?: string
      readonly topK?: number
    }) => Effect.Effect<ScoredSextuple[], MemoryStorageError>
    /**
     * Hybrid (BM25 + cosine) ranking. When `queryEmbedding` is absent the
     * result degrades to pure BM25; when the corpus has no embedded records
     * it degrades to pure BM25 as well. When both channels are dead (empty
     * corpus / zero-weight config) returns `[]`.
     */
    readonly retrieveHybrid: (input: {
      readonly queryText: string
      readonly queryEmbedding?: Float32Array
      readonly projectID?: string
      readonly topK?: number
      readonly minScore?: number
      readonly weights?: HybridWeights
    }) => Effect.Effect<ScoredSextuple[], MemoryStorageError>
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
    scored.push({ record, score, cosineScore: score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.record.hashId.localeCompare(b.record.hashId)
  })
  if (topK > 0 && scored.length > topK) scored.length = topK
  return scored
}

// --------------------------------------------------------------------------
// BM25 kernel
// --------------------------------------------------------------------------

/**
 * Rank records by BM25 over their sextuple document text. The index is built
 * in-place from the provided `records` — callers wanting to reuse an index
 * across queries should hold a `Bm25MemoryIndex` directly.
 */
export function rankByBm25(
  queryText: string,
  records: ReadonlyArray<DefectSextuple>,
  topK: number,
): ScoredSextuple[] {
  if (records.length === 0 || !queryText.trim()) return []
  const index = Bm25MemoryIndex.build(records)
  const hits = index.search(queryText, topK <= 0 ? records.length : topK)
  const byHash = new Map(records.map((r) => [r.hashId, r]))
  const out: ScoredSextuple[] = []
  for (const h of hits) {
    const record = byHash.get(h.hashId)
    if (!record) continue
    out.push({ record, score: h.score, bm25Score: h.score })
  }
  return out
}

// --------------------------------------------------------------------------
// Hybrid kernel (shared min-max + weighted blend — parity with src/skill/retrieval.ts)
// --------------------------------------------------------------------------

function resolveHybridWeights(w?: HybridWeights): { bm25: number; embed: number } {
  const bm25 = Math.max(0, w?.bm25Weight ?? DEFAULT_BM25_WEIGHT)
  const embed = Math.max(0, w?.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT)
  return { bm25, embed }
}

function minMaxNormalise(values: ReadonlyArray<number>): number[] {
  if (values.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  if (!Number.isFinite(range) || range <= 0) return values.map(() => 0)
  return values.map((v) => (v - min) / range)
}

/**
 * Pure blend of normalised channels. Branches on "only one channel has
 * signal" so a dead provider doesn't zero-out the other channel.
 */
export function blendHybridScores(
  bm25Norm: ReadonlyArray<number>,
  embedNorm: ReadonlyArray<number>,
  weights: { bm25: number; embed: number },
): number[] {
  const n = bm25Norm.length
  const out = new Array<number>(n)
  const bm25Signal = weights.bm25 > 0 && bm25Norm.some((v) => v > 0)
  const embedSignal = weights.embed > 0 && embedNorm.some((v) => v > 0)
  if (!bm25Signal && !embedSignal) {
    out.fill(0)
    return out
  }
  if (!embedSignal) {
    for (let i = 0; i < n; i++) out[i] = bm25Norm[i]!
    return out
  }
  if (!bm25Signal) {
    for (let i = 0; i < n; i++) out[i] = embedNorm[i]!
    return out
  }
  const total = weights.bm25 + weights.embed
  const wBm25 = total > 0 ? weights.bm25 / total : 0
  const wEmbed = total > 0 ? weights.embed / total : 0
  for (let i = 0; i < n; i++) {
    out[i] = wBm25 * bm25Norm[i]! + wEmbed * embedNorm[i]!
  }
  return out
}

/**
 * Hybrid ranker: min-max normalise the two score channels across the
 * candidate pool, then blend with `{bm25Weight, embeddingWeight}` weights.
 *
 * The candidate pool is the union of the BM25 hits and any records that
 * produced a cosine score. Ordering tiebreaks: blended score desc, then raw
 * BM25 score desc, then lexicographic `hashId` (stable across runs).
 */
export function rankByHybrid(
  records: ReadonlyArray<DefectSextuple>,
  bm25Hits: ReadonlyArray<Bm25Hit>,
  cosineScores: ReadonlyMap<string, number>,
  topK: number,
  minScore = 0,
  weights?: HybridWeights,
): ScoredSextuple[] {
  if (records.length === 0 || topK <= 0) return []
  const w = resolveHybridWeights(weights)

  const bm25ByHash = new Map(bm25Hits.map((h) => [h.hashId, h.score]))
  const candidateHashes = new Set<string>()
  for (const h of bm25Hits) candidateHashes.add(h.hashId)
  for (const hash of cosineScores.keys()) candidateHashes.add(hash)
  if (candidateHashes.size === 0) return []

  const byHash = new Map(records.map((r) => [r.hashId, r]))
  const candidates: DefectSextuple[] = []
  for (const hash of candidateHashes) {
    const r = byHash.get(hash)
    if (r) candidates.push(r)
  }
  if (candidates.length === 0) return []

  const bm25Raw = candidates.map((r) => bm25ByHash.get(r.hashId) ?? 0)
  const embedRaw = candidates.map((r) => cosineScores.get(r.hashId) ?? 0)

  const bm25Norm = minMaxNormalise(bm25Raw)
  const embedNorm = minMaxNormalise(embedRaw)
  const blended = blendHybridScores(bm25Norm, embedNorm, w)

  const scored: ScoredSextuple[] = candidates.map((record, i) => ({
    record,
    score: blended[i]!,
    bm25Score: bm25Raw[i]!,
    cosineScore: embedRaw[i]!,
  }))

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const aB = a.bm25Score ?? 0
    const bB = b.bm25Score ?? 0
    if (aB !== bB) return bB - aB
    return a.record.hashId.localeCompare(b.record.hashId)
  })

  const filtered = scored.filter((h) => h.score >= minScore)
  // Same "don't elide everything when no candidate scored > 0" guard as
  // skill/retrieval hybridRank: if the whole pool is zeros, keep them so the
  // caller can still see the candidate ordering.
  const anyPositive = filtered.some((h) => h.score > 0)
  const output = anyPositive ? filtered.filter((h) => h.score > 0) : filtered
  if (topK > 0 && output.length > topK) output.length = topK
  return output
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

      retrieveBm25: ({ queryText, projectID, topK = 5 }) =>
        Effect.gen(function* () {
          const records = yield* storage.listByProject(projectID)
          return rankByBm25(queryText, records, topK)
        }),

      retrieveHybrid: ({ queryText, queryEmbedding, projectID, topK = 5, minScore = 0, weights }) =>
        Effect.gen(function* () {
          const records = yield* storage.listByProject(projectID)
          if (records.length === 0) return []

          // BM25 channel — always runs; cheap and network-free.
          const bm25Index = Bm25MemoryIndex.build(records)
          const pool = Math.max(topK * 4, 10)
          const bm25Hits = queryText.trim() ? bm25Index.search(queryText, pool) : []

          // Cosine channel — runs only when we have a query vector AND some
          // records carry embeddings. We score every record with an
          // embedding so the hybrid pool covers the semantic-only path too.
          const cosineScores = new Map<string, number>()
          if (queryEmbedding && queryEmbedding.length > 0) {
            for (const record of records) {
              if (!record.embedding) continue
              cosineScores.set(record.hashId, cosineSimilarity(queryEmbedding, record.embedding))
            }
          }

          if (bm25Hits.length === 0 && cosineScores.size === 0) return []
          return rankByHybrid(records, bm25Hits, cosineScores, topK, minScore, weights)
        }),
    }
  }),
)

// Re-export the BM25 surface for convenience.
export { Bm25MemoryIndex, sextupleDocText }
export type { Bm25Hit }
