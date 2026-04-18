/**
 * LLM-driven memory query synthesis (MemCoder paper §3.1).
 *
 * Port of `codex-rs/core/src/memories/query_synth.rs`. Given a user task
 * description (and an optional workspace-context blob), call an LLM to
 * distill a concise, keyword-rich search query suitable as an embedding
 * seed. The generated query is then handed to the embedding client and
 * used to drive cosine retrieval against stored `DefectSextuple.embedding`.
 *
 * Design constraints carried over from the Rust source:
 *
 *   - Pure helpers (`buildQueryPrompt`, `parseQueryResponse`,
 *     `truncateWithEllipsis`, `fallbackQuery`) live as plain TS functions
 *     so they can be unit-tested without a live model client.
 *   - The LLM call is delegated to a caller-provided `model` callback
 *     (mirrors the autobest Step A pattern in
 *     `packages/opencode/src/autobest/llm-extract.ts`). That keeps the
 *     query-synth module free of any provider/account resolver dep so
 *     tests can substitute a deterministic stub.
 *   - On any failure mode (timeout, stream error, invalid JSON, empty
 *     query) `synthesizeMemoryQuery` returns the deterministic
 *     `fallbackQuery(userPrompt)` slice. The callers (turn-hooks,
 *     embedding retrieval) treat memory-synth as best-effort and
 *     never block on it.
 *   - The prompt template is the verbatim copy of
 *     `core/templates/memories/query_synth.md` from codex-rs (kept inline
 *     since Bun's TS runtime has no built-in `*.md` module loader).
 */

import { Effect, Option } from "effect"

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Maximum bytes of `userPrompt` we forward into the synthesis prompt. */
export const USER_PROMPT_MAX_BYTES = 2 * 1024
/** Maximum bytes of optional workspace context we forward. */
export const CWD_CONTEXT_MAX_BYTES = 1024
/** Hard cap on the degraded fallback (raw user prompt slice). */
export const FALLBACK_MAX_BYTES = 200
/** Per-call deadline for the model invocation (ms). */
export const MODEL_TIMEOUT_MS = 30_000

/**
 * Verbatim copy of `core/templates/memories/query_synth.md`. Kept inline so
 * the bundled single-file build does not need an asset resolver. If the
 * upstream template changes, replace this block end-to-end.
 */
export const QUERY_SYNTH_TEMPLATE = `You are a memory query synthesis assistant. Your job is to take a
developer's task description and emit a concise, keyword-rich search
query optimized for retrieving similar past defect-resolution memories
from a vectorized knowledge base.

Rules:
1. Output ONLY a JSON object on a single line: {"query": "..."}
2. The query should be 3-15 words — long enough to capture the
   technical substance, short enough to be a good embedding seed.
3. Prefer domain vocabulary, error names, API surface areas, and
   symptoms over generic phrasing. Bad: "fix the bug". Good:
   "sqlx migration drift ignore_missing sqlite state db init".
4. If the task mentions specific file paths or function names,
   include them verbatim.
5. Strip conversational filler ("please", "can you", "I'd like"),
   politeness, and tense markers.
6. Preserve original language if the task is non-English.
7. If the task is too vague to distill a query, return
   {"query": ""} and the caller will skip retrieval.

## Task description

{user_prompt}

## Workspace context (optional)

{cwd_context_or_none}

## Output

Respond with ONLY the JSON object.`

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes on a char boundary,
 * appending a single "…" when truncation occurred. Mirrors
 * `query_synth::truncate_with_ellipsis`.
 */
export function truncateWithEllipsis(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  const bytes = enc.encode(s)
  if (bytes.length <= maxBytes) return s
  // Walk back to a UTF-8 char boundary at or before maxBytes.
  let cut = maxBytes
  // A continuation byte starts with bits 10xxxxxx (mask 0xC0 == 0x80).
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--
  const dec = new TextDecoder("utf-8", { fatal: false })
  return dec.decode(bytes.slice(0, cut)) + "…"
}

/**
 * Build the prompt text fed to the synthesis model. Pure function so
 * tests can exercise truncation and template substitution without
 * spinning up a model client.
 */
export function buildQueryPrompt(userPrompt: string, cwdContext?: string | null): string {
  const truncatedPrompt = truncateWithEllipsis(userPrompt, USER_PROMPT_MAX_BYTES)
  const cwdBlock =
    cwdContext != null && cwdContext.trim().length > 0
      ? truncateWithEllipsis(cwdContext, CWD_CONTEXT_MAX_BYTES)
      : "(none)"
  return QUERY_SYNTH_TEMPLATE.replace("{user_prompt}", truncatedPrompt).replace(
    "{cwd_context_or_none}",
    cwdBlock,
  )
}

/**
 * Errors that may arise from `parseQueryResponse`. Surfaced for tests; the
 * public entry point swallows them and falls back to `fallbackQuery`.
 */
export type QueryParseError =
  | { readonly kind: "invalid_json"; readonly raw: string }
  | { readonly kind: "missing_query_field" }

/**
 * Parse a model response into the synthesised query string. Tolerates
 * raw JSON, JSON wrapped in ``` / ```json fences, and surrounding
 * conversational chatter (locates the first balanced `{...}` block).
 *
 * Returns the trimmed `query` field (which may be empty — the caller
 * decides whether to fall back). Returns a typed error otherwise.
 */
export function parseQueryResponse(raw: string): string | QueryParseError {
  const trimmed = raw.trim()

  // 1. Direct JSON.
  const direct = tryParseObject(trimmed)
  if (direct !== undefined) return extractQueryField(direct)

  // 2. Strip leading ```json / ``` fence + matching trailing ```.
  let stripped = trimmed
  if (stripped.startsWith("```json")) stripped = stripped.slice(7)
  else if (stripped.startsWith("```")) stripped = stripped.slice(3)
  if (stripped.endsWith("```")) stripped = stripped.slice(0, -3)
  stripped = stripped.trim()
  if (stripped !== trimmed) {
    const fenced = tryParseObject(stripped)
    if (fenced !== undefined) return extractQueryField(fenced)
  }

  // 3. Locate `{"query"…}` substring anywhere in the text (balanced braces).
  const start = trimmed.indexOf('{"query"')
  if (start !== -1) {
    const sliced = locateBalancedObject(trimmed.slice(start))
    if (sliced !== undefined) {
      const v = tryParseObject(sliced)
      if (v !== undefined) return extractQueryField(v)
    }
  }

  return { kind: "invalid_json", raw: trimmed }
}

function tryParseObject(s: string): unknown | undefined {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function extractQueryField(value: unknown): string | QueryParseError {
  if (!value || typeof value !== "object") return { kind: "missing_query_field" }
  const q = (value as Record<string, unknown>)["query"]
  if (typeof q !== "string") return { kind: "missing_query_field" }
  return q.trim()
}

/**
 * Locate the first balanced `{...}` substring (string-literal aware so
 * braces inside quoted strings don't break depth tracking).
 */
export function locateBalancedObject(s: string): string | undefined {
  let depth = 0
  let inString = false
  let escape = false
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && start !== -1) return s.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Build the degraded fallback query: the leading slice of the raw user
 * prompt (trimmed), capped at `FALLBACK_MAX_BYTES` on a char boundary.
 */
export function fallbackQuery(userPrompt: string): string {
  const trimmed = userPrompt.trim()
  if (trimmed.length === 0) return ""
  return truncateOnCharBoundary(trimmed, FALLBACK_MAX_BYTES)
}

function truncateOnCharBoundary(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  const bytes = enc.encode(s)
  if (bytes.length <= maxBytes) return s
  let cut = maxBytes
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--
  const dec = new TextDecoder("utf-8", { fatal: false })
  return dec.decode(bytes.slice(0, cut))
}

// --------------------------------------------------------------------------
// Regex-based fallback synthesizer
// --------------------------------------------------------------------------

/**
 * Word characters considered noise by the keyword extractor. Matches
 * codex-rs's "strip conversational filler" rule — kept short and
 * deterministic so unit tests stay stable.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "is", "are",
  "was", "were", "be", "been", "being", "of", "to", "in", "on", "at", "for",
  "with", "from", "by", "as", "this", "that", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
  "their", "what", "which", "who", "when", "where", "why", "how", "do", "does",
  "did", "doing", "have", "has", "had", "having", "can", "could", "should",
  "would", "may", "might", "must", "shall", "will", "please", "thanks",
  "thank", "kindly", "want", "need", "really", "very", "just", "actually",
  "basically", "essentially", "literally", "fix", "bug",
])

/**
 * Pure deterministic fallback: extracts up to `maxKeywords` keyword tokens
 * from `userPrompt`, prioritising identifiers (camelCase, snake_case, paths,
 * extensions) and dropping common stop words. Emits a space-joined string
 * suitable for direct embedding.
 *
 * Used when no LLM is available or `synthesizeMemoryQuery` is invoked
 * with `model: undefined`. Mirrors the spirit of the Rust fallback
 * (raw-prompt truncation) but produces a more focused query than a
 * literal slice — important for OpenCode where embeddings power
 * retrieval directly without a separate BM25 stage.
 */
export function regexKeywordQuery(userPrompt: string, maxKeywords = 10): string {
  const trimmed = userPrompt.trim()
  if (trimmed.length === 0) return ""

  // Pull "interesting" identifier-like tokens first (camelCase, snake_case,
  // dotted paths, file extensions). These usually carry the highest signal
  // for technical retrieval.
  const identifierRegex = /[A-Za-z_][A-Za-z0-9_]*(?:[./][A-Za-z0-9_]+)+|[A-Za-z_][A-Za-z0-9_]*/g
  const seen = new Set<string>()
  const tokens: string[] = []
  let m: RegExpExecArray | null
  while ((m = identifierRegex.exec(trimmed)) !== null) {
    const raw = m[0]
    if (raw.length < 2) continue
    const lower = raw.toLowerCase()
    // Skip stop words. Identifiers that look "code-shaped" — i.e. contain
    // an internal uppercase, an underscore, a dot, a slash, or a digit —
    // are kept regardless. A leading capital alone is NOT enough (would
    // promote sentence-start words like "Please").
    if (STOP_WORDS.has(lower) && !/[._/0-9]|[a-z][A-Z]/.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    tokens.push(raw)
    if (tokens.length >= maxKeywords) break
  }
  return tokens.join(" ")
}

// --------------------------------------------------------------------------
// LLM-driven synthesis entry point
// --------------------------------------------------------------------------

/**
 * Caller-supplied LLM bridge. Takes the rendered prompt and returns the
 * raw model text (or `null` to signal failure / no model available).
 * Keeps `query-synth.ts` provider-agnostic.
 */
export type SynthesizeModel = (prompt: string) => Effect.Effect<string | null, unknown>

export interface SynthesizeMemoryQueryInput {
  readonly userPrompt: string
  readonly cwdContext?: string | null
  /** Inject `undefined` to skip LLM entirely and use the regex fallback. */
  readonly model?: SynthesizeModel
  /** Override per-call timeout (ms). */
  readonly timeoutMs?: number
}

export interface SynthesizeMemoryQueryResult {
  readonly query: string
  readonly source: "llm" | "regex" | "fallback" | "empty"
}

/**
 * Synthesise a search query for the memory retrieval pipeline.
 *
 * Best-effort: the returned `query` is always a usable string (possibly
 * empty if even the fallback regex extracted nothing). The `source`
 * field surfaces the path taken so callers / tests can assert which
 * branch fired.
 */
export function synthesizeMemoryQuery(
  input: SynthesizeMemoryQueryInput,
): Effect.Effect<SynthesizeMemoryQueryResult> {
  return Effect.gen(function* () {
    const userPrompt = input.userPrompt
    if (!userPrompt.trim()) return { query: "", source: "empty" as const }

    if (!input.model) {
      const regex = regexKeywordQuery(userPrompt)
      if (regex) return { query: regex, source: "regex" as const }
      return { query: fallbackQuery(userPrompt), source: "fallback" as const }
    }

    const prompt = buildQueryPrompt(userPrompt, input.cwdContext)
    const raw: string | null = yield* input
      .model(prompt)
      .pipe(
        Effect.timeoutOption(input.timeoutMs ?? MODEL_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(Option.none<string | null>())),
        Effect.map((opt) => Option.match(opt, { onNone: () => null, onSome: (v) => v ?? null })),
      )

    if (!raw) {
      const regex = regexKeywordQuery(userPrompt)
      return regex
        ? { query: regex, source: "regex" as const }
        : { query: fallbackQuery(userPrompt), source: "fallback" as const }
    }

    const parsed = parseQueryResponse(raw)
    if (typeof parsed === "string" && parsed.length > 0) {
      return { query: parsed, source: "llm" as const }
    }
    // Parse failed or empty query string — degrade to regex extractor.
    const regex = regexKeywordQuery(userPrompt)
    return regex
      ? { query: regex, source: "regex" as const }
      : { query: fallbackQuery(userPrompt), source: "fallback" as const }
  })
}
