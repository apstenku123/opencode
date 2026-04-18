/**
 * Hybrid BM25 ↔ embedding retrieval for skills.
 *
 * Strategy: combine a lexical BM25 score (`./bm25.ts`) with a semantic cosine
 * score (the shared `EmbeddingService`) using a weighted sum. Default weights
 * match the Rust parity target in `codex-rs/core/src/skills/retrieval.rs`:
 *
 *     final = 0.4 * bm25_norm + 0.6 * cosine_norm
 *
 * Normalisation: both score channels are min-max rescaled to `[0, 1]` across
 * the *query result set* before the weighted sum so BM25 magnitudes (log-
 * scale, can exceed 10+) and cosine magnitudes (`[0, 1]`) are comparable.
 * Ties broken by skill name.
 *
 * Configuration: `skills.retrieval.{bm25Weight, embeddingWeight}` in the user
 * config override the defaults. Weights are clamped to `>= 0`; if both are
 * zero we fall back to a pure BM25 ranking.
 */

import { Effect } from "effect"
import { cosineSimilarity, EmbeddingService } from "@/embedding"
import { Bm25Index, type Bm25Hit } from "./bm25"
import type { Info as SkillInfo } from "./index"

/** Default weights for the BM25 ↔ embedding blend. */
export const DEFAULT_BM25_WEIGHT = 0.4
export const DEFAULT_EMBEDDING_WEIGHT = 0.6

export interface HybridWeights {
  readonly bm25Weight?: number
  readonly embeddingWeight?: number
}

export interface HybridHit {
  readonly skill: SkillInfo
  /** Final blended score (≥ 0). */
  readonly score: number
  /** Raw BM25 score (0 when the doc did not match any query token). */
  readonly bm25Score: number
  /** Raw cosine similarity (0 when no embedding channel was used). */
  readonly cosineScore: number
}

interface ResolvedWeights {
  readonly bm25: number
  readonly embed: number
}

function resolveWeights(w?: HybridWeights): ResolvedWeights {
  const bm25 = Math.max(0, w?.bm25Weight ?? DEFAULT_BM25_WEIGHT)
  const embed = Math.max(0, w?.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT)
  return { bm25, embed }
}

/**
 * Min-max normalise `values` into `[0, 1]`. When every value is identical
 * (or the list is empty) returns a zero-filled array so the channel
 * contributes nothing to the final blend.
 */
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
 * Blend two normalised channels. Branch on "only one channel has signal"
 * early so a dead embedding provider (all zeros) doesn't zero out BM25.
 */
function blend(
  bm25Norm: ReadonlyArray<number>,
  embedNorm: ReadonlyArray<number>,
  weights: ResolvedWeights,
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
 * Pure-function variant: blend BM25 hits with precomputed cosine scores.
 * Exported for unit tests so the rank-combination math can be exercised
 * without standing up the full Effect stack.
 */
export function hybridRank(
  skills: ReadonlyArray<SkillInfo>,
  bm25Hits: ReadonlyArray<Bm25Hit>,
  cosineScores: ReadonlyMap<string, number>,
  topK: number = 5,
  weights?: HybridWeights,
): HybridHit[] {
  if (skills.length === 0 || topK <= 0) return []
  const w = resolveWeights(weights)

  // Build per-skill score vectors aligned to the candidate pool. Candidate
  // pool = union of BM25 hits + any skills with a cosine score ≥ 0. When the
  // cosine map is empty, we fall back to the BM25 corpus as the pool.
  const bm25ByName = new Map(bm25Hits.map((h) => [h.skillName, h.score]))
  const candidateNames = new Set<string>()
  for (const h of bm25Hits) candidateNames.add(h.skillName)
  for (const name of cosineScores.keys()) candidateNames.add(name)
  // Include every skill only when both pools are empty, otherwise the top
  // list is dominated by arbitrary name-sort order.
  if (candidateNames.size === 0 && bm25Hits.length === 0 && cosineScores.size === 0) {
    return []
  }

  const byName = new Map(skills.map((s) => [s.name, s]))
  const candidates: SkillInfo[] = []
  for (const name of candidateNames) {
    const skill = byName.get(name)
    if (skill) candidates.push(skill)
  }
  if (candidates.length === 0) return []

  const bm25Raw = candidates.map((s) => bm25ByName.get(s.name) ?? 0)
  const embedRaw = candidates.map((s) => cosineScores.get(s.name) ?? 0)

  const bm25Norm = minMaxNormalise(bm25Raw)
  const embedNorm = minMaxNormalise(embedRaw)
  const blended = blend(bm25Norm, embedNorm, w)

  const scored: HybridHit[] = candidates.map((skill, i) => ({
    skill,
    score: blended[i]!,
    bm25Score: bm25Raw[i]!,
    cosineScore: embedRaw[i]!,
  }))

  scored.sort(
    (a, b) => b.score - a.score || b.bm25Score - a.bm25Score || a.skill.name.localeCompare(b.skill.name),
  )
  // Drop skills whose blended score is 0 only when at least one other
  // candidate scored > 0 — otherwise every result would be elided on
  // no-signal queries.
  const top = scored.slice(0, topK)
  const anyPositive = top.some((h) => h.score > 0)
  return anyPositive ? top.filter((h) => h.score > 0) : top
}

/**
 * Input to {@link hybridSearch}. The caller provides the BM25 index (already
 * built) and either an in-scope {@link EmbeddingService}, or an inline
 * `embedder` function — the inline path is convenient when the service isn't
 * in `AppLayer` (e.g. `skill_search` tool) and the caller wants to bind to a
 * locally-constructed provider.
 */
export interface HybridSearchInput {
  readonly index: Bm25Index
  readonly skills: ReadonlyArray<SkillInfo>
  readonly query: string
  readonly topK?: number
  /** How many BM25 candidates to embed for cosine scoring. Default `max(topK*3, 10)`. */
  readonly topKPool?: number
  readonly weights?: HybridWeights
  /**
   * Inline embedder. When omitted, the {@link EmbeddingService} is resolved
   * from Effect context. Supplying this skips the service lookup and runs
   * the cosine channel purely in-process.
   */
  readonly embedder?: {
    readonly embed: (text: string) => Promise<Float32Array | null>
    readonly embedBatch: (texts: ReadonlyArray<string>) => Promise<Float32Array[] | null>
  }
}

/**
 * Effect-level hybrid search.
 *
 * Requires {@link EmbeddingService} iff `embedder` is not supplied. The BM25
 * index is already assumed to be built (caller owns caching — typically
 * `Skill.Service` keeps it on its `State`). `topKPool` controls how many
 * BM25 candidates we *also* embed for the cosine channel; we intentionally
 * don't embed every skill on every query because the corpus may be large
 * and the embedding provider may hit the network.
 */
export function hybridSearch(
  input: HybridSearchInput,
): Effect.Effect<HybridHit[], never, HybridSearchInput["embedder"] extends undefined ? EmbeddingService : never>
export function hybridSearch(input: HybridSearchInput): Effect.Effect<HybridHit[], never, EmbeddingService | never> {
  const topK = input.topK ?? 5
  const pool = input.topKPool ?? Math.max(topK * 3, 10)
  return Effect.gen(function* () {
    // BM25 channel.
    const bm25Hits = input.index.search(input.query, pool)
    // If BM25 produced nothing, still try the embedding channel against the
    // full skill list — semantic matching is exactly the fallback BM25 can't
    // handle (e.g. synonyms, paraphrases).
    const candidateSkills: SkillInfo[] = (() => {
      if (bm25Hits.length > 0) {
        const byName = new Map(input.skills.map((s) => [s.name, s]))
        const out: SkillInfo[] = []
        for (const h of bm25Hits) {
          const s = byName.get(h.skillName)
          if (s) out.push(s)
        }
        return out
      }
      // Cold-start / no-lex-match: fall back to the full corpus, capped.
      return [...input.skills].slice(0, pool)
    })()

    // Embed query + candidates. Use the lib-relaxed type to avoid
    // `Float32Array<ArrayBuffer>` / `<ArrayBufferLike>` generic-arg drift
    // across Bun + Node lib versions.
    let qVec: Float32Array<ArrayBufferLike> = new Float32Array(0)
    let docVecs: Float32Array<ArrayBufferLike>[] = []
    if (candidateSkills.length > 0) {
      if (input.embedder) {
        const q = yield* Effect.tryPromise({
          try: () => input.embedder!.embed(input.query),
          catch: () => new Error("embed failed"),
        }).pipe(Effect.catch(() => Effect.succeed<Float32Array | null>(null)))
        if (q) qVec = q
        if (qVec.length > 0) {
          const batch = yield* Effect.tryPromise({
            try: () => input.embedder!.embedBatch(candidateSkills.map(docText)),
            catch: () => new Error("embedBatch failed"),
          }).pipe(Effect.catch(() => Effect.succeed<Float32Array[] | null>(null)))
          if (batch) docVecs = batch
        }
      } else {
        const svc = yield* EmbeddingService
        qVec = yield* svc.embed(input.query).pipe(Effect.catch(() => Effect.succeed(new Float32Array(0))))
        if (qVec.length > 0) {
          docVecs = yield* svc
            .embedBatch(candidateSkills.map(docText))
            .pipe(Effect.catch(() => Effect.succeed([] as Float32Array[])))
        }
      }
    }

    const cosineScores = new Map<string, number>()
    if (qVec.length > 0 && docVecs.length === candidateSkills.length) {
      candidateSkills.forEach((skill, i) => {
        const vec = docVecs[i]
        if (!vec) return
        cosineScores.set(skill.name, cosineSimilarity(qVec, vec))
      })
    }

    return hybridRank(input.skills, bm25Hits, cosineScores, topK, input.weights)
  }) as Effect.Effect<HybridHit[], never, EmbeddingService | never>
}

function docText(skill: SkillInfo): string {
  return `${skill.name}\n${skill.description}\n${skill.content}`
}

export * as Retrieval from "./retrieval"
