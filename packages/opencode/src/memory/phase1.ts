/**
 * Phase-1 per-rollout sextuple extractor.
 *
 * Port of `codex-rs/core/src/memories/phase1.rs` (round-2 scope: the LLM
 * extraction primitive only; the SQLite-backed job-claim/lease scheduler
 * lands in round-3 alongside the commit crawler).
 *
 * Responsibilities of this module:
 *
 *   1. Apply the verbatim Phase-1 system prompt
 *      (`core/templates/memories/stage_one_system.md`) plus a per-rollout
 *      user message containing the rollout text.
 *   2. Forward the rollout text to a caller-supplied LLM bridge with a
 *      strict JSON output schema:
 *      `{ rollout_summary, rollout_slug, raw_memory, sextuples[] }`.
 *   3. Sanitize the response (strip control chars, redact secrets), parse
 *      it, and convert each `sextuple` into a `DefectSextupleInput`
 *      tagged with the rollout's `SextupleSource.Rollout` source.
 *   4. Validate each input (`validateInput`) and dedup against existing
 *      storage via `Memory.add` — store-then-embed.
 *
 * Pure helpers (`tailBiasedTruncate`, `sanitizeJsonControlChars`,
 * `redactSecrets`, `parsePhase1Response`, `buildPhase1Prompt`) are kept
 * synchronous so unit tests can exercise every branch without an LLM.
 */

import { Effect, Option } from "effect"

import type { Memory } from "./index"
import type { DefectSextupleInput, SextupleSource } from "./schema"
import { cleanKeywords } from "./schema"

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Maximum bytes of rollout text forwarded to the model. Tail-biased so the
 * most recent activity (where defect resolutions usually land) is preserved. */
export const STAGE1_INPUT_MAX_BYTES = 32 * 1024
/** Head fraction of `STAGE1_INPUT_MAX_BYTES` retained when truncating. */
export const TAIL_BIAS_HEAD_FRACTION = 0.3
/** Per-call timeout for the extraction LLM (ms). */
export const PHASE1_TIMEOUT_MS = 90_000
/** Max sextuples we accept from one rollout (matches the Rust template guidance). */
export const MAX_SEXTUPLES_PER_ROLLOUT = 5

/**
 * Verbatim copy of `core/templates/memories/stage_one_system.md` is too
 * large to inline (~600 lines, embedded literally would bloat bundle).
 * For the round-2 OpenCode port we ship a much terser system prompt that
 * preserves the contract (the JSON schema + the sextuple sub-structure)
 * but strips the prose guidance — round-3 can re-inline the full template
 * once we wire phase-2 consolidation that actually depends on the rich
 * `rollout_summary` + `raw_memory` fields. For now the only consumer of
 * Phase-1 output is the cross-session memory retriever, which uses the
 * `sextuples` list and ignores `rollout_summary`/`raw_memory`.
 */
export const PHASE1_SYSTEM_PROMPT = `You are a MemCoder Phase-1 extractor.

Read the rollout text below and identify any concrete defect-resolution
moments — places where a problem was hit, diagnosed, and fixed. For each
such moment emit one sextuple capturing the durable lesson.

OUTPUT ONLY a JSON object (no prose, no code fences) with these fields:

{
  "rollout_summary": "one-paragraph summary of what happened in this rollout",
  "rollout_slug":    "short filesystem-safe slug (lowercase, hyphen/underscore, <= 80 chars)",
  "raw_memory":      "compact rebuilt memory body (may be empty)",
  "sextuples": [
    {
      "keywords":   ["3-8 lowercase tokens — concrete identifiers preferred"],
      "problem":    "1 past-tense sentence describing the user-visible symptom",
      "root_cause": "1-2 sentences naming the concrete mechanical cause",
      "solution":   "1-2 sentences describing the fix and why it works"
    }
  ]
}

If the rollout contains no genuine defect-resolution evidence, return an
empty array for "sextuples" (and you may leave the other fields empty
strings). Never invent facts that are not supported by the rollout text.

ROLLOUT TEXT:

{rollout_text}`

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, biased toward the
 * tail. Keeps `headFrac` of the limit from the head and the rest from the
 * tail. Char-boundary safe (will not split a multi-byte codepoint).
 *
 * Mirrors `phase1::tail_biased_truncate` (default split 30/70).
 */
export function tailBiasedTruncate(
  text: string,
  maxBytes: number = STAGE1_INPUT_MAX_BYTES,
  headFrac: number = TAIL_BIAS_HEAD_FRACTION,
): string {
  const enc = new TextEncoder()
  const dec = new TextDecoder("utf-8", { fatal: false })
  const bytes = enc.encode(text)
  if (bytes.length <= maxBytes) return text
  const headBudget = Math.floor(maxBytes * headFrac)
  const tailBudget = maxBytes - headBudget
  // Round head down to the previous char boundary.
  let headCut = headBudget
  while (headCut > 0 && (bytes[headCut]! & 0xc0) === 0x80) headCut--
  // Round tail start up to the next char boundary.
  let tailStart = bytes.length - tailBudget
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++
  const head = dec.decode(bytes.slice(0, headCut))
  const tail = dec.decode(bytes.slice(tailStart))
  return `${head}\n\n…[${bytes.length - headCut - (bytes.length - tailStart)} bytes elided]…\n\n${tail}`
}

/**
 * Strip ASCII control characters (except newline + tab) from a JSON string
 * payload. The codex-rs version targets the same set — many models slip
 * stray `\u0000` bytes into responses which break `JSON.parse`.
 */
export function sanitizeJsonControlChars(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    // Keep tab (0x09) and newline (0x0A); drop everything else < 0x20 + DEL.
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      out += s[i]
    }
  }
  return out
}

/**
 * Heuristic secret redactor — replace tokens that look like API keys /
 * bearer tokens / private keys with `[REDACTED_SECRET]`. Conservative: we
 * over-redact rather than risk persisting a credential. Matches the
 * spirit of the Rust `codex_secrets::redact_secrets` call from
 * `phase1::redact_secrets`.
 */
export function redactSecrets(s: string): string {
  return (
    s
      // OpenAI sk-…
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_SECRET]")
      // Anthropic sk-ant-…
      .replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED_SECRET]")
      // GitHub PATs (classic + fine-grained) and Copilot tokens
      .replace(/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]")
      .replace(/gho_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]")
      .replace(/ghu_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]")
      .replace(/ghs_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]")
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_SECRET]")
      // Generic Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [REDACTED_SECRET]")
      // AWS access key ids
      .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_SECRET]")
      // SSH private key blocks
      .replace(
        /-----BEGIN\s+(?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/g,
        "[REDACTED_SECRET]",
      )
  )
}

/** Build the per-rollout user prompt body. */
export function buildPhase1Prompt(rolloutText: string): string {
  const sanitized = redactSecrets(rolloutText)
  const truncated = tailBiasedTruncate(sanitized)
  return PHASE1_SYSTEM_PROMPT.replace("{rollout_text}", truncated)
}

// --------------------------------------------------------------------------
// Response parsing
// --------------------------------------------------------------------------

export interface Phase1RawSextuple {
  readonly keywords: ReadonlyArray<string>
  readonly problem: string
  readonly rootCause: string
  readonly solution: string
}

export interface Phase1Response {
  readonly rolloutSummary: string
  readonly rolloutSlug: string
  readonly rawMemory: string
  readonly sextuples: ReadonlyArray<Phase1RawSextuple>
}

/**
 * Locate the first balanced `{...}` JSON object in a possibly noisy LLM
 * response (string-aware so braces inside strings don't confuse the depth
 * tracking). Inline copy of the helper used by `query-synth` / `refining`.
 */
function locateBalancedObject(s: string): string | undefined {
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

/** Parse the Phase-1 LLM response into a typed structure. Returns `null`
 * when the response is unparseable. Tolerates code-fence wrappers and
 * extraneous chatter. */
export function parsePhase1Response(raw: string): Phase1Response | null {
  const sanitized = sanitizeJsonControlChars(raw).trim()
  // Strip code fences first.
  let body = sanitized
  if (body.startsWith("```json")) body = body.slice(7)
  else if (body.startsWith("```")) body = body.slice(3)
  if (body.endsWith("```")) body = body.slice(0, -3)
  body = body.trim()

  const objText = locateBalancedObject(body) ?? body
  let parsed: unknown
  try {
    parsed = JSON.parse(objText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const v = parsed as Record<string, unknown>

  const sextuplesRaw = Array.isArray(v["sextuples"]) ? (v["sextuples"] as unknown[]) : []
  const sextuples: Phase1RawSextuple[] = []
  for (const entry of sextuplesRaw.slice(0, MAX_SEXTUPLES_PER_ROLLOUT)) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    const keywords = Array.isArray(e["keywords"])
      ? (e["keywords"] as unknown[]).filter((k): k is string => typeof k === "string")
      : []
    const problem = typeof e["problem"] === "string" ? (e["problem"] as string) : ""
    const rootCause = typeof e["root_cause"] === "string" ? (e["root_cause"] as string) : ""
    const solution = typeof e["solution"] === "string" ? (e["solution"] as string) : ""
    if (keywords.length === 0 || !problem || !solution) continue
    sextuples.push({ keywords, problem, rootCause, solution })
  }

  return {
    rolloutSummary: typeof v["rollout_summary"] === "string" ? (v["rollout_summary"] as string) : "",
    rolloutSlug: typeof v["rollout_slug"] === "string" ? (v["rollout_slug"] as string) : "",
    rawMemory: typeof v["raw_memory"] === "string" ? (v["raw_memory"] as string) : "",
    sextuples,
  }
}

/**
 * Convert raw extraction sextuples into `DefectSextupleInput` records ready
 * for `Memory.add` / `MemoryStorage.store`. Cleans keywords + drops entries
 * that fail validation (`validateInput` semantics).
 */
export function buildSextupleInputs(
  response: Phase1Response,
  source: SextupleSource,
  projectID?: string,
): DefectSextupleInput[] {
  const out: DefectSextupleInput[] = []
  for (const raw of response.sextuples) {
    const cleaned: DefectSextupleInput = {
      keywords: cleanKeywords(raw.keywords),
      problem: raw.problem.trim(),
      rootCause: raw.rootCause.trim(),
      solution: raw.solution.trim(),
      source,
      projectID,
    }
    if (cleaned.keywords.length === 0 || !cleaned.problem || !cleaned.solution) continue
    out.push(cleaned)
  }
  return out
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

export type Phase1Model = (prompt: string) => Effect.Effect<string | null, unknown>

export interface RunPhase1Input {
  /** Concatenated rollout text (e.g. recent assistant + tool turns). */
  readonly rolloutText: string
  /** The source attribution stamped into every produced sextuple. */
  readonly source: SextupleSource
  /** Optional project scoping (for retrieval). */
  readonly projectID?: string
  /** LLM bridge — when omitted, the function returns `[]` immediately. */
  readonly model?: Phase1Model
  /** Override per-call timeout (ms). */
  readonly timeoutMs?: number
}

export interface RunPhase1Result {
  readonly response: Phase1Response | null
  readonly inputs: ReadonlyArray<DefectSextupleInput>
  readonly stored: ReadonlyArray<{ readonly hashId: string; readonly inserted: boolean }>
  readonly reason: "no-model" | "llm-error" | "parse-error" | "no-sextuples" | "ok"
}

/**
 * Run the Phase-1 extractor end-to-end:
 *   1. build the prompt (sanitize + truncate),
 *   2. call the LLM bridge,
 *   3. parse + validate the JSON response,
 *   4. dedup against `Memory` storage and persist.
 */
export function runPhase1(
  memory: Memory.Interface,
  input: RunPhase1Input,
): Effect.Effect<RunPhase1Result, never> {
  return Effect.gen(function* () {
    if (!input.model) {
      return { response: null, inputs: [], stored: [], reason: "no-model" as const }
    }
    const prompt = buildPhase1Prompt(input.rolloutText)
    const raw: string | null = yield* input
      .model(prompt)
      .pipe(
        Effect.timeoutOption(input.timeoutMs ?? PHASE1_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(Option.none<string | null>())),
        Effect.map((opt) => Option.match(opt, { onNone: () => null, onSome: (v) => v ?? null })),
      )
    if (!raw) {
      return { response: null, inputs: [], stored: [], reason: "llm-error" as const }
    }
    const response = parsePhase1Response(raw)
    if (!response) {
      return { response: null, inputs: [], stored: [], reason: "parse-error" as const }
    }
    const inputs = buildSextupleInputs(response, input.source, input.projectID)
    if (inputs.length === 0) {
      return { response, inputs: [], stored: [], reason: "no-sextuples" as const }
    }
    const stored: { hashId: string; inserted: boolean }[] = []
    for (const item of inputs) {
      const result = yield* memory.add(item).pipe(
        Effect.match({
          onSuccess: (r) => ({ hashId: r.record.hashId, inserted: r.inserted }),
          onFailure: () => null,
        }),
      )
      if (result) stored.push(result)
    }
    return { response, inputs, stored, reason: "ok" as const }
  })
}

