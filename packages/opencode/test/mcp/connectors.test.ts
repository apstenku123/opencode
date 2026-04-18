import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Tool } from "ai"
import { Apps } from "@/apps"
import { MCP } from "@/mcp"
import {
  Connectors,
  ConnectorNotResolvedError,
  filterConnectorTools,
  findConnectorTool,
  invokeConnector,
  renderConnectorHint,
  resolveConnectors,
  resolveFromApps,
} from "@/mcp/connectors"

function fakeTool(name: string): Tool {
  return {
    description: `fake:${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
  } as unknown as Tool
}

function toolsMap(keys: string[]): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const k of keys) out[k] = fakeTool(k)
  return out
}

describe("mcp/connectors - resolveConnectors", () => {
  test("matches tool keys by sanitized mcpServer prefix", () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    const tools = toolsMap([
      "github_list_repos",
      "github_open_pr",
      "slack_post_message",
      "unrelated_tool",
    ])
    const res = resolveConnectors([gh], tools)
    expect(res.ready).toHaveLength(1)
    expect(res.ready[0].app.id).toBe("github")
    expect(res.ready[0].toolKeys.sort()).toEqual(["github_list_repos", "github_open_pr"])
    expect(res.ready[0].toolNames.sort()).toEqual(["list_repos", "open_pr"])
    expect(res.pending).toHaveLength(0)
  })

  test("marks apps with no live tools as pending", () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    const slack = dir.byId.get("slack")!
    const tools = toolsMap(["github_list_repos"])
    const res = resolveConnectors([gh, slack], tools)
    expect(res.ready.map((c) => c.app.id)).toEqual(["github"])
    expect(res.pending.map((c) => c.app.id)).toEqual(["slack"])
  })

  test("skips documentation-only apps without mcpServer", () => {
    const docOnly = { id: "docapp", name: "DocApp" }
    const res = resolveConnectors([docOnly], toolsMap(["docapp_anything"]))
    expect(res.ready).toHaveLength(0)
    expect(res.pending).toHaveLength(0)
  })

  test("toolKeys union covers every resolved connector", () => {
    const dir = Apps.bundled()
    const tools = toolsMap(["github_a", "github_b", "slack_x", "extra"])
    const res = resolveConnectors([dir.byId.get("github")!, dir.byId.get("slack")!], tools)
    expect([...res.toolKeys].sort()).toEqual(["github_a", "github_b", "slack_x"])
  })

  test("resolveFromApps is an alias for resolveConnectors", () => {
    const dir = Apps.bundled()
    const tools = toolsMap(["github_a"])
    const a = resolveConnectors([dir.byId.get("github")!], tools)
    const b = resolveFromApps([dir.byId.get("github")!], tools)
    expect(a.ready.map((c) => c.toolKeys)).toEqual(b.ready.map((c) => c.toolKeys))
  })
})

describe("mcp/connectors - filterConnectorTools", () => {
  test("keeps only tools belonging to resolved connectors", () => {
    const dir = Apps.bundled()
    const tools = toolsMap(["github_a", "slack_b", "random_c"])
    const filtered = filterConnectorTools([dir.byId.get("github")!], tools)
    expect(Object.keys(filtered).sort()).toEqual(["github_a"])
  })

  test("returns an empty object when nothing matches", () => {
    const dir = Apps.bundled()
    const filtered = filterConnectorTools([dir.byId.get("github")!], toolsMap(["random"]))
    expect(filtered).toEqual({})
  })
})

describe("mcp/connectors - renderConnectorHint", () => {
  test("returns empty string when no connectors are present", () => {
    expect(renderConnectorHint({ ready: [], pending: [], toolKeys: new Set() })).toBe("")
  })

  test("lists ready connectors with previewed tool names", () => {
    const dir = Apps.bundled()
    const tools = toolsMap(["github_a", "github_b"])
    const res = resolveConnectors([dir.byId.get("github")!], tools)
    const hint = renderConnectorHint(res)
    expect(hint).toContain("Connector tools available")
    expect(hint).toContain("GitHub")
    expect(hint).toContain("a")
    expect(hint).toContain("b")
  })

  test("lists pending connectors separately", () => {
    const dir = Apps.bundled()
    const res = resolveConnectors([dir.byId.get("slack")!], toolsMap([]))
    const hint = renderConnectorHint(res)
    expect(hint).toContain("not installed")
    expect(hint).toContain("Slack")
  })

  test("truncates long tool-name lists", () => {
    const dir = Apps.bundled()
    const keys = Array.from({ length: 10 }).map((_, i) => `github_t${i}`)
    const res = resolveConnectors([dir.byId.get("github")!], toolsMap(keys))
    const hint = renderConnectorHint(res)
    expect(hint).toContain("+4 more")
  })
})

describe("mcp/connectors - Connectors namespace", () => {
  test("re-exports the core helpers", () => {
    expect(typeof Connectors.resolve).toBe("function")
    expect(typeof Connectors.filter).toBe("function")
    expect(typeof Connectors.hint).toBe("function")
    expect(typeof Connectors.findTool).toBe("function")
    expect(typeof Connectors.invoke).toBe("function")
  })
})

// --- findConnectorTool ---

describe("mcp/connectors - findConnectorTool", () => {
  test("locates the tool by sanitized `<server>_<name>` key", () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    const tools = toolsMap(["github_list_repos", "slack_post"])
    const hit = findConnectorTool(gh, "list_repos", tools)
    expect(hit?.key).toBe("github_list_repos")
    expect(hit?.tool).toBe(tools["github_list_repos"])
  })

  test("returns undefined when the app has no mcpServer binding", () => {
    const docOnly = { id: "docapp", name: "DocApp" }
    expect(findConnectorTool(docOnly, "any", toolsMap(["docapp_any"]))).toBeUndefined()
  })

  test("returns undefined when no matching tool exists", () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    expect(findConnectorTool(gh, "unknown", toolsMap(["github_other"]))).toBeUndefined()
  })
})

// --- invokeConnector ---

/**
 * Minimal in-memory MCP Service stub: only needs `tools()` for
 * invokeConnector. All other methods throw on access so a regression
 * that expands the invocation surface is caught immediately.
 */
function mockMcpLayer(tools: Record<string, Tool>) {
  const stub = new Proxy(
    {
      tools: () => Effect.succeed(tools),
    },
    {
      get(target, prop: string) {
        const val = (target as Record<string, unknown>)[prop]
        if (val !== undefined) return val
        throw new Error(`mock MCP.Service: unexpected access to "${prop}"`)
      },
    },
  ) as unknown as MCP.Interface
  return Layer.succeed(MCP.Service, stub)
}

describe("mcp/connectors - invokeConnector", () => {
  test("calls the resolved tool's execute with the supplied args", async () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    const calls: Array<{ args: unknown }> = []
    const tool: Tool = {
      description: "create issue",
      inputSchema: { type: "object", properties: {} },
      execute: async (args: unknown) => {
        calls.push({ args })
        return { content: [{ type: "text", text: "ok" }] }
      },
    } as unknown as Tool
    const tools: Record<string, Tool> = { github_create_issue: tool }
    const result = await Effect.runPromise(
      invokeConnector(gh, "create_issue", { title: "bug", body: "repro" }).pipe(Effect.provide(mockMcpLayer(tools))),
    )
    expect(result.app.id).toBe("github")
    expect(result.toolKey).toBe("github_create_issue")
    expect(result.toolName).toBe("create_issue")
    expect((result.result as { content: { text: string }[] }).content[0].text).toBe("ok")
    expect(calls).toHaveLength(1)
    expect((calls[0].args as { title: string }).title).toBe("bug")
  })

  test("fails with ConnectorNotResolvedError when the app has no mcpServer", async () => {
    const docOnly = { id: "docapp", name: "DocApp" }
    await Effect.runPromise(
      invokeConnector(docOnly, "anything", {}).pipe(
        Effect.catch((e) => {
          expect(e).toBeInstanceOf(ConnectorNotResolvedError)
          expect((e as ConnectorNotResolvedError).reason).toBe("no-mcp-server")
          return Effect.void
        }),
        Effect.provide(mockMcpLayer({})),
      ),
    )
  })

  test("fails with ConnectorNotResolvedError when the tool is not live", async () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    await Effect.runPromise(
      invokeConnector(gh, "missing", {}).pipe(
        Effect.catch((e) => {
          expect(e).toBeInstanceOf(ConnectorNotResolvedError)
          expect((e as ConnectorNotResolvedError).reason).toBe("tool-not-found")
          return Effect.void
        }),
        Effect.provide(mockMcpLayer({ slack_post: fakeTool("slack_post") })),
      ),
    )
  })

  test("fails with ConnectorNotResolvedError when the tool has no execute", async () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    const toolNoExec = {
      description: "abstract",
      inputSchema: { type: "object", properties: {} },
    } as unknown as Tool
    await Effect.runPromise(
      invokeConnector(gh, "abstract", {}).pipe(
        Effect.catch((e) => {
          expect(e).toBeInstanceOf(ConnectorNotResolvedError)
          expect((e as ConnectorNotResolvedError).reason).toBe("not-executable")
          return Effect.void
        }),
        Effect.provide(mockMcpLayer({ github_abstract: toolNoExec })),
      ),
    )
  })

  test("rethrows errors from the underlying tool execute", async () => {
    const dir = Apps.bundled()
    const gh = dir.byId.get("github")!
    const tool: Tool = {
      description: "failing",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("upstream failure")
      },
    } as unknown as Tool
    await Effect.runPromise(
      invokeConnector(gh, "broken", {}).pipe(
        Effect.catch((e) => {
          expect(e).toBeInstanceOf(Error)
          expect((e as Error).message).toContain("upstream failure")
          return Effect.void
        }),
        Effect.provide(mockMcpLayer({ github_broken: tool })),
      ),
    )
  })
})
