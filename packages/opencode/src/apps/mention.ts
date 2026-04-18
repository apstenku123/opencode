/**
 * App-mention parser.
 *
 * Port of the user-message mention scan from `codex-rs/core/src/apps/` plus the
 * prompt-level helper described in the R6 migration plan §3.4.
 *
 * Syntax: `[$app-name](app://{connector_id})`
 *
 * - `app-name` is the human-visible label the user types (conventional, never
 *   authoritative). It may contain any character that is not a `]`.
 * - `connector_id` is the machine id that resolves to an entry in the app
 *   directory. It must match `/^[a-z0-9][a-z0-9._-]*$/i` so we can safely use
 *   it as an MCP server / tool namespace key without further escaping.
 *
 * Returns the raw mentions in document order along with byte offsets, a
 * deduplicated set of ids, and a rewritten string where the mention markers
 * have been replaced with plain `$app-name` for cleaner downstream rendering.
 */

export interface AppMention {
  /** Human-visible label taken from the `$app-name` segment. */
  readonly name: string
  /** Machine id from the `app://id` URL. */
  readonly id: string
  /** Inclusive start offset of the match in the input string. */
  readonly start: number
  /** Exclusive end offset of the match in the input string. */
  readonly end: number
}

export interface ParsedAppMentions {
  readonly mentions: AppMention[]
  /** Unique `id` values in first-seen order. */
  readonly ids: string[]
  /** Input with the mention markup replaced by `$name`. */
  readonly stripped: string
}

// Deliberately conservative: name is anything-but-`]`, id is strict.
// Avoids catastrophic backtracking on adversarial input.
const APP_MENTION_RE = /\[\$([^\]\n]+)\]\(app:\/\/([a-z0-9][a-z0-9._-]*)\)/gi

/** True iff `id` is a well-formed connector id (see module docstring). */
export function isValidAppId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id)
}

/**
 * Scan `text` for app mentions. Returns an empty result when the input does
 * not contain the mention sigil, avoiding regex work on the common path.
 */
export function parseAppMentions(text: string): ParsedAppMentions {
  if (!text || text.indexOf("[$") === -1) {
    return { mentions: [], ids: [], stripped: text ?? "" }
  }

  const mentions: AppMention[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  let stripped = ""
  let cursor = 0

  // Fresh regex state per call — lastIndex on a /g regex is state.
  const re = new RegExp(APP_MENTION_RE.source, APP_MENTION_RE.flags)
  for (;;) {
    const match = re.exec(text)
    if (!match) break
    const [full, rawName, rawId] = match
    const name = rawName.trim()
    const id = rawId.trim()
    if (!name || !id) continue
    mentions.push({ name, id, start: match.index, end: match.index + full.length })
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
    stripped += text.slice(cursor, match.index)
    stripped += `$${name}`
    cursor = match.index + full.length
  }
  stripped += text.slice(cursor)
  return { mentions, ids, stripped }
}

/** Convenience: `true` when `parseAppMentions(text).mentions.length > 0`. */
export function hasAppMention(text: string): boolean {
  if (!text || text.indexOf("[$") === -1) return false
  const re = new RegExp(APP_MENTION_RE.source, APP_MENTION_RE.flags)
  return re.test(text)
}

