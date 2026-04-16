import { expect, test } from "bun:test"
import { append, exists, file, last, read, readByType, type Event } from "@/history"
import { session as kb, view, query, searchSession } from "@/history/kb"
import { session as analytics, view as metrics } from "@/history/analytics"
import { rm } from "node:fs/promises"

async function clean(sessionID: string) {
  await rm(file(sessionID), { force: true }).catch(() => undefined)
}

test("history append writes jsonl event", async () => {
  const sessionID = "s-history-append"
  await clean(sessionID)
  const event: Event = { ts: 1, type: "session.created", sessionID, title: "A" }
  await append(sessionID, event)
  expect(await exists(sessionID)).toBe(true)
  const items = await read(sessionID)
  expect(items).toEqual([event])
})

test("history read preserves append order", async () => {
  const sessionID = "s-history-order"
  await clean(sessionID)
  const items: Event[] = [
    { ts: 1, type: "session.created", sessionID, title: "A" },
    { ts: 2, type: "session.summary.updated", sessionID, summary: { files: 1 } },
    { ts: 3, type: "session.summary.updated", sessionID, summary: null },
  ]
  for (const item of items) await append(sessionID, item)
  expect(await read(sessionID)).toEqual(items)
})

test("history read returns empty for missing file", async () => {
  const sessionID = "s-history-missing"
  await clean(sessionID)
  expect(await read(sessionID)).toEqual([])
})

test("history read ignores malformed lines", async () => {
  const sessionID = "s-history-bad"
  await clean(sessionID)
  await Bun.write(file(sessionID), "not-json\n" + JSON.stringify({ ts: 1, type: "session.created", sessionID }) + "\n")
  expect(await read(sessionID)).toEqual([{ ts: 1, type: "session.created", sessionID }])
})

test("history readByType filters by event kind", async () => {
  const sessionID = "s-history-filter"
  await clean(sessionID)
  await append(sessionID, { ts: 1, type: "session.created", sessionID, title: "A" })
  await append(sessionID, { ts: 2, type: "message.created", sessionID, messageID: "m1", role: "user" })
  await append(sessionID, { ts: 3, type: "message.created", sessionID, messageID: "m2", role: "assistant" })
  expect(await readByType(sessionID, "message.created")).toEqual([
    { ts: 2, type: "message.created", sessionID, messageID: "m1", role: "user" },
    { ts: 3, type: "message.created", sessionID, messageID: "m2", role: "assistant" },
  ])
})

test("history last returns latest event by kind", async () => {
  const sessionID = "s-history-last"
  await clean(sessionID)
  await append(sessionID, { ts: 1, type: "message.part.created", sessionID, messageID: "m1", partID: "p1", partType: "text" })
  await append(sessionID, { ts: 2, type: "message.part.created", sessionID, messageID: "m1", partID: "p2", partType: "tool" })
  expect(await last(sessionID, "message.part.created")).toEqual({
    ts: 2,
    type: "message.part.created",
    sessionID,
    messageID: "m1",
    partID: "p2",
    partType: "tool",
  })
})

test("history kb summarizes counts and latest prompt/tool signals", async () => {
  const sessionID = "s-history-kb"
  await clean(sessionID)
  await append(sessionID, { ts: 1, type: "message.created", sessionID, messageID: "m1", role: "user" })
  await append(sessionID, { ts: 2, type: "tool.state", sessionID, messageID: "m2", partID: "p1", tool: "bash", callID: "c1", state: "running" })
  await append(sessionID, {
    ts: 3,
    type: "prompt.reminder.inserted",
    sessionID,
    messageID: "m1",
    agent: "plan",
    kind: "plan_prompt",
    source: "agent_match",
    synthetic: true,
  })
  const view = await kb(sessionID)
  expect(view.counts.messages_created).toBe(1)
  expect(view.counts.tool_states).toBe(1)
  expect(view.counts.prompt_reminders).toBe(1)
  expect(view.latest.tool?.type).toBe("tool.state")
  expect(view.latest.reminder?.type).toBe("prompt.reminder.inserted")
})



test("history kb view summarizes in-memory items", () => {
  const sessionID = "s-history-kb-view"
  const items: Event[] = [
    { ts: 1, type: "message.created", sessionID, messageID: "m1", role: "user" },
    { ts: 2, type: "tool.state", sessionID, messageID: "m2", partID: "p1", tool: "task", callID: "t1", state: "running", title: "plan" },
    { ts: 3, type: "prompt.subtask.state_changed", sessionID, messageID: "m2", callID: "t1", agent: "task", status: "completed", description: "plan" },
  ]
  const x = view(items)
  expect(x.counts.messages_created).toBe(1)
  expect(x.counts.tool_states).toBe(1)
  expect(x.counts.prompt_subtasks).toBe(1)
  expect(x.latest.subtask).toEqual({
    ts: 3,
    type: "prompt.subtask.state_changed",
    sessionID,
    messageID: "m2",
    callID: "t1",
    agent: "task",
    status: "completed",
    description: "plan",
  })
})

test("history kb prefers explicit observer shell and subtask events", async () => {
  const sessionID = "s-history-kb-explicit"
  await clean(sessionID)
  await append(sessionID, {
    ts: 1,
    type: "tool.state",
    sessionID,
    messageID: "m1",
    partID: "p1",
    tool: "task",
    callID: "t1",
    state: "running",
    title: "draft",
  })
  await append(sessionID, {
    ts: 2,
    type: "tool.state",
    sessionID,
    messageID: "m2",
    partID: "p2",
    tool: "bash",
    callID: "b1",
    state: "running",
    output: 1,
  })
  await append(sessionID, {
    ts: 3,
    type: "prompt.subtask.state_changed",
    sessionID,
    messageID: "m1",
    callID: "t1",
    agent: "task",
    status: "completed",
    description: "draft",
  })
  await append(sessionID, {
    ts: 4,
    type: "prompt.shell.state_changed",
    sessionID,
    messageID: "m2",
    callID: "b1",
    cwd: "/tmp",
    shell: "zsh",
    status: "completed",
  })
  const x = await kb(sessionID)
  expect(x.latest.subtask).toEqual({
    ts: 3,
    type: "prompt.subtask.state_changed",
    sessionID,
    messageID: "m1",
    callID: "t1",
    agent: "task",
    status: "completed",
    description: "draft",
  })
  expect(x.latest.shell).toEqual({
    ts: 4,
    type: "prompt.shell.state_changed",
    sessionID,
    messageID: "m2",
    callID: "b1",
    cwd: "/tmp",
    shell: "zsh",
    status: "completed",
  })
})

test("history analytics summarizes durable history", async () => {
  const sessionID = "s-history-analytics"
  await clean(sessionID)
  await append(sessionID, { ts: 1, type: "session.created", sessionID, title: "A" })
  await append(sessionID, { ts: 2, type: "session.summary.updated", sessionID, summary: { files: 2 } })
  await append(sessionID, { ts: 3, type: "tool.state", sessionID, messageID: "m1", partID: "p1", tool: "task", callID: "t1", state: "running" })
  await append(sessionID, { ts: 4, type: "tool.state", sessionID, messageID: "m2", partID: "p2", tool: "task", callID: "t2", state: "error", interrupted: true })
  await append(sessionID, { ts: 5, type: "tool.state", sessionID, messageID: "m3", partID: "p3", tool: "bash", callID: "b1", state: "completed" })
  await append(sessionID, { ts: 6, type: "prompt.subtask.state_changed", sessionID, messageID: "m2", callID: "t2", agent: "task", status: "error", description: "draft" })
  await append(sessionID, { ts: 7, type: "prompt.shell.state_changed", sessionID, messageID: "m3", callID: "b1", cwd: "/tmp", shell: "zsh", status: "completed" })
  await append(sessionID, { ts: 8, type: "step.finish", sessionID, messageID: "m3", reason: "stop", cost: 1.5, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 }, total: 18 } })
  const x = await analytics(sessionID)
  expect(x.total).toBe(8)
  expect(x.sessions).toEqual({ created: 1, forked: 0, summarized: 1 })
  expect(x.tools.total).toBe(3)
  expect(x.tools.by_name).toEqual({ task: 2, bash: 1 })
  expect(x.tools.by_state).toEqual({ running: 1, error: 1, completed: 1 })
  expect(x.tools.interrupted).toBe(1)
  expect(x.tools.task.by_state).toEqual({ running: 1, error: 1 })
  expect(x.tools.bash.by_state).toEqual({ completed: 1 })
  expect(x.prompts).toEqual({ reminders: 0, subtasks: 1, shells: 1 })
  expect(x.steps).toEqual({
    total: 1,
    cost: 1.5,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 }, total: 18 },
    by_reason: { stop: 1 },
  })
  expect(x.latest.tool?.callID).toBe("b1")
  expect(x.latest.step?.messageID).toBe("m3")
  expect(x.latest.subtask?.callID).toBe("t2")
  expect(x.latest.shell?.callID).toBe("b1")
})

test("history kb keeps latest explicit reminder", () => {
  const sessionID = "s-history-kb-reminder"
  const items: Event[] = [
    { ts: 1, type: "prompt.reminder.inserted", sessionID, messageID: "m1", agent: "plan", kind: "plan_prompt", source: "agent_match", synthetic: true },
    { ts: 2, type: "prompt.reminder.inserted", sessionID, messageID: "m2", agent: "plan", kind: "plan_mode", source: "agent_match", synthetic: true },
  ]
  const x = view(items)
  expect(x.latest.reminder?.messageID).toBe("m2")
  expect(x.counts.prompt_reminders).toBe(2)
})

test("history analytics ignores unrelated prompt counters when only tool states exist", () => {
  const sessionID = "s-history-analytics-tools-only"
  const items: Event[] = [
    { ts: 1, type: "tool.state", sessionID, messageID: "m1", partID: "p1", tool: "bash", callID: "b1", state: "running" },
    { ts: 2, type: "tool.state", sessionID, messageID: "m1", partID: "p1", tool: "bash", callID: "b1", state: "completed" },
  ]
  const x = metrics(items)
  expect(x.prompts).toEqual({ reminders: 0, subtasks: 0, shells: 0 })
  expect(x.tools.by_state).toEqual({ running: 1, completed: 1 })
})

test("history analytics summarizes in-memory items", () => {
  const sessionID = "s-history-analytics-view"
  const items: Event[] = [
    { ts: 1, type: "session.created", sessionID },
    { ts: 2, type: "tool.state", sessionID, messageID: "m1", partID: "p1", tool: "bash", callID: "b1", state: "running" },
    { ts: 3, type: "prompt.reminder.inserted", sessionID, messageID: "m1", agent: "plan", kind: "plan_prompt", source: "agent_match", synthetic: true },
    { ts: 4, type: "step.finish", sessionID, messageID: "m1", reason: "stop", cost: 2, tokens: { input: 4, output: 3, reasoning: 1, cache: { read: 0, write: 1 }, total: 9 } },
  ]
  const x = metrics(items)
  expect(x.total).toBe(4)
  expect(x.sessions.created).toBe(1)
  expect(x.tools.by_name).toEqual({ bash: 1 })
  expect(x.prompts.reminders).toBe(1)
  expect(x.steps.cost).toBe(2)
  expect(x.steps.by_reason).toEqual({ stop: 1 })
  expect(x.latest.tool?.callID).toBe("b1")
})

test("history kb derives subtask and shell context from tool.state events", async () => {
  const sessionID = "s-history-kb-compact"
  await clean(sessionID)
  await append(sessionID, {
    ts: 1,
    type: "tool.state",
    sessionID,
    messageID: "m1",
    partID: "p1",
    tool: "task",
    callID: "t1",
    state: "error",
    error: "boom",
  })
  await append(sessionID, {
    ts: 2,
    type: "tool.state",
    sessionID,
    messageID: "m2",
    partID: "p2",
    tool: "bash",
    callID: "b1",
    state: "error",
    interrupted: true,
    output: 42,
  })
  const view = await kb(sessionID)
  expect(view.latest.subtask).toEqual({
    ts: 1,
    sessionID,
    messageID: "m1",
    callID: "t1",
    status: "error",
    title: undefined,
    error: "boom",
    interrupted: undefined,
  })
  expect(view.latest.shell).toEqual({
    ts: 2,
    sessionID,
    messageID: "m2",
    callID: "b1",
    status: "aborted",
    title: undefined,
    error: undefined,
    output: 42,
  })
})

test("history search queries in-memory items", () => {
  const sessionID = "s-history-search-view"
  const items: Event[] = [
    { ts: 1, type: "tool.state", sessionID, messageID: "m1", partID: "p1", tool: "bash", callID: "b1", state: "error", error: "boom" },
    { ts: 2, type: "prompt.subtask.state_changed", sessionID, messageID: "m2", callID: "t1", agent: "task", status: "completed", description: "draft report" },
    { ts: 3, type: "autobest.state", sessionID, changed: true, candidates: 2, selected: { key: "gpt-5", score: 0.9, reason: ["fast"] } },
  ]
  expect(query(items, "boom").map((item) => item.type)).toEqual(["tool.state"])
  expect(query(items, "draft").map((item) => item.type)).toEqual(["prompt.subtask.state_changed"])
  expect(query(items, "gpt-5").map((item) => item.type)).toEqual(["autobest.state"])
})

test("history search queries durable session items", async () => {
  const sessionID = "s-history-search-session"
  await clean(sessionID)
  await append(sessionID, { ts: 1, type: "tool.state", sessionID, messageID: "m1", partID: "p1", tool: "bash", callID: "b1", state: "completed", title: "ls -la" })
  await append(sessionID, { ts: 2, type: "prompt.shell.state_changed", sessionID, messageID: "m1", callID: "b1", cwd: "/tmp/demo", shell: "zsh", status: "completed" })
  const items = await searchSession(sessionID, "tmp/demo")
  expect(items.map((item) => item.type)).toEqual(["prompt.shell.state_changed"])
  expect((await searchSession(sessionID, "ls -la")).map((item) => item.type)).toEqual(["tool.state"])
})
