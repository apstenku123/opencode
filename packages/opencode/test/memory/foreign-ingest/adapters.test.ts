import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import * as Claude from "../../../src/memory/foreign-ingest/adapters/claude"
import * as Cursor from "../../../src/memory/foreign-ingest/adapters/cursor"
import * as Codex from "../../../src/memory/foreign-ingest/adapters/codex"
import {
  computeContentHash,
  fullText,
  lastUserMessage,
} from "../../../src/memory/foreign-ingest/adapters"

let work: string
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "occ-fi-adp-"))
})
afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// shared helpers
// --------------------------------------------------------------------------

describe("adapters/shared", () => {
  test("fullText interleaves turns, marker labels, and tool calls", () => {
    const text = fullText({
      tool: "claude_code",
      sourceID: "s1",
      sourcePath: "/x.jsonl",
      turns: [
        {
          userText: "fix bug",
          assistantText: "fixed",
          toolCalls: [{ name: "Read", args: "main.rs" }],
          hasReasoning: false,
        },
        {
          userText: "test it",
          assistantText: "passes",
          toolCalls: [],
          hasReasoning: true,
          reasoningText: "Let me think...",
        },
      ],
    })
    expect(text).toContain("Turn 1")
    expect(text).toContain("fix bug")
    expect(text).toContain("Tool: Read(main.rs)")
    expect(text).toContain("Turn 2")
    expect(text).toContain("Thinking: Let me think...")
  })

  test("lastUserMessage returns the last turn's user text", () => {
    expect(
      lastUserMessage({
        tool: "claude_code",
        sourceID: "s",
        sourcePath: "/x",
        turns: [
          { userText: "first", assistantText: "", toolCalls: [], hasReasoning: false },
          { userText: "second", assistantText: "", toolCalls: [], hasReasoning: false },
        ],
      }),
    ).toBe("second")
  })

  test("computeContentHash is deterministic for the same file contents", () => {
    const f = path.join(work, "hash-input.txt")
    writeFileSync(f, "hello world")
    const h1 = computeContentHash(f, "hello world")
    const h2 = computeContentHash(f, "hello world")
    expect(h1).toBe(h2)
    expect(h1.length).toBe(64)
  })
})

// --------------------------------------------------------------------------
// Claude
// --------------------------------------------------------------------------

describe("adapters/claude", () => {
  function writeJsonl(p: string, lines: string[]) {
    writeFileSync(p, lines.join("\n"))
  }

  test("parseSession extracts user/assistant turns and detects entrypoint", () => {
    const f = path.join(work, "claude-1.jsonl")
    writeJsonl(f, [
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-06T10:00:00Z",
        message: { role: "user", content: "fix bug" },
        cwd: "/projects/test",
        entrypoint: "cli",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-06T10:00:05Z",
        message: { role: "assistant", content: [{ type: "text", text: "I fixed it" }] },
      }),
    ])
    const session = Claude.parseSession(f)!
    expect(session.tool).toBe("claude_code")
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.userText).toBe("fix bug")
    expect(session.turns[0]!.assistantText).toBe("I fixed it")
    expect(session.cwd).toBe("/projects/test")
  })

  test("parseSession captures thinking blocks as reasoningText", () => {
    const f = path.join(work, "claude-think.jsonl")
    writeJsonl(f, [
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-06T10:00:00Z",
        message: { role: "user", content: "refactor" },
        entrypoint: "cli",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-06T10:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me plan this..." },
            { type: "text", text: "Done" },
          ],
        },
      }),
    ])
    const session = Claude.parseSession(f)!
    expect(session.turns[0]!.hasReasoning).toBe(true)
    expect(session.turns[0]!.reasoningText).toBe("Let me plan this...")
  })

  test("parseSession skips tool_result echoes (type=user with content tool_result)", () => {
    const f = path.join(work, "claude-tool.jsonl")
    writeJsonl(f, [
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-06T10:00:00Z",
        message: { role: "user", content: "hello" },
        entrypoint: "cli",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-06T10:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", id: "t1", input: { path: "/x" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-06T10:00:02Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-06T10:00:03Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done reading" }] },
      }),
    ])
    const session = Claude.parseSession(f)!
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.userText).toBe("hello")
    expect(session.turns[0]!.assistantText).toContain("Done reading")
    expect(session.turns[0]!.toolCalls).toHaveLength(1)
    expect(session.turns[0]!.toolCalls[0]!.name).toBe("Read")
  })

  test("scanProjectsDir finds JSONL sessions across multiple project dirs", () => {
    const root = path.join(work, "claude-projects")
    mkdirSync(path.join(root, "proj-a"), { recursive: true })
    mkdirSync(path.join(root, "proj-b"), { recursive: true })
    const sample = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
      entrypoint: "cli",
    })
    writeFileSync(path.join(root, "proj-a", "s1.jsonl"), sample)
    writeFileSync(path.join(root, "proj-a", "skip.txt"), "")
    writeFileSync(path.join(root, "proj-b", "s2.jsonl"), sample)
    const found = Claude.scanProjectsDir(root)
    expect(found).toHaveLength(2)
    expect(found.every((d) => d.tool === "claude_code")).toBe(true)
  })

  test("scanProjectsDir labels claude-vscode entrypoint as claude_ext", () => {
    const root = path.join(work, "claude-ext")
    mkdirSync(path.join(root, "ext-proj"), { recursive: true })
    writeFileSync(
      path.join(root, "ext-proj", "ext.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: "/test",
        entrypoint: "claude-vscode",
        message: { role: "user", content: "hi" },
      }),
    )
    const found = Claude.scanProjectsDir(root)
    expect(found).toHaveLength(1)
    expect(found[0]!.tool).toBe("claude_ext")
  })

  test("parseSession returns undefined for empty file", () => {
    const f = path.join(work, "empty.jsonl")
    writeFileSync(f, "")
    expect(Claude.parseSession(f)).toBeUndefined()
  })
})

// --------------------------------------------------------------------------
// Cursor
// --------------------------------------------------------------------------

describe("adapters/cursor", () => {
  test("stripUserQueryTags removes wrapping but leaves bare text alone", () => {
    expect(Cursor.stripUserQueryTags("<user_query>fix the bug</user_query>")).toBe("fix the bug")
    expect(Cursor.stripUserQueryTags("no tags here")).toBe("no tags here")
  })

  test("parseSession extracts multi-turn exchanges and strips wrappers", () => {
    const f = path.join(work, "cursor-multi.jsonl")
    writeFileSync(
      f,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "<user_query>refactor auth</user_query>" }] },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "Refactored auth." }] },
        }),
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "<user_query>add tests</user_query>" }] },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "Tests added." }] },
        }),
      ].join("\n"),
    )
    const session = Cursor.parseSession(f)!
    expect(session.turns).toHaveLength(2)
    expect(session.turns[0]!.userText).toBe("refactor auth")
    expect(session.turns[1]!.userText).toBe("add tests")
    expect(session.turns[1]!.assistantText).toBe("Tests added.")
  })

  test("parseSession returns undefined for empty file", () => {
    const f = path.join(work, "cursor-empty.jsonl")
    writeFileSync(f, "")
    expect(Cursor.parseSession(f)).toBeUndefined()
  })

  test("parseSession skips malformed lines", () => {
    const f = path.join(work, "cursor-malformed.jsonl")
    writeFileSync(
      f,
      [
        "not json at all",
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      ].join("\n"),
    )
    const session = Cursor.parseSession(f)!
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.userText).toBe("hello")
  })
})

// --------------------------------------------------------------------------
// Codex
// --------------------------------------------------------------------------

describe("adapters/codex", () => {
  test("parseRolloutSessionID recovers full UUID from real-world stem", () => {
    const stem = "rollout-2026-04-10T21-30-00-0191e3de-7f8a-4c32-9abd-cb3fa2e9bc4e"
    expect(Codex.parseRolloutSessionID(stem)).toBe("0191e3de-7f8a-4c32-9abd-cb3fa2e9bc4e")
  })

  test("parseRolloutSessionID rejects partial trailing token", () => {
    const stem = "rollout-2026-04-10-bc4e"
    expect(Codex.parseRolloutSessionID(stem)).not.toBe("bc4e")
  })

  test("parseRolloutSessionID returns undefined when prefix is missing", () => {
    expect(Codex.parseRolloutSessionID("not-a-rollout")).toBeUndefined()
  })

  test("parseRollout extracts cwd from session_meta and turns", () => {
    const f = path.join(work, "rollout-2026-04-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")
    writeFileSync(
      f,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "abc-123", cwd: "/projects/test", timestamp: "2026-04-06T10:00:00Z" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { role: "user", content: [{ type: "input_text", text: "fix bug" }] },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { role: "assistant", content: [{ type: "text", text: "fixed" }] },
        }),
      ].join("\n"),
    )
    const session = Codex.parseRollout(f)!
    expect(session.tool).toBe("codex")
    expect(session.sourceID).toBe("abc-123")
    expect(session.cwd).toBe("/projects/test")
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.userText).toBe("fix bug")
  })

  test("scanSessionsDir terminates on symlink loops", () => {
    const root = mkdtempSync(path.join(tmpdir(), "occ-fi-codex-"))
    const day = path.join(root, "sessions", "2026", "04", "15")
    mkdirSync(day, { recursive: true })
    const rollout = path.join(
      day,
      "rollout-2026-04-15T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    )
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } }))
    // Symlink loop back to sessions root.
    try {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs")
      symlinkSync(path.join(root, "sessions"), path.join(day, "cycle"))
    } catch {
      // Skip on platforms where symlink isn't permitted (e.g. Windows non-admin).
      rmSync(root, { recursive: true, force: true })
      return
    }
    const found = Codex.scanSessionsDir(root)
    expect(found).toHaveLength(1)
    expect(found[0]!.sourcePath).toBe(rollout)
    rmSync(root, { recursive: true, force: true })
  })
})
