/**
 * Bundled app directory.
 *
 * Port of the directory surface from `codex-rs/connectors/src/lib.rs`. The
 * upstream module fetches `/connectors/directory/list` from ChatGPT's backend;
 * because opencode is provider-neutral we instead ship a small static manifest
 * that maps a handful of well-known app ids (`notion`, `github`, `slack`,
 * `linear`, `jira`, ...) to their display metadata and to the MCP server name
 * that hosts the connector's tools.
 *
 * The directory is extensible: callers may supply additional entries via
 * `Apps.Service` (see `apps/index.ts`). Lookup always returns the merged view.
 */

export interface AppInfo {
  /** Stable connector id — the key the mention URL resolves to. */
  readonly id: string
  /** Human-visible label. */
  readonly name: string
  /** One-line description shown in picker UI; optional. */
  readonly description?: string
  /**
   * Name of the MCP server (matching a key in `config.mcp.*`) whose tools
   * implement this connector. When unset the app is a documentation-only
   * placeholder — model sees the mention but has no tools to invoke.
   */
  readonly mcpServer?: string
  /** Optional homepage / install URL for UIs. */
  readonly installUrl?: string
  /** Optional categorical tag (e.g. "productivity", "source-control"). */
  readonly category?: string
}

/**
 * Starter manifest. Ids are lowercase; matching is case-insensitive per the
 * upstream convention (`codex-rs/connectors/src/lib.rs:376 connector_name_slug`).
 */
export const BUNDLED_APPS: readonly AppInfo[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, and pull requests.",
    mcpServer: "github",
    installUrl: "https://chatgpt.com/apps/github/github",
    category: "source-control",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Workspace pages and databases.",
    mcpServer: "notion",
    installUrl: "https://chatgpt.com/apps/notion/notion",
    category: "productivity",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, direct messages, and threads.",
    mcpServer: "slack",
    installUrl: "https://chatgpt.com/apps/slack/slack",
    category: "communication",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, cycles, and projects.",
    mcpServer: "linear",
    installUrl: "https://chatgpt.com/apps/linear/linear",
    category: "productivity",
  },
  {
    id: "jira",
    name: "Jira",
    description: "Atlassian issue tracker.",
    mcpServer: "jira",
    installUrl: "https://chatgpt.com/apps/jira/jira",
    category: "productivity",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Read and send mail.",
    mcpServer: "gmail",
    installUrl: "https://chatgpt.com/apps/gmail/gmail",
    category: "communication",
  },
  {
    id: "gcal",
    name: "Google Calendar",
    description: "Calendars and events.",
    mcpServer: "gcal",
    installUrl: "https://chatgpt.com/apps/google-calendar/gcal",
    category: "productivity",
  },
  {
    id: "gdrive",
    name: "Google Drive",
    description: "Files and folders in Drive.",
    mcpServer: "gdrive",
    installUrl: "https://chatgpt.com/apps/google-drive/gdrive",
    category: "storage",
  },
]

/** Normalise an id for lookup: trim + lower-case. */
export function normalizeAppId(id: string): string {
  return id.trim().toLowerCase()
}

/**
 * Return the bundled app for `id` if one exists. Matching is case-insensitive
 * and trims leading/trailing whitespace. Does not consult any caller-supplied
 * overrides — for that path use `Apps.Service.lookup`.
 */
export function lookupBundledApp(id: string): AppInfo | undefined {
  const key = normalizeAppId(id)
  if (!key) return undefined
  return BUNDLED_APPS.find((app) => app.id === key)
}

/** All bundled ids in manifest order. */
export function bundledAppIds(): string[] {
  return BUNDLED_APPS.map((app) => app.id)
}

/**
 * Merge user-supplied entries into the bundled manifest. Later entries win on
 * id collisions. Returns a fresh array; the bundled constant is never mutated.
 */
export function mergeAppDirectories(...directories: ReadonlyArray<readonly AppInfo[]>): AppInfo[] {
  const merged = new Map<string, AppInfo>()
  for (const app of BUNDLED_APPS) merged.set(app.id, app)
  for (const dir of directories) {
    for (const app of dir) {
      const key = normalizeAppId(app.id)
      if (!key) continue
      merged.set(key, { ...app, id: key })
    }
  }
  // Sort by name then id to match the upstream list_all_connectors ordering.
  return [...merged.values()].sort((l, r) => l.name.localeCompare(r.name) || l.id.localeCompare(r.id))
}
