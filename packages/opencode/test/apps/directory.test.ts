import { describe, expect, test } from "bun:test"
import {
  Apps,
  BUNDLED_APPS,
  bundledAppIds,
  lookupBundledApp,
  mergeAppDirectories,
  normalizeAppId,
  type AppInfo,
} from "@/apps"

describe("apps/directory - bundled manifest", () => {
  test("ships a non-empty manifest with unique, well-formed ids", () => {
    expect(BUNDLED_APPS.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const app of BUNDLED_APPS) {
      expect(ids.has(app.id)).toBe(false)
      ids.add(app.id)
      expect(app.id).toBe(app.id.toLowerCase())
      expect(app.name.length).toBeGreaterThan(0)
    }
  })

  test("exposes a GitHub entry with a concrete mcpServer binding", () => {
    const gh = lookupBundledApp("github")
    expect(gh?.name).toBe("GitHub")
    expect(gh?.mcpServer).toBe("github")
  })

  test("lookup is case-insensitive and trims whitespace", () => {
    expect(lookupBundledApp("  GITHUB  ")?.id).toBe("github")
    expect(lookupBundledApp("")).toBeUndefined()
    expect(lookupBundledApp("does-not-exist")).toBeUndefined()
  })

  test("normalizeAppId strips spaces and lowers case", () => {
    expect(normalizeAppId("  GitHub ")).toBe("github")
    expect(normalizeAppId("")).toBe("")
  })

  test("bundledAppIds returns ids in manifest order", () => {
    const ids = bundledAppIds()
    expect(ids.length).toBe(BUNDLED_APPS.length)
    expect(ids[0]).toBe(BUNDLED_APPS[0].id)
  })
})

describe("apps/directory - mergeAppDirectories", () => {
  test("overrides bundled entries when a custom app shares an id", () => {
    const custom: AppInfo[] = [
      { id: "github", name: "GHE", description: "GitHub Enterprise" },
    ]
    const merged = mergeAppDirectories(custom)
    const gh = merged.find((a) => a.id === "github")
    expect(gh?.name).toBe("GHE")
    expect(gh?.description).toBe("GitHub Enterprise")
  })

  test("appends new ids without mutating the bundled constant", () => {
    const before = [...BUNDLED_APPS]
    const merged = mergeAppDirectories([{ id: "custom", name: "Custom" }])
    expect(merged.some((a) => a.id === "custom")).toBe(true)
    expect([...BUNDLED_APPS]).toEqual(before)
  })

  test("ignores empty-id overrides", () => {
    const merged = mergeAppDirectories([{ id: "  ", name: "Bad" }])
    expect(merged.some((a) => a.name === "Bad")).toBe(false)
  })

  test("normalises override ids to lowercase", () => {
    const merged = mergeAppDirectories([{ id: "CUSTOM", name: "Up" }])
    expect(merged.find((a) => a.id === "custom")).toBeDefined()
    expect(merged.find((a) => a.id === "CUSTOM")).toBeUndefined()
  })
})

describe("apps - Apps.directory / lookup / resolve", () => {
  test("directory() returns a map indexed by id", () => {
    const dir = Apps.bundled()
    expect(dir.byId.get("github")?.name).toBe("GitHub")
    expect(dir.entries.length).toBe(BUNDLED_APPS.length)
  })

  test("lookup() returns undefined for missing or empty ids", () => {
    const dir = Apps.bundled()
    expect(Apps.lookup(dir, "github")?.id).toBe("github")
    expect(Apps.lookup(dir, "does-not-exist")).toBeUndefined()
    expect(Apps.lookup(dir, "")).toBeUndefined()
  })

  test("resolve() partitions known and unknown ids in input order", () => {
    const dir = Apps.bundled()
    const res = Apps.resolve(dir, ["notion", "github", "unknownapp", "notion"])
    expect(res.known.map((a) => a.id)).toEqual(["notion", "github"])
    expect(res.unknown).toEqual(["unknownapp"])
  })

  test("resolveFromText parses then resolves in one call", () => {
    const dir = Apps.bundled()
    const r = Apps.resolveFromText(
      dir,
      "use [$Notion](app://notion) and [$X](app://xunknown)",
    )
    expect(r.parsed.ids).toEqual(["notion", "xunknown"])
    expect(r.known.map((a) => a.id)).toEqual(["notion"])
    expect(r.unknown).toEqual(["xunknown"])
  })

  test("renderAppsSection returns empty string when no apps", () => {
    expect(Apps.renderAppsSection([])).toBe("")
  })

  test("renderAppsSection lists resolved apps with mcp server hints", () => {
    const dir = Apps.bundled()
    const rendered = Apps.renderAppsSection([dir.byId.get("github")!, dir.byId.get("slack")!])
    expect(rendered).toContain("## Apps")
    expect(rendered).toContain("github")
    expect(rendered).toContain("MCP server")
    expect(rendered).toContain("slack")
  })

  test("renderSyntheticNote lists known and unknown segments only when non-empty", () => {
    const dir = Apps.bundled()
    const note = Apps.renderSyntheticNote([dir.byId.get("github")!], ["xxx"])
    expect(note).toContain("Resolved")
    expect(note).toContain("GitHub")
    expect(note).toContain("Unknown")
    expect(note).toContain("xxx")
    expect(Apps.renderSyntheticNote([], [])).toBe("")
  })
})
