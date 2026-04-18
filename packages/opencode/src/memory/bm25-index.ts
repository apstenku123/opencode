/**
 * BM25 retrieval index over `DefectSextuple` records.
 *
 * Parity with `src/skill/bm25.ts`: same tokenizer, same BM25 hyper-parameters
 * (k1=1.5, b=0.75, Lucene-style idf), same stopword list. The difference is
 * purely the document model — each sextuple contributes a single document
 * formed from its human-readable fields plus its keywords:
 *
 *   doc = problem + " " + rootCause + " " + solution + " " + keywords.join(" ")
 *
 * The keyword field is doubled so keyword hits carry a modest lexical boost
 * (mirrors the "double-weight name vs body" trick the skill index uses for
 * skill names). Keywords are the retrieval anchor for MemCoder sextuples so
 * giving them extra TF weight improves recall on short queries.
 *
 * The index is pure-TS, holds no state across queries beyond the in-memory
 * inverted index, and is keyed by `hashId` — the stable identity for a
 * sextuple. Call-sites (facade in `./index.ts`) own caching and invalidation:
 * we just build indices on demand and hand them to the hybrid combiner.
 */

import type { DefectSextuple } from "./schema"

const K1 = 1.5
const B = 0.75
const TOKEN_MIN_LEN = 2

export interface Bm25Hit {
  /** Stable sextuple identity — the caller joins this back to full records. */
  readonly hashId: string
  readonly score: number
}

interface DocStats {
  readonly hashId: string
  readonly tf: Map<string, number>
  readonly length: number
}

export class Bm25MemoryIndex {
  private stats: DocStats[] = []
  /** term -> document frequency. */
  private df = new Map<string, number>()
  private avgdl = 0

  static build(records: ReadonlyArray<DefectSextuple>): Bm25MemoryIndex {
    const idx = new Bm25MemoryIndex()
    let totalLen = 0
    for (const record of records) {
      const tokens = tokenizeSextuple(record)
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      idx.stats.push({ hashId: record.hashId, tf, length: tokens.length })
      totalLen += tokens.length
      for (const term of tf.keys()) idx.df.set(term, (idx.df.get(term) ?? 0) + 1)
    }
    idx.avgdl = records.length === 0 ? 0 : totalLen / records.length
    return idx
  }

  size(): number {
    return this.stats.length
  }

  search(query: string, topK = 5): Bm25Hit[] {
    if (this.stats.length === 0) return []
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const N = this.stats.length
    const scored: Bm25Hit[] = this.stats.map((doc) => {
      let score = 0
      for (const term of queryTokens) {
        const tf = doc.tf.get(term)
        if (!tf) continue
        const df = this.df.get(term) ?? 0
        if (df === 0) continue
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const norm = 1 - B + B * (this.avgdl === 0 ? 0 : doc.length / this.avgdl)
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * norm)
        score += idf * tfNorm
      }
      return { hashId: doc.hashId, score }
    })

    return scored
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.hashId.localeCompare(b.hashId))
      .slice(0, topK)
  }
}

/** Light tokenizer shared with `src/skill/bm25.ts`. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < TOKEN_MIN_LEN) continue
    if (STOPWORDS.has(part)) continue
    out.push(part)
  }
  return out
}

/**
 * Tokenize the document form of a sextuple. Exposed for tests + so the hybrid
 * pipeline can embed the same text it indexed lexically.
 */
export function tokenizeSextuple(record: DefectSextuple): string[] {
  return tokenize(sextupleDocText(record))
}

/** Canonical "document text" used by both BM25 and the embedding channel. */
export function sextupleDocText(record: DefectSextuple): string {
  // Double the keywords — same rationale as skill index's doubled `name`.
  const kw = record.keywords.join(" ")
  return [record.problem, record.rootCause, record.solution, kw, kw].join(" ")
}

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "its",
  "of", "on", "or", "that", "the", "this", "to", "with",
])

export * as Bm25Memory from "./bm25-index"
