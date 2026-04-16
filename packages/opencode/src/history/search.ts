import type { Event } from "@/history"
import { read } from "@/history"

type Row = {
  ts: number
  type: Event["type"]
  text: string
  item: Event
}

function text(item: Event) {
  if (item.type === "session.created") return [item.title]
  if (item.type === "session.forked") return [item.parentID]
  if (item.type === "session.summary.updated") {
    if (!item.summary) return ["summary cleared"]
    return [String(item.summary.files ?? ""), String(item.summary.additions ?? ""), String(item.summary.deletions ?? "")]
  }
  if (item.type === "message.created" || item.type === "message.updated") return [item.role, item.messageID]
  if (item.type === "message.removed") return [item.messageID]
  if (item.type === "message.part.created" || item.type === "message.part.updated") return [item.messageID, item.partID, item.partType]
  if (item.type === "message.part.removed") return [item.messageID, item.partID]
  if (item.type === "tool.state") return [item.tool, item.callID, item.state, item.title, item.error, String(item.output ?? ""), String(item.attachments ?? "")]
  if (item.type === "prompt.reminder.inserted") return [item.agent, item.kind, item.source, item.messageID]
  if (item.type === "prompt.subtask.state_changed") return [item.agent, item.status, item.description, item.callID, item.messageID]
  if (item.type === "prompt.shell.state_changed") return [item.cwd, item.shell, item.status, item.callID, item.messageID]
  if (item.type === "autobest.active") return [item.source, item.key, String(item.score ?? ""), String(item.picks)]
  if (item.type === "autobest.state") return [item.active?.key, item.selected?.key, ...(item.selected?.reason ?? []), String(item.candidates)]
  return []
}

function row(item: Event): Row {
  return {
    ts: item.ts,
    type: item.type,
    text: text(item)
      .filter((item): item is string => !!item)
      .join(" ")
      .trim(),
    item,
  }
}

export function view(items: Event[]) {
  return items.map(row)
}

export function query(items: Event[], input: string) {
  const term = input.trim().toLowerCase()
  if (!term) return []
  return view(items).filter((item) => `${item.type} ${item.text}`.toLowerCase().includes(term))
}

export async function session(sessionID: string, input: string) {
  return query(await read(sessionID), input)
}
