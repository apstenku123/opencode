/**
 * App registry.
 *
 * Namespace surface for the ChatGPT-style app directory port described in the
 * R6 migration plan §3.4. Combines the static bundled manifest from
 * `./directory.ts` with caller-supplied overrides and exposes a handful of
 * pure helpers used by session prompting and the MCP connector adapter.
 *
 * The registry is intentionally synchronous and stateless — app metadata does
 * not change mid-session, so there is no Effect service here. Dynamic
 * directory fetching (pagination + cache from `codex-rs/connectors`) is
 * deferred per the plan's "low priority / ChatGPT-only" note.
 */

import {
  BUNDLED_APPS,
  bundledAppIds,
  lookupBundledApp,
  mergeAppDirectories,
  normalizeAppId,
  type AppInfo,
} from "./directory"
import {
  hasAppMention,
  isValidAppId,
  parseAppMentions,
  type AppMention as _AppMention,
  type ParsedAppMentions,
} from "./mention"

export namespace Apps {
  export type Info = AppInfo

  /** Alias for the {@link AppMention} type exported from `./mention.ts`. */
  export type Mention = _AppMention

  export type Parsed = ParsedAppMentions

  /** A registry is a name-indexed AppInfo map plus the source ordering. */
  export interface Directory {
    readonly entries: ReadonlyArray<AppInfo>
    readonly byId: ReadonlyMap<string, AppInfo>
  }

  /**
   * Build a {@link Directory} combining the bundled manifest with zero or more
   * caller-supplied overrides. Later overrides win on id collisions.
   */
  export function directory(...overrides: ReadonlyArray<readonly AppInfo[]>): Directory {
    const entries = mergeAppDirectories(...overrides)
    const byId = new Map<string, AppInfo>()
    for (const app of entries) byId.set(app.id, app)
    return { entries, byId }
  }

  /** The bundled-only directory. */
  export function bundled(): Directory {
    return directory()
  }

  /**
   * Look up an app by id (case-insensitive, trimmed). Returns `undefined` when
   * the id is not found in `dir`.
   */
  export function lookup(dir: Directory, id: string): AppInfo | undefined {
    const key = normalizeAppId(id)
    if (!key) return undefined
    return dir.byId.get(key)
  }

  /**
   * Resolve a list of mention ids against `dir`. Returns an object with
   * `known` entries in the order they appeared and `unknown` ids that did not
   * resolve. Input ids are deduplicated and normalised before lookup.
   */
  export function resolve(
    dir: Directory,
    ids: ReadonlyArray<string>,
  ): { known: AppInfo[]; unknown: string[] } {
    const known: AppInfo[] = []
    const unknown: string[] = []
    const seen = new Set<string>()
    for (const raw of ids) {
      const key = normalizeAppId(raw)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const info = dir.byId.get(key)
      if (info) known.push(info)
      else unknown.push(key)
    }
    return { known, unknown }
  }

  /**
   * Convenience: parse `text`, then resolve every mentioned id against `dir`.
   * Equivalent to `resolve(dir, parseAppMentions(text).ids)` but also returns
   * the raw parsed result so callers can reuse offsets / stripped text.
   */
  export function resolveFromText(
    dir: Directory,
    text: string,
  ): { parsed: ParsedAppMentions; known: AppInfo[]; unknown: string[] } {
    const parsed = parseAppMentions(text)
    const res = resolve(dir, parsed.ids)
    return { parsed, ...res }
  }

  /**
   * Render the `## Apps` system-prompt section mirroring the Rust helper at
   * `codex-rs/core/src/apps/render.rs`. We deviate only in the MCP server
   * name: opencode allows any `mcpServer` key, so we list each resolved app
   * with its server instead of referencing the global `codex-apps` constant.
   */
  export function renderAppsSection(resolved: ReadonlyArray<AppInfo>): string {
    if (resolved.length === 0) return ""
    const lines = resolved.map((app) => {
      const server = app.mcpServer ? ` (MCP server: \`${app.mcpServer}\`)` : ""
      const desc = app.description ? ` — ${app.description}` : ""
      return `- \`${app.id}\` — ${app.name}${server}${desc}`
    })
    return [
      "## Apps",
      "Apps are mentioned in user messages in the format `[$app-name](app://{connector_id})`.",
      "Each app exposes its tools through the MCP server noted below. When you see an app mention, prefer that server's tools for the user's request.",
      "",
      ...lines,
    ].join("\n")
  }

  /**
   * Synthetic-part body appended to the user's last message when mentions are
   * present but not all ids resolve. Keeps the model informed without
   * rewriting the user's text.
   */
  export function renderSyntheticNote(
    resolved: ReadonlyArray<AppInfo>,
    unknown: ReadonlyArray<string>,
  ): string {
    if (resolved.length === 0 && unknown.length === 0) return ""
    const parts: string[] = ["[App mentions]"]
    if (resolved.length > 0) {
      parts.push(
        `Resolved: ${resolved
          .map((app) => `${app.name} [${app.id}${app.mcpServer ? ` → ${app.mcpServer}` : ""}]`)
          .join(", ")}.`,
      )
    }
    if (unknown.length > 0) {
      parts.push(
        `Unknown (no directory match): ${unknown.map((id) => `\`${id}\``).join(", ")}. Treat as plain text.`,
      )
    }
    return parts.join(" ")
  }

  // Re-exports for ergonomics.
  export const parse = parseAppMentions
  export const hasMention = hasAppMention
  export const validId = isValidAppId
  export const ids = bundledAppIds
  export const bundledOnly = BUNDLED_APPS
  export const lookupBundled = lookupBundledApp
}

export { parseAppMentions, hasAppMention, isValidAppId } from "./mention"
export {
  BUNDLED_APPS,
  bundledAppIds,
  lookupBundledApp,
  mergeAppDirectories,
  normalizeAppId,
} from "./directory"
export type { AppInfo } from "./directory"
export type { AppMention, ParsedAppMentions } from "./mention"
