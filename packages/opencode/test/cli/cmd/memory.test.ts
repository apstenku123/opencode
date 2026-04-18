import { describe, expect, test } from "bun:test"

import { INGEST_TOOLS, sourcesForTool } from "../../../src/cli/cmd/memory"

describe("cli/cmd/memory/sourcesForTool", () => {
  test("claude routes to claudeProjectsDir", () => {
    expect(sourcesForTool("claude", "/tmp/p")).toEqual({ claudeProjectsDir: "/tmp/p" })
  })
  test("claude_ext shares the claudeProjectsDir entry", () => {
    expect(sourcesForTool("claude_ext", "/tmp/p")).toEqual({ claudeProjectsDir: "/tmp/p" })
  })
  test("cursor routes to cursorDir", () => {
    expect(sourcesForTool("cursor", "/tmp/c")).toEqual({ cursorDir: "/tmp/c" })
  })
  test("codex routes to codexDir", () => {
    expect(sourcesForTool("codex", "/tmp/x")).toEqual({ codexDir: "/tmp/x" })
  })
  test("kiro routes to kiroDbPath", () => {
    expect(sourcesForTool("kiro", "/tmp/k.sqlite")).toEqual({ kiroDbPath: "/tmp/k.sqlite" })
  })
  test("opencode routes to opencodeSelf", () => {
    expect(sourcesForTool("opencode", "")).toEqual({ opencodeSelf: true })
  })
  test("INGEST_TOOLS covers every branch without gaps", () => {
    // Mostly a guard against a new tool being added without CLI coverage.
    expect([...INGEST_TOOLS].sort()).toEqual([
      "claude",
      "claude_ext",
      "codex",
      "cursor",
      "kiro",
      "opencode",
    ])
  })
})
