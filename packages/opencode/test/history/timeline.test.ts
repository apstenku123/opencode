import { expect, test } from "bun:test"
import { changes, view } from "@/history/timeline"
import type { Event } from "@/history"

test("history timeline renders compact items", () => {
  const sessionID = "s-history-timeline"
  const items: Event[] = [
    { ts: 1, type: "session.created", sessionID, title: "demo" },
    { ts: 2, type: "message.created", sessionID, messageID: "m1", role: "user" },
    { ts: 3, type: "tool.state", sessionID, messageID: "m2", partID: "p1", tool: "bash", callID: "c1", state: "completed", title: "ls", output: 3 },
    { ts: 4, type: "autobest.state", sessionID, changed: true, candidates: 2, selected: { key: "best", score: 0.9 } },
  ]

  expect(view(items)).toEqual([
    { ts: 1, type: "session.created", kind: "session", text: "demo" },
    { ts: 2, type: "message.created", kind: "message", text: "user" },
    { ts: 3, type: "tool.state", kind: "tool", text: "ls" },
    { ts: 4, type: "autobest.state", kind: "autobest", text: "best" },
  ])
})

test("history timeline extracts code change summaries with deltas and trend", () => {
  const sessionID = "s-history-changes"
  const items: Event[] = [
    { ts: 1, type: "session.created", sessionID },
    { ts: 2, type: "session.summary.updated", sessionID, summary: { files: 2, additions: 8, deletions: 3 } },
    { ts: 3, type: "session.summary.updated", sessionID, summary: null },
    { ts: 4, type: "session.summary.updated", sessionID, summary: { files: 1, additions: 2 } },
    { ts: 5, type: "session.summary.updated", sessionID, summary: { files: 1, additions: 2, deletions: 0 } },
  ]

  expect(changes(items)).toEqual([
    { ts: 2, files: 2, additions: 8, deletions: 3, delta: { files: 2, additions: 8, deletions: 3 }, trend: "start" },
    { ts: 4, files: 1, additions: 2, deletions: 0, delta: { files: -1, additions: -6, deletions: -3 }, trend: "down" },
    { ts: 5, files: 1, additions: 2, deletions: 0, delta: { files: 0, additions: 0, deletions: 0 }, trend: "flat" },
  ])
})
