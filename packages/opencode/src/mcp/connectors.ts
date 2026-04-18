/**
 * MCP connectors adapter.
 *
 * Bridges the app directory (`../apps/`) to the MCP tool registry. Given a set
 * of resolved {@link AppInfo} entries and the `Record<string, Tool>` returned
 * by `MCP.Service.tools()`, this module answers:
 *
 *   - which MCP tool keys belong to a given app (because their key is
 *     prefixed with the connector's `mcpServer`);
 *   - which apps have at least one available tool (used to downgrade
 *     unresolved mentions to "not installed" notes);
 *   - what short, human-friendly hint to append to the system prompt so the
 *     model knows exactly which tool names are in scope per app.
 *
 * The module is pure: it takes an already-materialised tool map and returns
 * plain data. The `Service` that owns live MCP clients lives in `mcp/index.ts`.
 */

import type { Tool } from "ai"
import type { AppInfo } from "../apps/directory"

/**
 * Tool keys in `MCP.Service.tools()` are `${sanitize(serverName)}_${sanitize(toolName)}`
 * (see `mcp/index.ts::tools`). We re-implement `sanitize` here to avoid a
 * circular import — it is intentionally trivial.
 */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export interface ResolvedConnector {
  readonly app: AppInfo
  /** MCP tool keys (in the tools map) that belong to this connector. */
  readonly toolKeys: string[]
  /** Raw tool-name segment after the server prefix, for UI hints. */
  readonly toolNames: string[]
  /** Whether any tool for this connector is live. */
  readonly available: boolean
}

export interface ConnectorResolution {
  /** Connectors with at least one matching tool. */
  readonly ready: ResolvedConnector[]
  /** Connectors whose `mcpServer` is declared but has no live tools. */
  readonly pending: ResolvedConnector[]
  /**
   * Tool keys that belong to any resolved connector — useful if the caller
   * wants to build a filtered tool map containing only connector tools.
   */
  readonly toolKeys: Set<string>
}

/**
 * Match tool keys from `tools` against every app's `mcpServer` prefix.
 * `tools` is the shape returned by `MCP.Service.tools()`.
 */
export function resolveConnectors(
  apps: ReadonlyArray<AppInfo>,
  tools: Record<string, Tool>,
): ConnectorResolution {
  const ready: ResolvedConnector[] = []
  const pending: ResolvedConnector[] = []
  const allKeys = new Set<string>()
  const toolKeysList = Object.keys(tools)

  for (const app of apps) {
    if (!app.mcpServer) {
      // Documentation-only app — no MCP binding. Skip entirely.
      continue
    }
    const prefix = sanitize(app.mcpServer) + "_"
    const matched: string[] = []
    const names: string[] = []
    for (const key of toolKeysList) {
      if (key.startsWith(prefix)) {
        matched.push(key)
        names.push(key.slice(prefix.length))
      }
    }
    const connector: ResolvedConnector = {
      app,
      toolKeys: matched,
      toolNames: names,
      available: matched.length > 0,
    }
    if (matched.length > 0) {
      ready.push(connector)
      for (const k of matched) allKeys.add(k)
    } else {
      pending.push(connector)
    }
  }

  return { ready, pending, toolKeys: allKeys }
}

/**
 * Build a filtered tool map containing only the connector tools for the given
 * apps. Order of keys preserved from the input. Callers typically use this to
 * scope a turn's tool set to connectors when mentions are present.
 */
export function filterConnectorTools(
  apps: ReadonlyArray<AppInfo>,
  tools: Record<string, Tool>,
): Record<string, Tool> {
  const { toolKeys } = resolveConnectors(apps, tools)
  const out: Record<string, Tool> = {}
  for (const [key, tool] of Object.entries(tools)) {
    if (toolKeys.has(key)) out[key] = tool
  }
  return out
}

/**
 * Short human-readable hint for the system prompt summarising which connector
 * tools are available. Empty when no connector resolved with live tools.
 */
export function renderConnectorHint(resolution: ConnectorResolution): string {
  if (resolution.ready.length === 0 && resolution.pending.length === 0) return ""
  const lines: string[] = []
  if (resolution.ready.length > 0) {
    lines.push("Connector tools available:")
    for (const c of resolution.ready) {
      const preview = c.toolNames.slice(0, 6).join(", ")
      const more = c.toolNames.length > 6 ? `, +${c.toolNames.length - 6} more` : ""
      lines.push(`- ${c.app.name} (\`${c.app.id}\`): ${preview}${more}`)
    }
  }
  if (resolution.pending.length > 0) {
    lines.push(
      `Connectors referenced but not installed: ${resolution.pending
        .map((c) => `${c.app.name} (\`${c.app.id}\` → \`${c.app.mcpServer}\`)`)
        .join(", ")}. Tools unavailable this turn.`,
    )
  }
  return lines.join("\n")
}

/**
 * Convenience: given an apps directory, a parsed mention list, and the live
 * tools map, produce a full {@link ConnectorResolution}. The apps input is
 * the output of `Apps.resolve(dir, parsed.ids).known`.
 */
export function resolveFromApps(
  apps: ReadonlyArray<AppInfo>,
  tools: Record<string, Tool>,
): ConnectorResolution {
  return resolveConnectors(apps, tools)
}

// --- namespace for ergonomic `import { Connectors } from "..."` ---

export namespace Connectors {
  export type Connector = ResolvedConnector
  export type Resolution = ConnectorResolution
  export const resolve = resolveConnectors
  export const filter = filterConnectorTools
  export const hint = renderConnectorHint
}
