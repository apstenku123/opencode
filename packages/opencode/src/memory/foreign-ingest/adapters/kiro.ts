/**
 * Kiro CLI SQLite adapter.
 *
 * Reads conversation history from
 * `~/Library/Application Support/kiro-cli/data.sqlite3` (macOS) using Bun's
 * built-in `bun:sqlite`. The conversation row's `value` column is a JSON blob
 * with a `history[]` of `{user, assistant}` exchanges. Port of
 * `codex-rs/core/src/memories/foreign_ingest/adapters/kiro.rs`.
 */

import { Database as BunDatabase } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  type DiscoveredSession,
  type IngestedSession,
  type IngestedTurn,
} from "./index"

// --------------------------------------------------------------------------
// Default path
// --------------------------------------------------------------------------

/**
 * macOS default location for the Kiro CLI database. Other OSes are not yet
 * supported by upstream Kiro; callers can pass an explicit path.
 */
export function defaultDbPath(): string {
  const home = process.env.HOME ?? ""
  return path.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3")
}

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

interface ConvRow {
  key: string
  conversation_id: string
  updated_at: string | null
}

/**
 * Read every conversation row from the Kiro DB and emit cheap discovery
 * metadata. The `key` column carries the cwd. Content hash is derived from
 * `(updated_at, conversation_id)` so updates trigger a re-ingest.
 */
export function scanKiroSessions(dbPath: string): DiscoveredSession[] {
  if (!existsSync(dbPath)) return []
  let db: BunDatabase
  try {
    db = new BunDatabase(dbPath, { readonly: true })
  } catch {
    return []
  }
  try {
    const rows = db
      .query(
        "SELECT key, conversation_id, updated_at " +
          "FROM conversations_v2 ORDER BY updated_at DESC",
      )
      .all() as ConvRow[]
    return rows.map((row) => {
      const cwd = row.key || undefined
      const updatedTs = row.updated_at ? Date.parse(row.updated_at) : 0
      const hasher = createHash("sha256")
      hasher.update(row.updated_at ?? "")
      hasher.update(row.conversation_id)
      const contentHash = hasher.digest("hex")
      return {
        tool: "kiro" as const,
        sourceID: row.conversation_id,
        sourcePath: `sqlite:${dbPath}#${row.key}`,
        cwd,
        updatedAt: Number.isFinite(updatedTs) ? updatedTs : 0,
        contentHash,
      }
    })
  } catch {
    return []
  } finally {
    db.close(false)
  }
}

// --------------------------------------------------------------------------
// Full parse
// --------------------------------------------------------------------------

interface FullRow {
  key: string
  value: string
}

export function parseSession(dbPath: string, conversationID: string): IngestedSession | undefined {
  if (!existsSync(dbPath)) return undefined
  let db: BunDatabase
  try {
    db = new BunDatabase(dbPath, { readonly: true })
  } catch {
    return undefined
  }
  try {
    const row = db
      .query("SELECT key, value FROM conversations_v2 WHERE conversation_id = ?")
      .get(conversationID) as FullRow | null
    if (!row) return undefined

    let parsed: any
    try {
      parsed = JSON.parse(row.value)
    } catch {
      return undefined
    }
    const history = Array.isArray(parsed?.history) ? parsed.history : []
    const turns: IngestedTurn[] = []
    for (const entry of history) {
      const userText = entry?.user?.content?.Prompt?.prompt
      const assistantText = entry?.assistant?.Response?.content
      const ut = typeof userText === "string" ? userText : ""
      if (ut.length === 0) continue
      turns.push({
        userText: ut,
        assistantText: typeof assistantText === "string" ? assistantText : "",
        toolCalls: [],
        hasReasoning: false,
      })
    }
    if (turns.length === 0) return undefined
    return {
      tool: "kiro",
      sourceID: conversationID,
      sourcePath: `sqlite:${dbPath}`,
      cwd: row.key || undefined,
      turns,
    }
  } finally {
    db.close(false)
  }
}
