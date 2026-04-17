/**
 * Skill mention parser + implicit/explicit invocation telemetry.
 *
 * Ports the user-facing parts of `codex-rs/core/src/skills/injection.rs`
 * (lines 100-378) and `invocation_utils.rs`. Two pipelines:
 *
 *   1. **Explicit mentions.** `parseSkillMentions(text, list)` scans user
 *      input for `$skill-name` sigils and `[$skill-name](path)` markdown links,
 *      resolving each to a known skill (case-insensitive, dedup, ordered by
 *      first occurrence in the user text). Mentioned skills are flagged as
 *      "invoked" in the evolution engine via `recordInvocation`.
 *
 *   2. **Implicit invocation.** `detectImplicitInvocation(toolCalls, list)`
 *      heuristically classifies a turn's tool calls. If they line up with a
 *      skill's `triggers:` frontmatter or its bundled `scripts/` directory,
 *      we record an implicit invocation so the evolution engine still tracks
 *      utility for skills the model used without an explicit `$mention`.
 *
 * Both paths are pure and side-effect-free; the caller (session/system.ts or
 * tool/registry.ts) is responsible for funneling the resulting "invoked"
 * skill names into `SkillEvolution.onToolComplete`.
 */

import path from "path"
import type { Info as SkillInfo } from "./index"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMention {
  /** The matched skill from the loaded library. */
  skill: SkillInfo
  /** True if mention was `[$name](path)` rather than bare `$name`. */
  hadExplicitPath: boolean
  /** Byte offset of the sigil in the source text. */
  index: number
}

const TOOL_MENTION_SIGIL = "$"
// Same character class as Rust's `is_mention_name_char`.
const NAME_RE = /[a-zA-Z0-9_\-:]/

const COMMON_ENV_VARS = new Set([
  "PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "TEMP", "TMP",
  "LANG", "TERM", "XDG_CONFIG_HOME",
])

// ---------------------------------------------------------------------------
// Explicit mention parser
// ---------------------------------------------------------------------------

/**
 * Extract skill mentions from a single user-text input.
 *
 * Supports both bare `$skill-name` and the explicit `[$skill-name](path)`
 * Markdown link form. Names are matched case-insensitively against the
 * `skills` list. Duplicates (same skill referenced twice) are coalesced by
 * first occurrence. Mentions whose name collides with a common env var
 * (`PATH`, `HOME`, …) are ignored to avoid false-positives.
 */
export function parseSkillMentions(text: string, skills: SkillInfo[]): SkillMention[] {
  if (!text || skills.length === 0) return []
  const byName = new Map<string, SkillInfo>()
  for (const skill of skills) byName.set(skill.name.toLowerCase(), skill)

  const out: SkillMention[] = []
  const seen = new Set<string>()
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    // `[$name](path)` form
    if (ch === "[") {
      const linked = parseLinkedMention(text, i)
      if (linked) {
        const lower = linked.name.toLowerCase()
        if (!COMMON_ENV_VARS.has(linked.name.toUpperCase())) {
          const skill = matchByPath(skills, linked.path) ?? byName.get(lower)
          if (skill && !seen.has(skill.name.toLowerCase())) {
            seen.add(skill.name.toLowerCase())
            out.push({ skill, hadExplicitPath: true, index: i })
          }
        }
        i = linked.endIndex
        continue
      }
    }

    if (ch === TOOL_MENTION_SIGIL) {
      const name = readNameAt(text, i + 1)
      if (name && !COMMON_ENV_VARS.has(name.toUpperCase())) {
        const skill = byName.get(name.toLowerCase())
        if (skill && !seen.has(skill.name.toLowerCase())) {
          seen.add(skill.name.toLowerCase())
          out.push({ skill, hadExplicitPath: false, index: i })
        }
        i += 1 + name.length
        continue
      }
    }

    i += 1
  }
  return out
}

function readNameAt(text: string, start: number): string | undefined {
  if (start >= text.length) return undefined
  if (!NAME_RE.test(text[start])) return undefined
  let end = start + 1
  while (end < text.length && NAME_RE.test(text[end])) end += 1
  return text.slice(start, end)
}

function parseLinkedMention(
  text: string,
  start: number,
): { name: string; path: string; endIndex: number } | undefined {
  // Expect `[$name](path)`
  if (text[start + 1] !== TOOL_MENTION_SIGIL) return undefined
  const name = readNameAt(text, start + 2)
  if (!name) return undefined
  let cursor = start + 2 + name.length
  if (text[cursor] !== "]") return undefined
  cursor += 1
  // optional whitespace
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
  if (text[cursor] !== "(") return undefined
  cursor += 1
  const pathStart = cursor
  while (cursor < text.length && text[cursor] !== ")") cursor += 1
  if (cursor >= text.length) return undefined
  const pth = text.slice(pathStart, cursor).trim()
  if (!pth) return undefined
  return { name, path: pth, endIndex: cursor + 1 }
}

function matchByPath(skills: SkillInfo[], target: string): SkillInfo | undefined {
  const norm = target.replace(/^skill:\/\//, "").trim()
  for (const skill of skills) {
    if (skill.location === norm) return skill
    if (path.basename(skill.location) === path.basename(norm) && skill.location.endsWith(norm)) {
      return skill
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Implicit invocation telemetry
// ---------------------------------------------------------------------------

export interface ToolCallSnapshot {
  toolName: string
  /** The tool's structured input (args). */
  input: Record<string, unknown>
}

export interface ImplicitInvocation {
  skill: SkillInfo
  reason: "scripts-dir" | "skill-doc" | "trigger"
}

/**
 * Heuristic: given a turn's executed tool calls, return the skills that
 * appear to have been invoked implicitly (without a `$mention`).
 *
 * Three signals (matches Rust):
 *   - **scripts-dir** — a shell command runs a script under `<skill_dir>/scripts/`.
 *   - **skill-doc** — a `cat`/`head`/`sed`/… command opens the skill's `SKILL.md`.
 *   - **trigger** — the tool call's argument string contains a phrase from
 *      the skill's frontmatter `triggers:` list.
 */
export function detectImplicitInvocation(
  toolCalls: ToolCallSnapshot[],
  skills: SkillInfo[],
): ImplicitInvocation[] {
  if (toolCalls.length === 0 || skills.length === 0) return []

  // Pre-compute path indexes for each skill.
  const indexes = skills.map((skill) => {
    const skillDir = path.dirname(skill.location)
    return {
      skill,
      scriptsDir: path.join(skillDir, "scripts"),
      docPath: skill.location,
      triggers: triggersFromContent(skill.content),
    }
  })

  const out: ImplicitInvocation[] = []
  const seen = new Set<string>()
  const push = (skill: SkillInfo, reason: ImplicitInvocation["reason"]) => {
    if (seen.has(skill.name)) return
    seen.add(skill.name)
    out.push({ skill, reason })
  }

  for (const call of toolCalls) {
    const argsText = stringifyArgs(call.input)
    const tokens = tokenizeShell(argsText)

    for (const idx of indexes) {
      // scripts-dir match
      const scriptToken = scriptRunToken(tokens, call.toolName)
      if (scriptToken && scriptInsideDir(scriptToken, idx.scriptsDir)) {
        push(idx.skill, "scripts-dir")
        continue
      }
      // skill-doc match
      if (commandReadsFile(tokens, call.toolName) && tokens.some((t) => isSkillDocMatch(t, idx.docPath))) {
        push(idx.skill, "skill-doc")
        continue
      }
      // trigger match
      for (const trig of idx.triggers) {
        if (trig.length >= 3 && argsText.toLowerCase().includes(trig.toLowerCase())) {
          push(idx.skill, "trigger")
          break
        }
      }
    }
  }

  return out
}

function stringifyArgs(input: Record<string, unknown>): string {
  if (!input) return ""
  if (typeof input["command"] === "string") return input["command"] as string
  if (Array.isArray(input["command"])) return (input["command"] as unknown[]).map(String).join(" ")
  if (typeof input["query"] === "string") return input["query"] as string
  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function tokenizeShell(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

const SHELL_RUNNERS = new Set([
  "python", "python3", "bash", "zsh", "sh", "node", "deno", "ruby", "perl", "pwsh",
])
const SCRIPT_EXTENSIONS = [".py", ".sh", ".js", ".ts", ".rb", ".pl", ".ps1"]

function scriptRunToken(tokens: string[], toolName: string): string | undefined {
  if (toolName !== "bash" && toolName !== "shell") return undefined
  if (tokens.length === 0) return undefined
  const runner = path.basename(tokens[0]).toLowerCase().replace(/\.exe$/, "")
  if (!SHELL_RUNNERS.has(runner)) return undefined
  for (const t of tokens.slice(1)) {
    if (t === "--") continue
    if (t.startsWith("-")) continue
    const lower = t.toLowerCase()
    if (SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return t
    return undefined
  }
  return undefined
}

function scriptInsideDir(scriptToken: string, scriptsDir: string): boolean {
  const resolved = path.isAbsolute(scriptToken) ? scriptToken : path.resolve(scriptToken)
  return resolved === scriptsDir || resolved.startsWith(scriptsDir + path.sep)
}

const FILE_READERS = new Set(["cat", "sed", "head", "tail", "less", "more", "bat", "awk"])

function commandReadsFile(tokens: string[], toolName: string): boolean {
  if (toolName === "read" || toolName === "read_file") return true
  if (toolName !== "bash" && toolName !== "shell") return false
  if (tokens.length === 0) return false
  const program = path.basename(tokens[0]).toLowerCase()
  return FILE_READERS.has(program)
}

function isSkillDocMatch(token: string, docPath: string): boolean {
  if (token.startsWith("-")) return false
  return token === docPath || (path.basename(token) === path.basename(docPath) && docPath.endsWith(token))
}

function triggersFromContent(content: string): string[] {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return []
  const fm = match[1]
  const triggersMatch = fm.match(/^triggers\s*:\s*\n((?:\s*-\s.*\n?)+)/m)
  if (!triggersMatch) return []
  return triggersMatch[1]
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

export * as SkillInjection from "./injection"
