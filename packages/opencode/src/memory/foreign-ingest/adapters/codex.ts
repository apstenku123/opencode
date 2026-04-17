/**
 * Codex CLI rollout JSONL adapter.
 *
 * Parses `~/.codex/sessions/YYYY/MM/DD/rollout-<TS>-<UUID>.jsonl`. The Codex
 * rollout format mirrors our internal `ResponseItem` layout closely, so this
 * is the simplest of the foreign adapters. Port of
 * `codex-rs/core/src/memories/foreign_ingest/adapters/codex.rs`.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
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
 * Walk `<codexDir>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` and emit cheap
 * metadata. Symlink loops are detected via `realpath`-deduped visited set so
 * the walker terminates on misconfigured trees.
 */
export function scanSessionsDir(codexDir: string): DiscoveredSession[] {
  const sessionsDir = path.join(codexDir, "sessions")
  const out: DiscoveredSession[] = []
  const visited = new Set<string>()
  walk(sessionsDir, out, visited)
  return out
}

function walk(dir: string, out: DiscoveredSession[], visited: Set<string>) {
  let canonical: string
  try {
    canonical = realpathSync(dir)
  } catch {
    return
  }
  if (visited.has(canonical)) return
  visited.add(canonical)

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walk(full, out, visited)
    } else if (stat.isFile() && name.endsWith(".jsonl") && name.startsWith("rollout-")) {
      const d = discoverRollout(full)
      if (d) out.push(d)
    }
  }
}

function discoverRollout(filePath: string): DiscoveredSession | undefined {
  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
  const stem = path.basename(filePath, ".jsonl")
  let sessionID = parseRolloutSessionID(stem) ?? stem
  let cwd: string | undefined

  const firstLine = content.split("\n").find((l) => l.trim().length > 0)
  if (firstLine) {
    try {
      const entry = JSON.parse(firstLine)
      if (entry?.type === "session_meta") {
        const c = entry?.payload?.cwd
        if (typeof c === "string") cwd = c
        const id = entry?.payload?.id
        if (typeof id === "string" && id.length > 0) sessionID = id
      }
    } catch {}
  }

  const stat = statSync(filePath, { throwIfNoEntry: false })
  const updatedAt = stat?.mtimeMs ? Math.floor(stat.mtimeMs) : 0
  return {
    tool: "codex",
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

export function parseRollout(filePath: string): IngestedSession | undefined {
  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
  const stem = path.basename(filePath, ".jsonl")
  let sessionID = parseRolloutSessionID(stem) ?? stem
  let cwd: string | undefined

  const turns: IngestedTurn[] = []
  let currentUser = ""
  let currentAssistant = ""
  let currentToolCalls: { name: string; args: string }[] = []

  const finalize = () => {
    if (currentUser.length > 0) {
      turns.push({
        userText: currentUser,
        assistantText: currentAssistant,
        toolCalls: currentToolCalls,
        hasReasoning: false,
      })
      currentUser = ""
      currentAssistant = ""
      currentToolCalls = []
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
    const entryType = typeof entry?.type === "string" ? entry.type : ""
    if (entryType === "session_meta") {
      const c = entry?.payload?.cwd
      if (typeof c === "string") cwd = c
      const id = entry?.payload?.id
      if (typeof id === "string" && id.length > 0) sessionID = id
    } else if (entryType === "response_item") {
      const payload = entry?.payload ?? {}
      const role = typeof payload.role === "string" ? payload.role : ""
      if (role === "user") {
        finalize()
        currentUser = extractCodexText(payload)
      } else if (role === "assistant") {
        const text = extractCodexText(payload)
        if (currentAssistant.length > 0) currentAssistant += "\n"
        currentAssistant += text
      }
    }
  }

  finalize()
  if (turns.length === 0) return undefined

  return {
    tool: "codex",
    sourceID: sessionID,
    sourcePath: filePath,
    cwd,
    turns,
  }
}

function extractCodexText(payload: any): string {
  if (!Array.isArray(payload?.content)) return ""
  const parts: string[] = []
  for (const item of payload.content) {
    const t = item?.type
    if ((t === "input_text" || t === "text") && typeof item?.text === "string") parts.push(item.text)
  }
  return parts.join("\n")
}

/**
 * Recover the session UUID from a rollout file stem such as
 * `rollout-2026-04-10T21-30-00-0191e3de-7f8a-4c32-9abd-cb3fa2e9bc4e`. Returns
 * the trailing 8-4-4-4-12 UUID when present; otherwise the post-prefix
 * remainder. Returns undefined if the stem doesn't start with `rollout-`.
 */
export function parseRolloutSessionID(stem: string): string | undefined {
  if (!stem.startsWith("rollout-")) return undefined
  const rest = stem.slice("rollout-".length)
  const parts = rest.split("-")
  if (parts.length >= 5) {
    const tail = parts.slice(parts.length - 5)
    const widths = [8, 4, 4, 4, 12]
    const isUuid = tail.every((seg, i) => seg.length === widths[i] && /^[0-9a-fA-F]+$/.test(seg))
    if (isUuid) return tail.join("-")
  }
  if (parts.length > 6) return parts.slice(6).join("-")
  return rest
}
