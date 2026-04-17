import { Effect } from "effect"
import type { Candidate } from "./index"

/**
 * Step A LLM extractor — port of `codex-rs/core/src/autobest_extract.rs::run_step_a`.
 *
 * Given the tail of the last assistant response, ask an LLM to identify
 * explicit next-step actions as a JSON payload:
 *
 *   {
 *     "items": ["action one", "action two", ...],
 *     "complaint": bool,
 *     "complaint_reason": string | null
 *   }
 *
 * We then convert that payload into {@link Candidate} records with a
 * position-weighted score. When the LLM call fails or returns unparseable
 * output we fall back to the deterministic bullet-regex extractor
 * (`fallbackRegex`) for resilience — this mirrors the Rust behaviour where
 * the caller treats an LLM error as an empty-items result and then relies on
 * Step B / Step C follow-ups.
 */

export const MAX_TAIL_BYTES = 6_000
export const MIN_ITEM_CHARS = 5
export const MAX_ITEMS = 4

export type StepAResponse = {
  items: string[]
  complaint: boolean
  complaintReason?: string
}

export type StepAModel = (prompt: string) => Effect.Effect<string | null, unknown>

export type ExtractOptions = {
  /** Bypass LLM entirely when false; go straight to regex fallback. */
  useLlm?: boolean
  /** Injected model call — `null` means unavailable / fallback. */
  model?: StepAModel
  /** Model identifier used for telemetry / decision-event reporting. */
  modelID?: string
  /** Max candidates to return. Mirrors Rust `.take(MAX_ITEMS)`. */
  maxItems?: number
  /** Minimum characters per item. */
  minItemChars?: number
}

export type ExtractResult = {
  candidates: Candidate[]
  stepKind: "a"
  reason: string
  modelUsed: string
  elapsedMs: number
  complaint: boolean
  complaintReason?: string
}

export const STEP_A_PROMPT = `You are reviewing the tail of an assistant response and must extract ONLY the explicit next-step actions the assistant promises or proposes.

Rules:
- Output JSON ONLY. No prose. No code fences. No comments.
- Schema: {"items": string[], "complaint": boolean, "complaint_reason": string|null}.
- "items" contains up to 4 concrete next actions, in order, each at least 5 characters.
- If the assistant complains about missing information, set "complaint" to true and fill "complaint_reason" with a short phrase describing what is missing. Otherwise set "complaint" to false and "complaint_reason" to null.
- Drop filler phrases such as "I'm happy to help" and "let me know".

Assistant tail:
<<<TAIL>>>
{{TAIL}}
<<<END>>>`

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes, preserving character
 * boundaries. Mirror of `codex-rs/core/src/autobest_extract.rs::truncate_tail`.
 */
export function truncateTail(text: string, maxBytes = MAX_TAIL_BYTES): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  // Walk from end backwards until we have at most maxBytes that decode cleanly.
  const slice = bytes.slice(bytes.length - maxBytes)
  // Skip leading continuation bytes (0b10xxxxxx) to land on a char boundary.
  let start = 0
  while (start < slice.length && (slice[start] & 0b1100_0000) === 0b1000_0000) start++
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(slice.slice(start))
  } catch {
    return text.slice(-maxBytes)
  }
}

/**
 * Locate the first balanced `{...}` JSON object in `text`.
 * Mirror of `find_json_object` — tolerates code fences and surrounding prose.
 */
export function findJsonObject(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  // Strip surrounding code fences first.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fence ? fence[1].trim() : trimmed

  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        return candidate.slice(start, i + 1)
      }
    }
  }
  return undefined
}

export function parseStepAJson(raw: string): StepAResponse | undefined {
  const found = findJsonObject(raw)
  if (!found) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(found)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const obj = parsed as Record<string, unknown>
  const rawItems = Array.isArray(obj["items"]) ? (obj["items"] as unknown[]) : []
  const items = rawItems.filter((item): item is string => typeof item === "string").map((item) => item.trim())
  const complaint = obj["complaint"] === true
  const reasonRaw = obj["complaint_reason"]
  const complaintReason = typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw.trim() : undefined
  return { items, complaint, complaintReason }
}

/**
 * Deterministic bullet-regex fallback. Identical to the legacy
 * `SessionAutobestObserver.extract` behavior — kept so that if the LLM
 * is unavailable (no model configured, offline, JSON parse failure) we
 * still produce actionable candidates from the assistant tail.
 */
export function fallbackRegex(text: string, maxItems = 5): Candidate[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line, i) => {
      const m = line.match(/^[-*]\s+(.+)$/) ?? line.match(/^\d+[.)]\s+(.+)$/)
      if (!m) return []
      return [{ key: m[1].slice(0, 120), score: Math.max(1, 100 - i), reason: ["bullet-fallback"] } satisfies Candidate]
    })
    .slice(0, maxItems)
}

function itemsToCandidates(items: string[], opts: { minItemChars: number; maxItems: number }): Candidate[] {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length >= opts.minItemChars)
    .slice(0, opts.maxItems)
    .map(
      (item, index) =>
        ({
          key: item.slice(0, 240),
          score: Math.max(1, 100 - index),
          reason: ["llm-step-a"],
        }) satisfies Candidate,
    )
}

/**
 * Run Step A extraction.
 *
 * Returns an Effect that never fails — on any LLM error or parse failure
 * it falls back to regex-bullet extraction and records that in `reason`.
 */
export function extract(text: string, opts: ExtractOptions = {}): Effect.Effect<ExtractResult> {
  const maxItems = opts.maxItems ?? MAX_ITEMS
  const minItemChars = opts.minItemChars ?? MIN_ITEM_CHARS
  const modelID = opts.modelID ?? "regex-fallback"
  const useLlm = opts.useLlm !== false && !!opts.model

  return Effect.gen(function* () {
    const started = Date.now()
    const tail = truncateTail(text)

    if (!useLlm || !opts.model) {
      const candidates = fallbackRegex(tail)
      return {
        candidates,
        stepKind: "a" as const,
        reason: candidates.length ? "regex-fallback" : "empty",
        modelUsed: "regex-fallback",
        elapsedMs: Date.now() - started,
        complaint: false,
      }
    }

    const prompt = STEP_A_PROMPT.replace("{{TAIL}}", tail)
    const raw: string | null = yield* opts
      .model(prompt)
      .pipe(Effect.catchCause(() => Effect.succeed(null as string | null)))

    if (raw == null) {
      // Model error: degrade gracefully to regex.
      const candidates = fallbackRegex(tail)
      return {
        candidates,
        stepKind: "a" as const,
        reason: candidates.length ? "llm-error-regex-fallback" : "llm-error-empty",
        modelUsed: modelID,
        elapsedMs: Date.now() - started,
        complaint: false,
      }
    }

    const parsed = parseStepAJson(raw)
    if (!parsed) {
      const candidates = fallbackRegex(tail)
      return {
        candidates,
        stepKind: "a" as const,
        reason: candidates.length ? "llm-parse-fail-regex-fallback" : "llm-parse-fail-empty",
        modelUsed: modelID,
        elapsedMs: Date.now() - started,
        complaint: false,
      }
    }

    const candidates = itemsToCandidates(parsed.items, { minItemChars, maxItems })
    return {
      candidates,
      stepKind: "a" as const,
      reason: candidates.length ? "llm-step-a" : "llm-step-a-empty",
      modelUsed: modelID,
      elapsedMs: Date.now() - started,
      complaint: parsed.complaint,
      complaintReason: parsed.complaintReason,
    }
  })
}
