/**
 * Memento-style skill router — Reciprocal Rank Fusion + Boltzmann policy.
 *
 * Port of `codex-rs/core/src/skills/router.rs` (~1,591 LOC). The router
 * combines three signals to pick the skills most likely to help with a
 * query:
 *
 *   1. **BM25 sparse recall** (lexical keyword matching from `./bm25.ts`).
 *   2. **Dense embedding recall** (cosine similarity from `./retrieval.ts`
 *      or an externally supplied cosine table).
 *   3. **Evolution / utility weight** — per-skill historical success rate
 *      fed by `./evolution.ts`.
 *
 * # RRF formula (pure fallback)
 *
 *     rrf(d) = bm25_weight / (k + rank_bm25(d))
 *            + embedding_weight / (k + rank_embed(d))
 *
 * with `k = 60` from Cormack et al. 2009. A skill missing from one list
 * contributes 0.0 from that list; it is never *penalised*, only *not
 * boosted*.
 *
 * # Utility blending (pure fallback)
 *
 *     final = (1 - utility_weight) * fused + utility_weight * utility_rate
 *
 * # Boltzmann routing (Memento Eq. 4)
 *
 *     Q(q, d) = e(d) · u(q) + UTILITY_BONUS * utility_rate(d)
 *     π(d|q) = exp(Q(q,d) / τ) / Σ_{d'} exp(Q(q,d') / τ)
 *
 * The router picks the Boltzmann path when cosine similarities are
 * available (i.e. at least one skill has an embedding score). Otherwise it
 * falls back to the pure RRF + utility path so BM25-only deployments still
 * get utility-aware ranking.
 *
 * # Kinds
 *
 *     "bm25"      — pure BM25 (parity with {@link Skill.Service.search}).
 *     "rrf"       — BM25 + cosine fused via RRF + utility blend.
 *     "boltzmann" — Memento softmax over Q-values.
 *
 * The kind is selectable via `skills.router.kind` in user config. Default
 * `"bm25"` for strict parity (per R6 plan §5 R18). Tests cover all three.
 */

import { Bm25Index, type Bm25Hit } from "./bm25"
import type { Info as SkillInfo } from "./index"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF parameter `k`. Cormack et al. 2009 standard. */
export const RRF_K = 60

/** Default Boltzmann temperature τ. Small ⇒ near-deterministic exploit. */
export const DEFAULT_TEMPERATURE = 0.1

/** Additive bonus in the Q-value formula for one unit of utility rate. */
export const UTILITY_BONUS = 0.5

/** Default weights for the RRF fallback path. */
export const DEFAULT_BM25_WEIGHT = 0.4
export const DEFAULT_EMBEDDING_WEIGHT = 0.6

/** Default linear utility weight applied to the fused score. */
export const DEFAULT_UTILITY_WEIGHT = 0.3

/** Default threshold below which candidates are dropped. */
export const DEFAULT_MIN_SCORE_THRESHOLD = 0.1

/** Default cap on returned candidates. */
export const DEFAULT_MAX_CANDIDATES = 5

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Router dispatch kinds exposed to callers and config. */
export type RouterKind = "bm25" | "rrf" | "boltzmann"

/** Optional per-skill execution-mode filter. Mirrors Rust `SkillExecutionMode`. */
export type SkillExecutionMode = "knowledge" | "playbook"

/**
 * Configuration knobs for the router. All values clamp to safe defaults.
 */
export interface RouterConfig {
  /** RRF fusion weight for the BM25 list. Default 0.4. */
  readonly bm25Weight?: number
  /** RRF fusion weight for the embedding list. Default 0.6. */
  readonly embeddingWeight?: number
  /**
   * Linear blend weight for the utility rate. Default 0.3 →
   * `final = 0.7 * fused + 0.3 * utility_rate`.
   */
  readonly utilityWeight?: number
  /** Minimum final score retained in the result list. Default 0.1. */
  readonly minScoreThreshold?: number
  /** Cap on the result list length. Default 5. */
  readonly maxCandidates?: number
  /**
   * When set, only skills whose `execution_mode` frontmatter matches this
   * value are returned. Applied **after** ranking but **before** the cap,
   * so the caller still receives up to `maxCandidates` skills of the
   * requested mode (rather than first truncating the mixed list and then
   * discarding the wrong-mode skills).
   */
  readonly modeFilter?: SkillExecutionMode
  /** Boltzmann temperature τ ∈ (0, ∞). Default {@link DEFAULT_TEMPERATURE}. */
  readonly temperature?: number
}

/**
 * A scored skill candidate emitted by the router. All scores are in `[0, 1]`
 * (after min-max normalisation) except for the raw BM25 score which we
 * carry verbatim so callers can inspect which channel fired.
 */
export interface RoutedSkill {
  readonly skill: SkillInfo
  /** Raw BM25 score (0 when the skill did not match BM25). */
  readonly bm25Score: number
  /** Raw cosine similarity (0 when no embedding channel was used). */
  readonly embeddingScore: number
  /** RRF-combined score (0–1 after normalisation). */
  readonly fusedScore: number
  /** Historical success rate (0–1, clamped). */
  readonly utilityRate: number
  /** The score used for ranking: RRF+utility blend, or Boltzmann probability. */
  readonly finalScore: number
}

/** Routing inputs. Either `bm25Results` or `embeddingResults` may be empty. */
export interface RouteInput {
  readonly query: string
  /**
   * Pre-sorted `(skillName, rawScore)` pairs. The router consults rank,
   * not score, for the RRF computation.
   */
  readonly bm25Results: ReadonlyArray<readonly [string, number]>
  readonly embeddingResults: ReadonlyArray<readonly [string, number]>
  /** Library keyed by skill name → SkillInfo. */
  readonly skillLibrary: ReadonlyMap<string, SkillInfo>
  /**
   * Per-skill utility rate, 0–1. Missing entries default to 0.0. The router
   * does **not** clamp negative rates — callers are expected to feed
   * [0, 1] values.
   */
  readonly utilityTable: ReadonlyMap<string, number>
  /** Override the router kind on a per-call basis. */
  readonly kind?: RouterKind
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  readonly bm25Weight: number
  readonly embeddingWeight: number
  readonly utilityWeight: number
  readonly minScoreThreshold: number
  readonly maxCandidates: number
  readonly modeFilter?: SkillExecutionMode
  readonly temperature: number
}

function resolveConfig(cfg: RouterConfig = {}): ResolvedConfig {
  return {
    bm25Weight: Math.max(0, cfg.bm25Weight ?? DEFAULT_BM25_WEIGHT),
    embeddingWeight: Math.max(0, cfg.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT),
    utilityWeight: clamp01(cfg.utilityWeight ?? DEFAULT_UTILITY_WEIGHT),
    minScoreThreshold: Math.max(0, cfg.minScoreThreshold ?? DEFAULT_MIN_SCORE_THRESHOLD),
    maxCandidates: Math.max(1, cfg.maxCandidates ?? DEFAULT_MAX_CANDIDATES),
    modeFilter: cfg.modeFilter,
    temperature: Math.max(1e-12, cfg.temperature ?? DEFAULT_TEMPERATURE),
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** Extract the `execution_mode` frontmatter value. Returns `undefined` when absent. */
export function skillExecutionMode(skill: SkillInfo): SkillExecutionMode | undefined {
  const content = skill.content ?? ""
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return undefined
  const frontmatter = match[1] ?? ""
  const modeMatch = frontmatter.match(/^execution_mode\s*:\s*(\w+)/m)
  if (!modeMatch) return undefined
  const value = (modeMatch[1] ?? "").toLowerCase()
  if (value === "knowledge" || value === "playbook") return value
  return undefined
}

/**
 * Reciprocal Rank Fusion — merge two pre-sorted ranked lists by position.
 *
 * Missing documents contribute 0 from that channel. The caller controls
 * the per-channel weight via `resolved.bm25Weight` / `resolved.embeddingWeight`.
 *
 * Returns `(skillName, fusedScore)` pairs sorted by descending score.
 */
export function reciprocalRankFusion(
  bm25Ranked: ReadonlyArray<readonly [string, number]>,
  embeddingRanked: ReadonlyArray<readonly [string, number]>,
  resolved: Pick<ResolvedConfig, "bm25Weight" | "embeddingWeight">,
): Array<readonly [string, number]> {
  const scores = new Map<string, number>()
  for (let i = 0; i < bm25Ranked.length; i++) {
    const [name] = bm25Ranked[i]!
    const rank = i + 1
    scores.set(name, (scores.get(name) ?? 0) + resolved.bm25Weight / (RRF_K + rank))
  }
  for (let i = 0; i < embeddingRanked.length; i++) {
    const [name] = embeddingRanked[i]!
    const rank = i + 1
    scores.set(name, (scores.get(name) ?? 0) + resolved.embeddingWeight / (RRF_K + rank))
  }
  const out: Array<readonly [string, number]> = [...scores.entries()].map(
    ([name, score]) => [name, score] as const,
  )
  out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return out
}

/**
 * Apply the linear utility weighting to a list of fused scores. Returns
 * rows of `[skillName, finalScore, fusedScore, utilityRate]` so the caller
 * can populate {@link RoutedSkill} fields without re-looking-up utility.
 */
export function applyUtilityWeighting(
  fused: ReadonlyArray<readonly [string, number]>,
  utilityTable: ReadonlyMap<string, number>,
  utilityWeight: number,
): Array<readonly [string, number, number, number]> {
  const w = clamp01(utilityWeight)
  return fused.map(([name, fusedScore]) => {
    const utilityRate = clamp01(utilityTable.get(name) ?? 0)
    const finalScore = (1 - w) * fusedScore + w * utilityRate
    return [name, finalScore, fusedScore, utilityRate] as const
  })
}

/**
 * Dot product of two numeric slices. Shorter array determines loop bound;
 * trailing elements of the longer array are ignored. Mirrors Rust helper.
 */
export function dotProduct(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/**
 * Compute Boltzmann (softmax) routing probabilities over candidate skills.
 *
 *     Q(q, d) = dot(e(d), u(q)) + UTILITY_BONUS * utility_rate(d)
 *     π(d|q)  = exp(Q(q,d) / τ) / Σ_{d'} exp(Q(q,d') / τ)
 *
 * Numerically stable via max subtraction. Returns `(name, probability)`
 * pairs sorted by descending probability; probabilities sum to 1.0.
 */
export function boltzmannRoute(input: {
  readonly queryEmbedding: ReadonlyArray<number>
  readonly skillEmbeddings: ReadonlyArray<readonly [string, ReadonlyArray<number>]>
  readonly temperature?: number
  readonly utilityTable: ReadonlyMap<string, number>
}): Array<readonly [string, number]> {
  const pairs = input.skillEmbeddings
  if (pairs.length === 0) return []

  const tau = Math.max(1e-12, input.temperature ?? DEFAULT_TEMPERATURE)
  const qValues: Array<readonly [string, number]> = pairs.map(([name, emb]) => {
    const similarity = dotProduct(emb, input.queryEmbedding)
    const utilityRate = clamp01(input.utilityTable.get(name) ?? 0)
    const q = similarity + UTILITY_BONUS * utilityRate
    return [name, q] as const
  })

  let maxQ = Number.NEGATIVE_INFINITY
  for (const [, q] of qValues) if (q > maxQ) maxQ = q

  let sumExp = 0
  const exps = qValues.map(([, q]) => {
    const e = Math.exp((q - maxQ) / tau)
    sumExp += e
    return e
  })

  const out: Array<readonly [string, number]> = qValues.map(([name, _q], i) => {
    const p = sumExp > 0 ? (exps[i] ?? 0) / sumExp : 0
    return [name, p] as const
  })
  out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return out
}

/**
 * Sample a single skill from a precomputed Boltzmann distribution using
 * deterministic inverse-CDF. Seeded from the probability values themselves
 * so distinct distributions yield distinct samples without external RNG.
 *
 * Returns `undefined` when the distribution is empty.
 */
export function sampleSkill(probabilities: ReadonlyArray<readonly [string, number]>): string | undefined {
  if (probabilities.length === 0) return undefined
  // Derive a deterministic-but-varied seed from the top probabilities.
  // JavaScript lacks 64-bit ints; we use `Math.imul` + xor-shift for a
  // 32-bit mixer that produces a distinct stream for distinct distributions.
  let seed = 0x27220a95 | 0
  for (let i = 0; i < Math.min(3, probabilities.length); i++) {
    const [, p] = probabilities[i]!
    const buf = new ArrayBuffer(8)
    new Float64Array(buf)[0] = p
    const lo = new Uint32Array(buf)[0] ?? 0
    const hi = new Uint32Array(buf)[1] ?? 0
    seed = Math.imul(seed ^ lo ^ Math.imul(hi, 0x7f4a7c15), 0x9e3779b9) | 0
    seed = ((seed << ((i * 13 + 7) & 31)) | (seed >>> (32 - ((i * 13 + 7) & 31)))) | 0
  }
  // LCG step into [0, 1)
  const lcg = (Math.imul(seed, 0x6363b372) + 0x3f2a3c6b) >>> 0
  const r = lcg / 0x100000000

  let cumulative = 0
  for (const [name, p] of probabilities) {
    cumulative += p
    if (r <= cumulative) return name
  }
  return probabilities[probabilities.length - 1]?.[0]
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Merge BM25 + embedding results into a routed skill list using
 * Reciprocal Rank Fusion and a linear utility blend.
 *
 * When `skillLibrary` does not contain a referenced name the entry is
 * silently dropped (tests assert this). Sorting is stable: ties broken by
 * skill name.
 */
export function routeRrf(input: RouteInput, config: RouterConfig = {}): RoutedSkill[] {
  const resolved = resolveConfig(config)
  const fused = reciprocalRankFusion(input.bm25Results, input.embeddingResults, resolved)
  const weighted = applyUtilityWeighting(fused, input.utilityTable, resolved.utilityWeight)
  const bm25Map = new Map<string, number>()
  for (const [name, s] of input.bm25Results) bm25Map.set(name, s)
  const embedMap = new Map<string, number>()
  for (const [name, s] of input.embeddingResults) embedMap.set(name, s)
  let results: RoutedSkill[] = []
  for (const [name, finalScore, fusedScore, utilityRate] of weighted) {
    if (finalScore < resolved.minScoreThreshold) continue
    const skill = input.skillLibrary.get(name)
    if (!skill) continue
    results.push({
      skill,
      bm25Score: bm25Map.get(name) ?? 0,
      embeddingScore: embedMap.get(name) ?? 0,
      fusedScore,
      utilityRate,
      finalScore,
    })
  }
  results.sort((a, b) => b.finalScore - a.finalScore || a.skill.name.localeCompare(b.skill.name))
  if (resolved.modeFilter) results = results.filter((r) => skillExecutionMode(r.skill) === resolved.modeFilter)
  return results.slice(0, resolved.maxCandidates)
}

/**
 * Merge BM25 + embedding results using a Boltzmann distribution over the
 * embedding cosine scores. BM25-only skills are included with a zero
 * pseudo-embedding so they can still receive probability mass via the
 * utility bonus — mirrors Rust's pseudo-embedding fallback.
 *
 * When the embedding list is empty the method delegates to {@link routeRrf}.
 */
export function routeBoltzmann(input: RouteInput, config: RouterConfig = {}): RoutedSkill[] {
  if (input.embeddingResults.length === 0) return routeRrf(input, config)
  const resolved = resolveConfig(config)
  // Pseudo-embedding: each skill's cosine becomes a 1-D vector. Unit query.
  const embedNames = new Set<string>()
  const skillEmbeddings: Array<readonly [string, ReadonlyArray<number>]> = []
  for (const [name, sim] of input.embeddingResults) {
    embedNames.add(name)
    skillEmbeddings.push([name, [sim]] as const)
  }
  for (const [name] of input.bm25Results) {
    if (!embedNames.has(name)) skillEmbeddings.push([name, [0]] as const)
  }
  const probabilities = boltzmannRoute({
    queryEmbedding: [1],
    skillEmbeddings,
    temperature: resolved.temperature,
    utilityTable: input.utilityTable,
  })
  const bm25Map = new Map<string, number>()
  for (const [name, s] of input.bm25Results) bm25Map.set(name, s)
  const embedMap = new Map<string, number>()
  for (const [name, s] of input.embeddingResults) embedMap.set(name, s)
  let results: RoutedSkill[] = []
  for (const [name, probability] of probabilities) {
    if (probability < resolved.minScoreThreshold) continue
    const skill = input.skillLibrary.get(name)
    if (!skill) continue
    const utilityRate = clamp01(input.utilityTable.get(name) ?? 0)
    const embeddingScore = embedMap.get(name) ?? 0
    results.push({
      skill,
      bm25Score: bm25Map.get(name) ?? 0,
      embeddingScore,
      // Reuse embedding as fused for Boltzmann — downstream displays read
      // `finalScore` and treat `fusedScore` as a diagnostic.
      fusedScore: embeddingScore,
      utilityRate,
      finalScore: probability,
    })
  }
  // Already sorted by `boltzmannRoute`, but re-sort to keep ties stable
  // when we filter by mode below.
  results.sort((a, b) => b.finalScore - a.finalScore || a.skill.name.localeCompare(b.skill.name))
  if (resolved.modeFilter) results = results.filter((r) => skillExecutionMode(r.skill) === resolved.modeFilter)
  return results.slice(0, resolved.maxCandidates)
}

/**
 * Pure BM25 routing — parity with {@link Skill.Service.search} but in the
 * {@link RoutedSkill} shape. Utility and embedding fields are 0.
 *
 * Applied as the default `kind` to preserve existing recommend behavior
 * until Memento RRF is validated on real user corpora (per R6 R18).
 */
export function routeBm25(
  input: Pick<RouteInput, "bm25Results" | "skillLibrary">,
  config: RouterConfig = {},
): RoutedSkill[] {
  const resolved = resolveConfig(config)
  let results: RoutedSkill[] = []
  for (const [name, score] of input.bm25Results) {
    const skill = input.skillLibrary.get(name)
    if (!skill) continue
    results.push({
      skill,
      bm25Score: score,
      embeddingScore: 0,
      fusedScore: score,
      utilityRate: 0,
      finalScore: score,
    })
  }
  results.sort((a, b) => b.finalScore - a.finalScore || a.skill.name.localeCompare(b.skill.name))
  if (resolved.modeFilter) results = results.filter((r) => skillExecutionMode(r.skill) === resolved.modeFilter)
  return results.slice(0, resolved.maxCandidates)
}

/**
 * Dispatch to the configured router kind. Defaults to `"bm25"` for strict
 * parity with existing behavior; flip to `"rrf"` or `"boltzmann"` via
 * `skills.router.kind` once Memento routing is validated in your corpus.
 */
export function route(input: RouteInput, config: RouterConfig = {}): RoutedSkill[] {
  const kind: RouterKind = input.kind ?? "bm25"
  switch (kind) {
    case "bm25":
      return routeBm25(input, config)
    case "rrf":
      return routeRrf(input, config)
    case "boltzmann":
      return routeBoltzmann(input, config)
  }
}

// ---------------------------------------------------------------------------
// High-level helpers that drive the router from a skill corpus + embedder
// ---------------------------------------------------------------------------

export interface SkillRouterBuildInput {
  readonly skills: ReadonlyArray<SkillInfo>
  readonly query: string
  /** Pre-built BM25 index. When absent, built on the fly (cheap). */
  readonly bm25?: Bm25Index
  /**
   * Optional cosine scores keyed by skill name. Absent skills default to
   * zero. When this map is empty the RRF fallback path is used.
   */
  readonly cosineScores?: ReadonlyMap<string, number>
  readonly utilityTable?: ReadonlyMap<string, number>
  readonly kind?: RouterKind
  readonly config?: RouterConfig
}

/**
 * Build a complete routed-skill ranking from a skill corpus + optional
 * cosine scores. This is the glue `Skill.Service.search` calls when the
 * config selects a non-BM25 router kind.
 */
export function buildRoutedRanking(input: SkillRouterBuildInput): RoutedSkill[] {
  const bm25 = input.bm25 ?? Bm25Index.build([...input.skills])
  const poolSize = Math.max(input.config?.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 10)
  const bm25Hits: Bm25Hit[] = bm25.search(input.query, poolSize * 3)
  const bm25Results: Array<readonly [string, number]> = bm25Hits.map((h) => [h.skillName, h.score] as const)
  const embeddingResults: Array<readonly [string, number]> = []
  if (input.cosineScores) {
    for (const [name, score] of input.cosineScores) embeddingResults.push([name, score] as const)
    embeddingResults.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }
  const library = new Map<string, SkillInfo>()
  for (const skill of input.skills) library.set(skill.name, skill)
  return route(
    {
      query: input.query,
      bm25Results,
      embeddingResults,
      skillLibrary: library,
      utilityTable: input.utilityTable ?? new Map(),
      kind: input.kind,
    },
    input.config,
  )
}

export * as Router from "./router"
