/**
 * OpenCode self-ingest adapter.
 *
 * Reads sessions from THIS OpenCode instance's own storage. Strictly
 * speaking this is a "self-ingest" rather than a "foreign" adapter — it
 * exists so historical OpenCode sessions can be retroactively passed
 * through the foreign-ingest pipeline (cheap dedup + sextuple extraction)
 * without rewiring the live session loop. Mirrors
 * `codex-rs/core/src/memories/foreign_ingest/adapters/opencode.rs`, except
 * the Rust adapter targets the OpenCode SQLite externally — we get to
 * reuse the in-process Drizzle handles instead.
 */

import { createHash } from "node:crypto"
import { Database, asc, eq, sql } from "../../../storage"
import { MessageTable, PartTable, SessionTable } from "../../../session/session.sql"
import {
  type DiscoveredSession,
  type IngestedSession,
  type IngestedTurn,
} from "./index"

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

/**
 * Discover every session row in the local DB. The "content hash" is a cheap
 * function of `(time_updated, message_count)` — when either changes, the
 * checkpoint dedup will re-process the session.
 */
export function scanOpenCodeSessions(): DiscoveredSession[] {
  return Database.use((db) => {
    const rows = db
      .select({
        id: SessionTable.id,
        directory: SessionTable.directory,
        time_updated: SessionTable.time_updated,
        msg_count: sql<number>`(SELECT COUNT(*) FROM ${MessageTable} WHERE ${MessageTable.session_id} = ${SessionTable.id})`,
      })
      .from(SessionTable)
      .all()

    return rows.map((row) => {
      const hasher = createHash("sha256")
      hasher.update(String(row.time_updated ?? 0))
      hasher.update(":")
      hasher.update(String(row.msg_count ?? 0))
      return {
        tool: "opencode" as const,
        sourceID: row.id as string,
        sourcePath: `opencode-db:${row.id}`,
        cwd: row.directory ?? undefined,
        updatedAt: Number(row.time_updated ?? 0),
        contentHash: hasher.digest("hex"),
      }
    })
  })
}

// --------------------------------------------------------------------------
// Full parse
// --------------------------------------------------------------------------

/**
 * Load a single OpenCode session and reduce it to the foreign-ingest shape.
 * Each `(message, parts[])` pair becomes either the user or assistant slot
 * of a turn based on `message.data.role`. Tool-call parts surface as the
 * `toolCalls` array; reasoning parts surface as `reasoningText`.
 */
export function parseSession(sessionID: string): IngestedSession | undefined {
  return Database.use((db) => {
    const session = db.select().from(SessionTable).where(eq(SessionTable.id, sessionID as any)).get()
    if (!session) return undefined

    const messages = db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID as any))
      .orderBy(asc(MessageTable.time_created))
      .all()

    if (messages.length === 0) return undefined

    const turns: IngestedTurn[] = []
    let currentUser = ""
    let currentAssistant = ""
    let currentToolCalls: { name: string; args: string }[] = []
    let currentReasoning: string | undefined
    let hasReasoning = false

    const finalize = () => {
      if (currentUser.length > 0) {
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

    for (const msg of messages) {
      const role = (msg.data as any)?.role
      const parts = db
        .select()
        .from(PartTable)
        .where(eq(PartTable.message_id, msg.id as any))
        .orderBy(asc(PartTable.time_created))
        .all()

      if (role === "user") {
        finalize()
        currentUser = collectText(parts)
      } else if (role === "assistant") {
        currentAssistant = appendText(currentAssistant, collectText(parts))
        for (const part of parts) {
          const data = part.data as any
          if (data?.type === "tool" && typeof data?.tool === "string") {
            const args = safeStringify(data?.state?.input ?? data?.input).slice(0, 200)
            currentToolCalls.push({ name: data.tool, args })
          } else if (data?.type === "reasoning") {
            const t = typeof data?.text === "string" ? data.text : ""
            if (t.length > 0) {
              hasReasoning = true
              currentReasoning = currentReasoning ? currentReasoning + "\n" + t : t
            }
          }
        }
      }
    }

    finalize()
    if (turns.length === 0) return undefined

    return {
      tool: "opencode",
      sourceID: sessionID,
      sourcePath: `opencode-db:${sessionID}`,
      cwd: session.directory,
      turns,
    }
  })
}

function collectText(parts: { data: unknown }[]): string {
  const out: string[] = []
  for (const part of parts) {
    const data = part.data as any
    if (data?.type === "text" && typeof data?.text === "string") out.push(data.text)
  }
  return out.join("\n")
}

function appendText(prefix: string, suffix: string): string {
  if (suffix.length === 0) return prefix
  return prefix.length === 0 ? suffix : prefix + "\n" + suffix
}

function safeStringify(value: unknown): string {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
