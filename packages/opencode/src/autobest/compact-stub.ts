/**
 * Compact-window stub reader for Step B plan-check.
 *
 * Round 3 — `session/compaction.ts` already runs the compaction pipeline and
 * writes a `summary:true` assistant message into session history, but there is
 * no dedicated API to retrieve the *latest* compact window's structured plan
 * items. This module fills that gap with a lightweight reader that:
 *
 *   1. Walks `Session.messages()` newest-first.
 *   2. Returns the first `summary:true` assistant message's concatenated text.
 *   3. Parses the standard compaction template (`## Accomplished`, `## Plan`,
 *      "next steps" headings) into `CompactWindow.actionItems` / `completed`.
 *
 * When `session/compaction.ts` eventually exposes a proper `getLastCompact`
 * method this file becomes a thin adapter, or can be removed entirely.
 *
 * # Plan marker detection
 *
 * The compaction template (see {@link SessionCompaction} `defaultPrompt`) emits
 * sections with `## Accomplished` / `## Relevant files / directories` etc.
 * We also detect:
 *
 *   - `## Plan` / `## Next Steps` / `## Next steps` / `## TODO`
 *   - Numbered lists (`1. …`, `1) …`)
 *   - Bullet lists (`- …`, `* …`)
 *
 * Items inside the "Accomplished" section are treated as `completed`; items
 * inside plan / next-steps sections are treated as `actionItems`. When no
 * sectioning markers are found we fall back to the top-level bullets and leave
 * `completed` empty.
 */

import { Effect } from "effect"
import { Session } from "@/session"
import type { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import type { CompactWindow, CompactWindowReader } from "./steps"

// Local alias: `Session.Interface.messages` takes a branded SessionID, but the
// `CompactWindowReader` signature takes a plain string to stay independent of
// session typing. We cast at the boundary.
type _SessionIDBranded = SessionID

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SECTION_HEAD_RE = /^##\s+(.+?)\s*$/

const PLAN_SECTIONS = [
  "plan",
  "next steps",
  "next step",
  "todo",
  "to do",
  "instructions",
  "remaining",
]
const DONE_SECTIONS = ["accomplished", "completed", "done"]

function normalizeHeading(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
}

function isPlanSection(h: string): boolean {
  const n = normalizeHeading(h)
  return PLAN_SECTIONS.some((p) => n === p || n.startsWith(p))
}

function isDoneSection(h: string): boolean {
  const n = normalizeHeading(h)
  return DONE_SECTIONS.some((p) => n === p || n.startsWith(p))
}

const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/

/**
 * Parse compaction-summary text into plan action items + completed items.
 *
 * Exported for unit tests.
 */
export function parseCompactText(text: string): { actionItems: string[]; completed: string[] } {
  const lines = text.split(/\r?\n/)
  let bucket: "plan" | "done" | "other" = "other"
  const actionItems: string[] = []
  const completed: string[] = []
  // Fallback: if we see no sectioning, collect all bullets into actionItems.
  const topLevelBullets: string[] = []
  let sawAnySection = false

  for (const raw of lines) {
    const head = raw.match(SECTION_HEAD_RE)
    if (head) {
      sawAnySection = true
      const title = head[1]!
      if (isPlanSection(title)) bucket = "plan"
      else if (isDoneSection(title)) bucket = "done"
      else bucket = "other"
      continue
    }
    const m = raw.match(BULLET_RE)
    if (!m) continue
    const item = m[1]!.trim()
    if (!item) continue
    if (bucket === "plan") actionItems.push(item)
    else if (bucket === "done") completed.push(item)
    else topLevelBullets.push(item)
  }

  if (!sawAnySection && actionItems.length === 0) {
    return { actionItems: topLevelBullets, completed }
  }
  return { actionItems, completed }
}

// ---------------------------------------------------------------------------
// Live reader
// ---------------------------------------------------------------------------

/**
 * Extract concatenated text content from a compaction assistant message.
 */
function extractAssistantText(msg: MessageV2.WithParts): string {
  return msg.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text")
    .map((p) => (p.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Build a CompactWindowReader that pulls the latest `summary:true` assistant
 * message from the given session service.
 *
 * Returns `undefined` when:
 *   - the session has no messages
 *   - no `summary:true` assistant message exists yet
 *   - the compact message's text is empty
 *
 * Errors propagate to the caller; in practice the observer wraps this in
 * `Effect.option`.
 */
export function compactWindowReaderFromSession(session: Session.Interface): CompactWindowReader {
  return (sessionID: string) =>
    Effect.gen(function* () {
      const msgs = yield* session.messages({ sessionID: sessionID as _SessionIDBranded }).pipe(
        Effect.match({ onFailure: () => [] as MessageV2.WithParts[], onSuccess: (v) => v }),
      )
      // Walk newest-first.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.info.role !== "assistant") continue
        if (!(msg.info as MessageV2.Assistant).summary) continue
        const text = extractAssistantText(msg)
        if (!text) continue
        const parsed = parseCompactText(text)
        const window: CompactWindow = {
          id: msgs.length - i, // position-from-tail — monotonic ID suffices for Step B's event log
          snippet: text.slice(0, 600),
          actionItems: parsed.actionItems,
          completed: parsed.completed,
        }
        return window
      }
      return undefined as CompactWindow | undefined
    })
}

/**
 * Scan the `assistantTail` for explicit plan-step markers that appear in
 * `plan.actionItems` but are NOT mentioned in the tail. Returns the first
 * such unfinished item (post-`runStepB`) when the assistant appears to have
 * ignored an explicit plan step.
 *
 * Pure helper — callers combine with {@link runStepB} to decide whether to
 * emit a Step B decision.
 */
export function detectSkippedPlanStep(input: {
  window: CompactWindow
  assistantTail: string
}): string | undefined {
  const tail = input.assistantTail.toLowerCase()
  const completedSet = new Set(input.window.completed.map((s) => s.trim().toLowerCase()))
  for (const item of input.window.actionItems) {
    const needle = item.trim().toLowerCase()
    if (!needle) continue
    if (completedSet.has(needle)) continue
    const trimmed = needle.replace(/^[-*\d.)\s]+/, "")
    // Ignore very short plan items — they produce too many false positives
    // against tails that happen to contain common verbs. Matches the
    // threshold used by {@link assistantIgnoredPlan}.
    if (trimmed.length < 6) continue
    // If the assistant's last output already mentions this plan item,
    // consider it implicitly addressed; skip.
    if (tail.includes(trimmed)) continue
    return item.trim()
  }
  return undefined
}
