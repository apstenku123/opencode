/**
 * BM25 retrieval index for skills.
 *
 * Pure-TS port of the BM25 path used by Rust's `library.rs::SkillLibrary`. We
 * tokenize each skill's `name`, `description`, and `content` (plus any
 * frontmatter `triggers` if present), build an inverted index, and rank by
 * BM25 with k1=1.5, b=0.75 (standard Lucene defaults).
 *
 * The index is rebuilt lazily on first query and on the `Skill.Event.HotInserted`
 * bus event so freshly-extracted skills appear in subsequent searches without
 * a process restart. There is no on-disk persistence — the index is cheap to
 * rebuild from the in-memory `Skill.Service.all()` list.
 *
 * Falls back gracefully: a query whose tokens are entirely absent from the
 * corpus returns the empty list, allowing the caller (`session/system.ts`) to
 * substitute the legacy substring `recommend()` scorer for cold-start.
 */

import type { Info as SkillInfo } from "./index"

const K1 = 1.5
const B = 0.75
const TOKEN_MIN_LEN = 2

export interface Bm25Hit {
  skillName: string
  score: number
}

interface DocStats {
  /** Index into `docs[]`. */
  docId: number
  /** Term frequency table for this doc. */
  tf: Map<string, number>
  /** Number of tokens in this doc (used for length-norm). */
  length: number
}

export class Bm25Index {
  private docs: SkillInfo[] = []
  private stats: DocStats[] = []
  /** term -> document frequency. */
  private df = new Map<string, number>()
  /** Average document length. */
  private avgdl = 0

  static build(skills: SkillInfo[]): Bm25Index {
    const idx = new Bm25Index()
    idx.docs = skills.slice()
    let totalLen = 0
    skills.forEach((skill, i) => {
      const tokens = tokenize([
        skill.name,
        skill.name, // double-weight name vs body (see Rust router boost)
        skill.description,
        triggersFromContent(skill.content),
        skill.content,
      ].join(" "))
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      idx.stats.push({ docId: i, tf, length: tokens.length })
      totalLen += tokens.length
      for (const term of tf.keys()) idx.df.set(term, (idx.df.get(term) ?? 0) + 1)
    })
    idx.avgdl = skills.length === 0 ? 0 : totalLen / skills.length
    return idx
  }

  size(): number {
    return this.docs.length
  }

  search(query: string, topK = 5): Bm25Hit[] {
    if (this.docs.length === 0) return []
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const N = this.docs.length
    // Score each document.
    const scored = this.stats.map((doc): Bm25Hit => {
      let score = 0
      for (const term of queryTokens) {
        const tf = doc.tf.get(term)
        if (!tf) continue
        const df = this.df.get(term) ?? 0
        if (df === 0) continue
        // Lucene-style idf: log(1 + (N - df + 0.5) / (df + 0.5))
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const norm = 1 - B + B * (this.avgdl === 0 ? 0 : doc.length / this.avgdl)
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * norm)
        score += idf * tfNorm
      }
      return { skillName: this.docs[doc.docId].name, score }
    })

    return scored
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.skillName.localeCompare(b.skillName))
      .slice(0, topK)
  }
}

/**
 * Light tokenizer: lowercases, splits on non-alphanumerics, drops short tokens,
 * filters trivial English stopwords (matches the spirit of Rust's tantivy
 * default analyzer + a tiny stopword list).
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < TOKEN_MIN_LEN) continue
    if (STOPWORDS.has(part)) continue
    out.push(part)
  }
  return out
}

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "its",
  "of", "on", "or", "that", "the", "this", "to", "with",
])

/**
 * Pull a `triggers:` YAML frontmatter list out of a skill's body, if present.
 * Skills authored via the Rust extractor sometimes carry `triggers:`; we mine
 * those to bias retrieval toward skills that explicitly opt-in to a phrase.
 */
function triggersFromContent(content: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return ""
  const fm = match[1]
  const triggersMatch = fm.match(/^triggers\s*:\s*\n((?:\s*-\s.*\n?)+)/m)
  if (!triggersMatch) return ""
  return triggersMatch[1]
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
}

export * as Bm25 from "./bm25"
