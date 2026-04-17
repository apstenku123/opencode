/**
 * Heuristic skill extractor — port of `codex-rs/core/src/skills/extractor.rs`.
 *
 * Pure, LLM-free. Given a completed turn's messages (assistant tool calls and
 * tool results), synthesize a `SKILL.md` candidate if the turn looks like a
 * reusable workflow: enough tool calls, high success rate, a clear pattern.
 *
 * Round 1 of the codex→opencode autoskill migration covers extraction + hot
 * insert. Later rounds will add BM25 retrieval, an evolution engine, and
 * env-var dependency resolution.
 */

import type { MessageV2 } from "@/session/message-v2"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillExecutionMode = "Automated" | "SemiInteractive" | "Reference"

export interface ToolCallSummary {
  toolName: string
  argumentsSummary: string
  success: boolean
}

export interface ExtractedSkillCandidate {
  suggestedName: string
  suggestedDescription: string
  content: string
  tags: string[]
  executionMode: SkillExecutionMode
  sourceTurnId: string
  confidence: number
}

export interface ExtractorOptions {
  /** Minimum number of tool calls required to consider extraction. Default 3. */
  minToolCalls?: number
  /** Minimum fraction of successful tool calls. Default 0.8. */
  minSuccessRate?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_TOOL_CALLS = 3
const DEFAULT_MIN_SUCCESS_RATE = 0.8
const NAME_MAX_LEN = 50
const DESCRIPTION_PROMPT_CLIP = 80
const ARG_SUMMARY_CLIP = 120
const ORIGINAL_REQUEST_CLIP = 200
const MAX_TAGS = 10

// ---------------------------------------------------------------------------
// Top-level extractor
// ---------------------------------------------------------------------------

/**
 * Input for `extractFromTurn`. A flattened, provider-agnostic shape that
 * maps 1:1 to Rust's `ResponseItem` pairing by `call_id`. Each entry
 * represents one completed tool invocation for the turn.
 */
export interface TurnInput {
  /** Stable identifier for the turn (e.g. assistant message id). */
  turnId: string
  /** User prompt text that initiated the turn. */
  userPrompt: string
  /** Final model response text (currently only used as metadata). */
  modelResponse: string
  /** Tool calls observed during the turn, in invocation order. */
  toolCalls: ToolCallSummary[]
}

export function extractFromTurn(input: TurnInput, opts: ExtractorOptions = {}): ExtractedSkillCandidate[] {
  const minToolCalls = opts.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS
  const minSuccessRate = clamp(opts.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE, 0, 1)

  const calls = input.toolCalls.map((c) => ({
    toolName: canonicalizeToolName(c.toolName),
    argumentsSummary: truncate(c.argumentsSummary, ARG_SUMMARY_CLIP),
    success: c.success,
  }))

  if (calls.length < minToolCalls) return []

  const successRate = computeSuccessRate(calls)
  if (successRate < minSuccessRate) return []

  const workflows = groupIntoWorkflows(calls)

  return workflows.map((wf) => {
    const name = generateName(input.userPrompt, wf)
    const description = generateDescription(input.userPrompt, wf)
    const tags = extractTags(wf)
    const executionMode = inferExecutionMode(wf)
    const confidence = computeConfidence(wf, successRate)
    const content = generateSkillMd({
      name,
      description,
      toolCalls: wf,
      userPrompt: input.userPrompt,
    })
    return {
      suggestedName: name,
      suggestedDescription: description,
      content,
      tags,
      executionMode,
      sourceTurnId: input.turnId,
      confidence,
    }
  })
}

// ---------------------------------------------------------------------------
// Adapter: MessageV2 parts -> ToolCallSummary[]
// ---------------------------------------------------------------------------

/**
 * Pair `ToolPart`s (which in MessageV2 carry both input and output state as a
 * discriminated state union) into `ToolCallSummary` entries.
 *
 * Rust pairs `FunctionCall` requests with `FunctionCallOutput` by `call_id`
 * across a flat `ResponseItem[]`. In our schema, a single `ToolPart` already
 * carries both request args and result state, so pairing is trivial: we walk
 * parts in order and derive success from the `state.status` + `error`
 * sentinels the processor writes.
 */
export function collectToolCallsFromParts(parts: MessageV2.Part[]): ToolCallSummary[] {
  const out: ToolCallSummary[] = []
  for (const part of parts) {
    if (part.type !== "tool") continue
    const state = part.state
    // Skip tool calls that never reached a terminal state — Rust does the
    // same via its `outputs_by_call_id.get(...).unwrap_or(false)` fallback
    // for missing outputs, but here we simply drop them so they do not
    // pollute the success-rate gate.
    if (state.status === "pending" || state.status === "running") continue

    const input = state.input ?? {}
    const argumentsSummary = summarizeArgs(part.tool, input)
    if (state.status === "completed") {
      out.push({
        toolName: canonicalizeToolName(part.tool),
        argumentsSummary,
        // Even when the runtime reports completion, a tool body that looks
        // like an error text is treated as a failure. Matches Rust's
        // `infer_success_from_body` heuristic for providers that don't
        // surface an explicit `success` bool.
        success: !looksLikeErrorText(state.output ?? ""),
      })
    } else if (state.status === "error") {
      out.push({
        toolName: canonicalizeToolName(part.tool),
        argumentsSummary,
        success: false,
      })
    }
  }
  return out
}

function summarizeArgs(tool: string, input: Record<string, unknown>): string {
  // For common shell-family tools the single most useful field is usually
  // `command`. Falling back to stringified JSON keeps the summary legible
  // for other tool shapes.
  const canonical = canonicalizeToolName(tool)
  if (canonical === "shell") {
    const cmd = (input["command"] as unknown) ?? (input["cmd"] as unknown)
    if (typeof cmd === "string") return truncate(cmd, ARG_SUMMARY_CLIP)
    if (Array.isArray(cmd)) return truncate(cmd.map(String).join(" "), ARG_SUMMARY_CLIP)
  }
  const pathLike = (input["path"] ?? input["file_path"] ?? input["filePath"]) as unknown
  if (typeof pathLike === "string") return truncate(pathLike, ARG_SUMMARY_CLIP)
  try {
    return truncate(JSON.stringify(input), ARG_SUMMARY_CLIP)
  } catch {
    return ""
  }
}

function looksLikeErrorText(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase()
  return (
    trimmed.startsWith("error") ||
    trimmed.startsWith("err:") ||
    trimmed.startsWith("failed") ||
    trimmed.startsWith("traceback")
  )
}

// ---------------------------------------------------------------------------
// SKILL.md generation
// ---------------------------------------------------------------------------

function generateSkillMd(input: {
  name: string
  description: string
  toolCalls: ToolCallSummary[]
  userPrompt: string
}): string {
  const tags = extractTags(input.toolCalls)
  const tagsYaml = tags.length ? `tags:\n${tags.map((t) => `  - ${yamlSafeScalar(t)}`).join("\n")}\n` : ""
  const descOneline = flattenToSingleLine(input.description)
  const safeName = yamlSafeScalar(input.name)
  const safeDescription = yamlSafeScalar(descOneline)

  let md = `---\nname: ${safeName}\ndescription: ${safeDescription}\n${tagsYaml}---\n\n`
  md += `# ${input.name}\n\n`
  md += `${descOneline}\n\n`
  md += `**Original request:** ${truncate(flattenToSingleLine(input.userPrompt), ORIGINAL_REQUEST_CLIP)}\n\n`
  md += `## Steps\n\n`
  input.toolCalls.forEach((tc, i) => {
    const status = tc.success ? "ok" : "failed"
    md += `${i + 1}. **${tc.toolName}** [${status}] — ${truncate(tc.argumentsSummary, ARG_SUMMARY_CLIP)}\n`
  })
  md += "\n"
  return md
}

// ---------------------------------------------------------------------------
// Workflow grouping
// ---------------------------------------------------------------------------

function groupIntoWorkflows(calls: ToolCallSummary[]): ToolCallSummary[][] {
  if (calls.length === 0) return []
  return [calls.slice()]
}

// ---------------------------------------------------------------------------
// Name / description
// ---------------------------------------------------------------------------

function generateName(userPrompt: string, toolCalls: ToolCallSummary[]): string {
  const raw = userPrompt.trim()
    ? userPrompt
    : toolCalls[0]?.argumentsSummary ?? "extracted-skill"
  return toKebabCase(raw, NAME_MAX_LEN)
}

function generateDescription(userPrompt: string, toolCalls: ToolCallSummary[]): string {
  const seen = new Set<string>()
  const uniqueNames: string[] = []
  for (const tc of toolCalls) {
    if (!seen.has(tc.toolName)) {
      seen.add(tc.toolName)
      uniqueNames.push(tc.toolName)
    }
  }
  const toolsStr =
    uniqueNames.length <= 3 ? uniqueNames.join(", ") : `${uniqueNames.slice(0, 2).join(", ")}, and ${uniqueNames.length - 2} more`

  const promptSummary = truncate(userPrompt, DESCRIPTION_PROMPT_CLIP)
  if (!promptSummary) return `Auto-extracted skill using ${toolsStr}`
  return `${promptSummary} (uses ${toolsStr})`
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function extractTags(toolCalls: ToolCallSummary[]): string[] {
  const counts = new Map<string, number>()
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

  for (const tc of toolCalls) {
    bump(tc.toolName)
    for (const ext of extractFileExtensions(tc.argumentsSummary)) bump(ext)
    for (const comp of extractPathComponents(tc.argumentsSummary)) bump(comp)
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
  return sorted.slice(0, MAX_TAGS).map(([t]) => t)
}

// ---------------------------------------------------------------------------
// Confidence / success rate / exec mode
// ---------------------------------------------------------------------------

function computeSuccessRate(calls: ToolCallSummary[]): number {
  if (calls.length === 0) return 0
  const successes = calls.reduce((acc, c) => acc + (c.success ? 1 : 0), 0)
  return successes / calls.length
}

function computeConfidence(calls: ToolCallSummary[], successRate: number): number {
  if (calls.length === 0) return 0
  const n = calls.length
  const volumeScore = 1 - 1 / (1 + n / 5)
  const successScore = successRate
  const distinct = new Set(calls.map((c) => c.toolName))
  const clarity =
    calls.length > distinct.size ? 1 - (distinct.size / calls.length) * 0.5 : 0.5
  const raw = volumeScore * 0.3 + successScore * 0.5 + clarity * 0.2
  return clamp(raw, 0, 1)
}

function inferExecutionMode(calls: ToolCallSummary[]): SkillExecutionMode {
  const hasShell = calls.some((c) => c.toolName === "shell")
  const hasWrite = calls.some((c) =>
    ["apply_patch", "write_file", "create_file", "edit_file"].includes(c.toolName),
  )
  const hasSearchOnly = calls.every((c) =>
    ["read_file", "search_files", "list_files", "web_search", "plan"].includes(c.toolName),
  )

  if (hasSearchOnly) return "Reference"
  if (hasShell || hasWrite) return "Automated"
  return "SemiInteractive"
}

// ---------------------------------------------------------------------------
// Canonical tool names
// ---------------------------------------------------------------------------

function canonicalizeToolName(raw: string): string {
  const lower = raw.toLowerCase()
  switch (lower) {
    case "exec_command":
    case "shell_command":
    case "shell":
    case "container.exec":
    case "container_exec":
    case "bash":
    case "local_shell":
    case "local_shell_call":
      return "shell"
    case "apply_patch":
      return "apply_patch"
    case "write_file":
    case "create_file":
      return "write_file"
    case "edit_file":
    case "update_file":
    case "edit":
      return "edit_file"
    case "read_file":
    case "open_file":
    case "read":
      return "read_file"
    case "search_files":
    case "grep":
    case "ripgrep":
    case "rg":
      return "search_files"
    case "list_files":
    case "ls":
      return "list_files"
    case "web_search":
    case "browser.search":
      return "web_search"
    default:
      return lower
  }
}

// ---------------------------------------------------------------------------
// Helpers: truncate / flatten / yaml escape / kebab-case / tag mining
// ---------------------------------------------------------------------------

function truncate(s: string, maxChars: number): string {
  const trimmed = s.trim()
  // `Array.from` over the string walks Unicode scalars so CJK / emoji don't
  // cause us to split mid-codepoint.
  const chars = Array.from(trimmed)
  if (chars.length <= maxChars) return trimmed
  const take = Math.max(0, maxChars - 3)
  return chars.slice(0, take).join("") + "..."
}

function flattenToSingleLine(s: string): string {
  const replaced = Array.from(s, (c) => (isControlChar(c) ? " " : c)).join("")
  let out = ""
  let prevSpace = false
  for (const c of replaced) {
    if (/\s/.test(c)) {
      if (!prevSpace) {
        out += " "
        prevSpace = true
      }
    } else {
      out += c
      prevSpace = false
    }
  }
  return out.trim()
}

function isControlChar(c: string): boolean {
  if (c.length === 0) return false
  const code = c.charCodeAt(0)
  return (code >= 0 && code < 0x20) || code === 0x7f
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

const YAML_RESERVED = new Set([
  "true", "True", "TRUE",
  "false", "False", "FALSE",
  "null", "Null", "NULL",
  "yes", "Yes", "YES",
  "no", "No", "NO",
  "on", "On", "ON",
  "off", "Off", "OFF",
  "~",
])

const YAML_INDICATOR_FIRST = new Set([
  "-", "?", ":", ",", "[", "]", "{", "}", "#",
  "&", "*", "!", "|", ">", "'", '"', "%", "@", "`",
])

const YAML_FORBIDDEN_BODY = new Set([
  ":", "#", "{", "}", "[", "]", ",", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`", "\\",
])

export function yamlSafeScalar(s: string): string {
  if (isSafeBareYamlScalar(s)) return s
  let out = '"'
  for (const c of s) {
    if (c === "\\") out += "\\\\"
    else if (c === '"') out += '\\"'
    else if (c === "\n") out += "\\n"
    else if (c === "\r") out += "\\r"
    else if (c === "\t") out += "\\t"
    else if (isControlChar(c)) out += " "
    else out += c
  }
  out += '"'
  return out
}

function isSafeBareYamlScalar(s: string): boolean {
  if (!s) return false
  if (YAML_RESERVED.has(s)) return false
  const first = s[0]
  if (YAML_INDICATOR_FIRST.has(first)) return false
  if (/[0-9\s]/.test(first)) return false
  for (const c of s) {
    if (isControlChar(c) || c === "\n" || c === "\r" || c === "\t") return false
    if (YAML_FORBIDDEN_BODY.has(c)) return false
  }
  if (s.endsWith(" ")) return false
  return true
}

function toKebabCase(input: string, maxLen: number): string {
  const cleaned = Array.from(input, (c) => (/[A-Za-z0-9]/.test(c) ? c.toLowerCase() : "-")).join("")
  // Collapse runs of hyphens + strip leading hyphen.
  let result = ""
  let prevHyphen = true
  for (const c of cleaned) {
    if (c === "-") {
      if (!prevHyphen) result += "-"
      prevHyphen = true
    } else {
      result += c
      prevHyphen = false
    }
  }
  while (result.endsWith("-")) result = result.slice(0, -1)

  const chars = Array.from(result)
  if (chars.length > maxLen) {
    const slice = chars.slice(0, maxLen).join("")
    const lastHyp = slice.lastIndexOf("-")
    if (lastHyp > maxLen / 2) return result.slice(0, lastHyp)
    result = slice
  }

  return result || "extracted-skill"
}

function extractFileExtensions(text: string): string[] {
  const exts: string[] = []
  const seen = new Set<string>()
  for (const word of text.split(/\s+/)) {
    const cleaned = word.replace(/[^A-Za-z0-9.]+$/, "")
    const dotPos = cleaned.lastIndexOf(".")
    if (dotPos < 0) continue
    const ext = cleaned.slice(dotPos + 1)
    if (!ext) continue
    if (ext.length > 10) continue
    if (!/^[A-Za-z0-9]+$/.test(ext)) continue
    const lower = ext.toLowerCase()
    // `dedup` in Rust removes consecutive duplicates; we approximate with a
    // simple Set since order already reflects first-occurrence.
    if (seen.has(lower)) continue
    seen.add(lower)
    exts.push(lower)
  }
  return exts
}

function extractPathComponents(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const word of text.split(/\s+/)) {
    if (!word.includes("/")) continue
    for (const part of word.split("/")) {
      const trimmed = part.trim()
      if (trimmed.length < 2) continue
      if (trimmed === ".." || trimmed === ".") continue
      if (trimmed.includes(".")) continue
      if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) continue
      const lower = trimmed.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push(lower)
    }
  }
  return out
}

