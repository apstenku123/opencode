import type { Event } from "@/history"
import { read } from "@/history"
import * as search from "@/history/search"

function last<T extends Event["type"]>(items: Event[], type: T) {
  return items.findLast((item): item is Extract<Event, { type: T }> => item.type === type)
}

function count<T extends Event["type"]>(items: Event[], type: T) {
  return items.filter((item) => item.type === type).length
}

function subtask(items: Event[]) {
  const tool = items
    .filter((item): item is Extract<Event, { type: "tool.state" }> => item.type === "tool.state")
    .filter((item) => item.tool === "task")
    .at(-1)
  if (!tool) return
  return {
    ts: tool.ts,
    sessionID: tool.sessionID,
    messageID: tool.messageID,
    callID: tool.callID,
    status: tool.state,
    title: tool.title,
    error: tool.error,
    interrupted: tool.interrupted,
  }
}

function shell(items: Event[]) {
  const tool = items
    .filter((item): item is Extract<Event, { type: "tool.state" }> => item.type === "tool.state")
    .filter((item) => item.tool === "bash")
    .at(-1)
  if (!tool) return
  return {
    ts: tool.ts,
    sessionID: tool.sessionID,
    messageID: tool.messageID,
    callID: tool.callID,
    status: tool.interrupted ? "aborted" : tool.state,
    title: tool.title,
    error: tool.error,
    output: tool.output,
  }
}

function latest(items: Event[]) {
  return {
    tool: last(items, "tool.state"),
    reminder: last(items, "prompt.reminder.inserted"),
    autobest: last(items, "autobest.state"),
    autobest_log: items
      .filter((item): item is Extract<Event, { type: "autobest.state" }> => item.type === "autobest.state")
      .flatMap((item) => (item.log ? [{ ts: item.ts, sessionID: item.sessionID, ...item.log }] : []))
      .at(-1),
    subtask: last(items, "prompt.subtask.state_changed") ?? subtask(items),
    shell: last(items, "prompt.shell.state_changed") ?? shell(items),
  }
}

function counts(items: Event[]) {
  return {
    messages_created: count(items, "message.created"),
    messages_updated: count(items, "message.updated"),
    messages_removed: count(items, "message.removed"),
    parts_created: count(items, "message.part.created"),
    parts_updated: count(items, "message.part.updated"),
    parts_removed: count(items, "message.part.removed"),
    tool_states: count(items, "tool.state"),
    prompt: count(items, "prompt.reminder.inserted"),
    reminder: count(items, "prompt.reminder.inserted"),
    prompt_reminders: count(items, "prompt.reminder.inserted"),
    prompt_subtasks: count(items, "prompt.subtask.state_changed"),
    prompt_shells: count(items, "prompt.shell.state_changed"),
    autobest_states: count(items, "autobest.state"),
    autobest_logs: items.filter((item) => item.type === "autobest.state" && !!item.log).length,
  }
}

export function view(items: Event[]) {
  return {
    counts: counts(items),
    latest: latest(items),
  }
}

export function query(items: Event[], input: string) {
  return search.query(items, input)
}

export async function session(sessionID: string) {
  const items = await read(sessionID)
  return {
    sessionID,
    ...view(items),
  }
}

export async function searchSession(sessionID: string, input: string) {
  return search.session(sessionID, input)
}
