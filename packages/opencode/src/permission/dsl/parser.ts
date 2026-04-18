export * as DSLParser from "./parser"

import { parse as parseJsonc } from "jsonc-parser"
import yaml from "yaml"

/**
 * Port of `codex-rs/execpolicy/src/parser.rs` (473 LOC). The Rust impl is
 * Lisp-style (S-expressions). For TS ergonomics we expose a structured
 * JSON/JSONC/YAML surface instead — same shape, different skin. A policy file
 * at `.opencode/exec-policy.yaml` (or `.jsonc`, `.json5`) looks like:
 *
 *   version: 1
 *   rules:
 *     - match: { tool: bash, command: "git *" }
 *       action: allow
 *     - match: { tool: edit, path: "src/**\/*.ts" }
 *       action: allow
 *     - match: { tool: bash, command_regex: "^rm\\s+-rf\\s+/" }
 *       action: deny
 *
 * The parser produces a `RawPolicy` — a dumb, untyped-by-regex AST. The
 * compiler (see `compiler.ts`) then turns patterns into compiled matchers.
 */

export type RawAction = "allow" | "deny" | "ask"

export interface RawMatch {
  /** Tool name to match (bash, edit, read, write, webfetch, ...). Wildcards ok. */
  tool?: string
  /** Bash-only: glob pattern matched against the full command string. */
  command?: string
  /** Bash-only: regex pattern matched against the full command string. */
  command_regex?: string
  /** Edit/read/write-only: glob matched against the absolute file path. */
  path?: string
  /** Edit/read/write-only: regex matched against the absolute file path. */
  path_regex?: string
  /** If provided, rule only matches when cwd is under this absolute directory. */
  cwd_under?: string
  /** Optional description. */
  description?: string
}

export interface RawRule {
  match: RawMatch
  action: RawAction
}

export interface RawPolicy {
  version: number
  rules: RawRule[]
}

export class PolicyParseError extends Error {
  readonly source: string
  constructor(message: string, source: string) {
    super(`[exec-policy] ${message} (source: ${source})`)
    this.name = "PolicyParseError"
    this.source = source
  }
}

export interface ParseOptions {
  /** "yaml" | "jsonc" | "json5" | "auto" (default "auto" via content sniff). */
  format?: "yaml" | "jsonc" | "json5" | "auto"
  /** Human-readable source label (filename). Default "<inline>". */
  source?: string
}

/** Detect the textual format from the content. */
function detectFormat(text: string): "yaml" | "jsonc" {
  const trimmed = text.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "jsonc"
  return "yaml"
}

function toAction(value: unknown, source: string, idx: number): RawAction {
  if (value === "allow" || value === "deny" || value === "ask") return value
  throw new PolicyParseError(`rule[${idx}].action must be "allow" | "deny" | "ask", got ${JSON.stringify(value)}`, source)
}

function toMatch(value: unknown, source: string, idx: number): RawMatch {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new PolicyParseError(`rule[${idx}].match must be an object`, source)
  }
  const obj = value as Record<string, unknown>
  const allowed = ["tool", "command", "command_regex", "path", "path_regex", "cwd_under", "description"]
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PolicyParseError(`rule[${idx}].match.${key} is not a recognized key`, source)
    }
  }
  const match: RawMatch = {}
  for (const key of allowed) {
    const v = obj[key]
    if (v === undefined) continue
    if (typeof v !== "string") {
      throw new PolicyParseError(`rule[${idx}].match.${key} must be a string`, source)
    }
    ;(match as Record<string, string>)[key] = v
  }
  if (match.command && match.command_regex) {
    throw new PolicyParseError(`rule[${idx}].match: command and command_regex are mutually exclusive`, source)
  }
  if (match.path && match.path_regex) {
    throw new PolicyParseError(`rule[${idx}].match: path and path_regex are mutually exclusive`, source)
  }
  return match
}

function toRule(value: unknown, source: string, idx: number): RawRule {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new PolicyParseError(`rule[${idx}] must be an object`, source)
  }
  const obj = value as Record<string, unknown>
  return {
    match: toMatch(obj.match, source, idx),
    action: toAction(obj.action, source, idx),
  }
}

/** Parse a policy from raw text. Tolerant of YAML + JSONC + JSON5 (via JSONC). */
export function parse(text: string, options?: ParseOptions): RawPolicy {
  const source = options?.source ?? "<inline>"
  const fmt = options?.format && options.format !== "auto" ? options.format : detectFormat(text)

  let data: unknown
  try {
    if (fmt === "yaml") {
      data = yaml.parse(text)
    } else {
      // jsonc-parser accepts JSON5-ish input (trailing commas, comments).
      const errors: unknown[] = []
      data = parseJsonc(text, errors as any, { allowTrailingComma: true, disallowComments: false })
      if ((errors as any[]).length > 0) {
        throw new Error(`jsonc parse errors: ${JSON.stringify(errors)}`)
      }
    }
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    throw new PolicyParseError(`failed to parse ${fmt}: ${msg}`, source)
  }

  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    throw new PolicyParseError(`policy root must be an object with { version, rules }`, source)
  }
  const root = data as Record<string, unknown>

  const version = typeof root.version === "number" ? root.version : 1
  if (version !== 1) {
    throw new PolicyParseError(`unsupported policy version: ${version} (expected 1)`, source)
  }

  const rulesValue = root.rules
  if (!Array.isArray(rulesValue)) {
    throw new PolicyParseError(`policy.rules must be an array`, source)
  }

  const rules = rulesValue.map((r, i) => toRule(r, source, i))
  return { version, rules }
}

/** Serialize back to YAML for human review / debugging. */
export function stringify(policy: RawPolicy): string {
  return yaml.stringify(policy)
}
