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

import { Effect } from "effect"
import type { Tool, ToolExecutionOptions } from "ai"
import type { AppInfo } from "../apps/directory"
import { Service as MCPService } from "./index"

/**
 * Result of invoking a connector tool via {@link invokeConnector}. Mirrors
 * the `CallToolResult` shape returned by `@modelcontextprotocol/sdk` so the
 * caller does not have to import the MCP SDK types at the callsite.
 */
export interface ConnectorInvocationResult {
  readonly app: AppInfo
  readonly toolKey: string
  readonly toolName: string
  readonly result: unknown
}

export class ConnectorNotResolvedError extends Error {
  readonly _tag = "ConnectorNotResolvedError"
  constructor(
    readonly app: AppInfo,
    readonly toolName: string,
    readonly reason: "no-mcp-server" | "tool-not-found" | "not-executable",
  ) {
    super(`Connector "${app.id}" tool "${toolName}" is not resolved: ${reason}`)
    this.name = "ConnectorNotResolvedError"
  }
}

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

/**
 * Look up the `Tool` in `tools` that belongs to `app.mcpServer` and whose
 * unprefixed name equals `toolName`. Returns `undefined` if the app has no
 * MCP binding or the tool is not live.
 */
export function findConnectorTool(
  app: AppInfo,
  toolName: string,
  tools: Record<string, Tool>,
): { key: string; tool: Tool } | undefined {
  if (!app.mcpServer) return undefined
  const key = sanitize(app.mcpServer) + "_" + sanitize(toolName)
  const tool = tools[key]
  if (!tool) return undefined
  return { key, tool }
}

/**
 * Invoke the connector tool `toolName` for `app` with `args` by routing
 * through `MCP.Service.tools()` and calling the resolved tool's `execute`.
 *
 * This is the runtime wiring that turns a resolved app mention into an
 * actual MCP tool call. The matching logic above (`resolveConnectors`
 * etc.) is pure; this function is the Effect-flavoured I/O edge that
 * reaches into the live MCP client registry.
 *
 * Fails with {@link ConnectorNotResolvedError} when:
 *   - the app lacks an `mcpServer` binding (documentation-only);
 *   - no tool with the expected sanitized key is live;
 *   - the resolved tool has no `execute` (abstract / provider-side).
 *
 * Any error raised by the underlying `execute` is rethrown verbatim so
 * upstream permission / retry handling behaves the same as a regular
 * session tool call.
 */
export function invokeConnector(
  app: AppInfo,
  toolName: string,
  args: Record<string, unknown>,
  options?: Partial<ToolExecutionOptions>,
): Effect.Effect<ConnectorInvocationResult, ConnectorNotResolvedError | Error, MCPService> {
  return Effect.gen(function* () {
    const mcp = yield* MCPService
    const tools = yield* mcp.tools()
    if (!app.mcpServer) return yield* Effect.fail(new ConnectorNotResolvedError(app, toolName, "no-mcp-server"))
    const match = findConnectorTool(app, toolName, tools)
    if (!match) return yield* Effect.fail(new ConnectorNotResolvedError(app, toolName, "tool-not-found"))
    const execute = match.tool.execute
    if (!execute) return yield* Effect.fail(new ConnectorNotResolvedError(app, toolName, "not-executable"))
    const execOpts: ToolExecutionOptions = {
      toolCallId: options?.toolCallId ?? `connector_${app.id}_${Date.now()}`,
      messages: options?.messages ?? [],
      abortSignal: options?.abortSignal ?? new AbortController().signal,
      ...(options ?? {}),
    } as ToolExecutionOptions
    const result = yield* Effect.tryPromise({
      try: () => Promise.resolve(execute(args, execOpts)),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    })
    return { app, toolKey: match.key, toolName, result } satisfies ConnectorInvocationResult
  })
}

// --- namespace for ergonomic `import { Connectors } from "..."` ---

export namespace Connectors {
  export type Connector = ResolvedConnector
  export type Resolution = ConnectorResolution
  export type InvocationResult = ConnectorInvocationResult
  export const resolve = resolveConnectors
  export const filter = filterConnectorTools
  export const hint = renderConnectorHint
  export const findTool = findConnectorTool
  export const invoke = invokeConnector
  export const NotResolvedError = ConnectorNotResolvedError
}
