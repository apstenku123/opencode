/**
 * Claude Code / Claude Extension JSONL adapter.
 *
 * Parses `~/.claude/projects/<KEY>/<SID>.jsonl` into [`IngestedSession`].
 * Same file format for both `entrypoint=cli` (Claude Code) and
 * `entrypoint=claude-vscode` (Claude Extension); only the resulting `tool`
 * label differs. Port of
 * `codex-rs/core/src/memories/foreign_ingest/adapters/claude.rs`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  type DiscoveredSession,
  type ForeignTool,
  type IngestedSession,
  type IngestedTurn,
  computeContentHash,
} from "./index"

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

/**
 * Walk `<projectsDir>/<projectKey>/<sessionID>.jsonl` and emit cheap
 * metadata for every session file found.
 */
export function scanProjectsDir(projectsDir: string): DiscoveredSession[] {
  const out: DiscoveredSession[] = []
  let projects: string[] = []
  try {
    projects = readdirSync(projectsDir)
  } catch {
    return out
  }
  for (const projectName of projects) {
    const projectPath = path.join(projectsDir, projectName)
    let entries: string[]
    try {
      const stat = statSync(projectPath)
      if (!stat.isDirectory()) continue
      entries = readdirSync(projectPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue
      const filePath = path.join(projectPath, entry)
      const discovered = discoverSession(filePath)
      if (discovered) out.push(discovered)
    }
  }
  return out
}

function discoverSession(filePath: string): DiscoveredSession | undefined {
  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
  const sessionID = path.basename(filePath, ".jsonl")
  let cwd: string | undefined
  let tool: ForeignTool = "claude_code"

  const lines = content.split("\n").slice(0, 20)
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== "user") continue
    if (cwd === undefined && typeof entry.cwd === "string") cwd = entry.cwd
    if (typeof entry.entrypoint === "string" && entry.entrypoint !== "cli") {
      tool = "claude_ext"
    }
  }

  const stat = statSync(filePath, { throwIfNoEntry: false })
  const updatedAt = stat?.mtimeMs ? Math.floor(stat.mtimeMs) : 0
  return {
    tool,
    sourceID: sessionID,
    sourcePath: filePath,
    cwd,
    updatedAt,
    contentHash: computeContentHash(filePath, content),
  }
}

// --------------------------------------------------------------------------
// Full parse
// --------------------------------------------------------------------------

/**
 * Parse a Claude session file into a normalized [`IngestedSession`]. Returns
 * `undefined` for empty or unreadable files.
 */
export function parseSession(filePath: string): IngestedSession | undefined {
  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
  const sessionID = path.basename(filePath, ".jsonl")

  let cwd: string | undefined
  let tool: ForeignTool = "claude_code"
  let firstTs: number | undefined
  let lastTs: number | undefined

  const turns: IngestedTurn[] = []
  let currentUser = ""
  let currentAssistant = ""
  let currentToolCalls: { name: string; args: string }[] = []
  let currentReasoning: string | undefined
  let hasReasoning = false
  let inTurn = false

  const finalize = () => {
    if (inTurn && currentUser.length > 0) {
      turns.push({
        userText: currentUser,
        assistantText: currentAssistant,
        toolCalls: currentToolCalls,
        hasReasoning,
        reasoningText: currentReasoning,
      })
      currentUser = ""
      currentAssistant = ""
      currentToolCalls = []
      currentReasoning = undefined
      hasReasoning = false
    }
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    // Update timestamp window.
    const ts = parseTimestamp(entry?.timestamp)
    if (ts !== undefined) {
      firstTs = firstTs === undefined ? ts : Math.min(firstTs, ts)
      lastTs = lastTs === undefined ? ts : Math.max(lastTs, ts)
    }

    const entryType = typeof entry?.type === "string" ? entry.type : ""
    if (entryType === "user") {
      // Tool-result echoes (`type=user, content=[{type:tool_result}]`) are
      // tool responses, not real user prompts — skip them. Otherwise they
      // would start a new turn and clobber the user text.
      if (entry.message && isToolResult(entry.message)) continue

      if (cwd === undefined && typeof entry.cwd === "string") cwd = entry.cwd
      if (typeof entry.entrypoint === "string" && entry.entrypoint !== "cli") {
        tool = "claude_ext"
      }

      finalize()
      currentUser = entry.message ? extractTextContent(entry.message) : ""
      inTurn = true
    } else if (entryType === "assistant") {
      const msg = entry.message
      const blocks = Array.isArray(msg?.content) ? msg.content : []
      for (const block of blocks) {
        const blockType = typeof block?.type === "string" ? block.type : ""
        if (blockType === "text" && typeof block.text === "string") {
          if (currentAssistant.length > 0) currentAssistant += "\n"
          currentAssistant += block.text
        } else if (blockType === "thinking" && typeof block.thinking === "string") {
          hasReasoning = true
          if (currentReasoning === undefined) currentReasoning = ""
          else currentReasoning += "\n"
          currentReasoning += block.thinking
        } else if (blockType === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "unknown"
          let args = ""
          if (block.input !== undefined) {
            try {
              args = JSON.stringify(block.input).slice(0, 200)
            } catch {
              args = ""
            }
          }
          currentToolCalls.push({ name, args })
        }
      }
    }
  }

  finalize()
  if (turns.length === 0) return undefined

  return {
    tool,
    sourceID: sessionID,
    sourcePath: filePath,
    cwd,
    turns,
    firstTs,
    lastTs,
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

function extractTextContent(msg: any): string {
  if (typeof msg?.content === "string") return msg.content
  if (Array.isArray(msg?.content)) {
    const parts: string[] = []
    for (const item of msg.content) {
      if (item?.type === "text" && typeof item.text === "string") parts.push(item.text)
    }
    return parts.join("\n")
  }
  return ""
}

function isToolResult(msg: any): boolean {
  if (!Array.isArray(msg?.content)) return false
  return msg.content.some((item: any) => item?.type === "tool_result")
}
