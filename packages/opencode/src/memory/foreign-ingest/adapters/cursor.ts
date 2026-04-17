/**
 * Cursor Agent JSONL adapter.
 *
 * Two on-disk layouts:
 *  1. Projects: `~/.cursor/projects/<KEY>/agent-transcripts/<SID>/<SID>.jsonl`
 *  2. Chats:    `~/.cursor/chats/<ID>/<ID>.{jsonl,json}`
 *
 * User messages in Cursor are wrapped in `<user_query>...</user_query>`
 * tags; this adapter strips them on parse. Port of
 * `codex-rs/core/src/memories/foreign_ingest/adapters/cursor.rs`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  type DiscoveredSession,
  type IngestedSession,
  type IngestedTurn,
  computeContentHash,
} from "./index"

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

/**
 * Walk both Cursor layouts under `cursorDir` (typically `~/.cursor`) and emit
 * cheap metadata for every session file found.
 */
export function scanCursorDirs(cursorDir: string): DiscoveredSession[] {
  const out: DiscoveredSession[] = []

  // Layout 1: projects/<KEY>/agent-transcripts/<SID>/<SID>.jsonl
  const projectsDir = path.join(cursorDir, "projects")
  if (isDir(projectsDir)) {
    let projects: string[] = []
    try {
      projects = readdirSync(projectsDir)
    } catch {}
    for (const proj of projects) {
      const transcriptsDir = path.join(projectsDir, proj, "agent-transcripts")
      if (!isDir(transcriptsDir)) continue
      let sessions: string[] = []
      try {
        sessions = readdirSync(transcriptsDir)
      } catch {}
      for (const sid of sessions) {
        const jsonl = path.join(transcriptsDir, sid, `${sid}.jsonl`)
        if (existsSync(jsonl)) {
          const d = discoverSession(jsonl, path.join(projectsDir, proj))
          if (d) out.push(d)
        }
      }
    }
  }

  // Layout 2: chats/<ID>/<ID>.jsonl|.json
  const chatsDir = path.join(cursorDir, "chats")
  if (isDir(chatsDir)) {
    let chats: string[] = []
    try {
      chats = readdirSync(chatsDir)
    } catch {}
    for (const cid of chats) {
      for (const ext of ["jsonl", "json"]) {
        const candidate = path.join(chatsDir, cid, `${cid}.${ext}`)
        if (existsSync(candidate)) {
          const d = discoverSession(candidate, path.join(chatsDir, cid))
          if (d) out.push(d)
          break
        }
      }
    }
  }

  return out
}

function discoverSession(filePath: string, projectDir: string): DiscoveredSession | undefined {
  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
  const sourceID = path.basename(filePath).replace(/\.(jsonl|json)$/i, "")
  const cwd = decodeProjectKey(projectDir)
  const stat = statSync(filePath, { throwIfNoEntry: false })
  const updatedAt = stat?.mtimeMs ? Math.floor(stat.mtimeMs) : 0
  return {
    tool: "cursor",
    sourceID,
    sourcePath: filePath,
    cwd,
    updatedAt,
    contentHash: computeContentHash(filePath, content),
  }
}

/**
 * Cursor encodes project paths by replacing `/` and `.` with `-`. The
 * encoding is ambiguous — we try the simplest decode (`-` → `/`) and fall
 * back to prepending a slash. If neither resolves to an actual directory,
 * the cwd is left undefined.
 */
function decodeProjectKey(projectDir: string): string | undefined {
  const key = path.basename(projectDir)
  const candidate = key.replaceAll("-", "/")
  if (isDir(candidate)) return candidate
  const withSlash = "/" + candidate
  if (isDir(withSlash)) return withSlash
  return undefined
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// Full parse
// --------------------------------------------------------------------------

export function parseSession(filePath: string): IngestedSession | undefined {
  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
  const sessionID = path.basename(filePath).replace(/\.(jsonl|json)$/i, "")
  const turns: IngestedTurn[] = []
  let currentUser = ""
  let currentAssistant = ""

  const finalize = () => {
    if (currentUser.length > 0) {
      turns.push({
        userText: currentUser,
        assistantText: currentAssistant,
        toolCalls: [],
        hasReasoning: false,
      })
      currentUser = ""
      currentAssistant = ""
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
    const role = typeof entry?.role === "string" ? entry.role : ""
    if (role === "user") {
      finalize()
      currentUser = stripUserQueryTags(extractText(entry))
    } else if (role === "assistant") {
      const text = extractText(entry)
      if (currentAssistant.length > 0) currentAssistant += "\n"
      currentAssistant += text
    }
  }

  finalize()
  if (turns.length === 0) return undefined

  return {
    tool: "cursor",
    sourceID: sessionID,
    sourcePath: filePath,
    turns,
  }
}

function extractText(entry: any): string {
  const content = entry?.message?.content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text)
  }
  return parts.join("\n")
}

/**
 * Strip the leading/trailing `<user_query>` wrapper Cursor adds around real
 * user prompts. Anything else is returned unchanged.
 */
export function stripUserQueryTags(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith("<user_query>") && trimmed.endsWith("</user_query>")) {
    return trimmed.slice("<user_query>".length, trimmed.length - "</user_query>".length).trim()
  }
  return trimmed
}
