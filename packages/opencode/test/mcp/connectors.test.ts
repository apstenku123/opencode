import { describe, expect, test } from "bun:test"
import type { Tool } from "ai"
import { Apps } from "@/apps"
import {
  Connectors,
  filterConnectorTools,
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
  })
})
