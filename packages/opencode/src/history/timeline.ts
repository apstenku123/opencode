import type { Event } from "@/history"

function title(item: Event) {
  if (item.type === "session.created") return item.title ?? "session"
  if (item.type === "session.forked") return item.parentID
  if (item.type === "session.summary.updated") {
    if (!item.summary) return "summary cleared"
    return `${item.summary.files ?? 0} file${(item.summary.files ?? 0) === 1 ? "" : "s"}`
  }
  if (item.type === "tool.state") return item.title ?? item.tool
  if (item.type === "prompt.subtask.state_changed") return item.description
  if (item.type === "prompt.shell.state_changed") return item.cwd
  if (item.type === "prompt.reminder.inserted") return item.kind
  if (item.type === "autobest.state") return item.selected?.key ?? item.active?.key ?? "autobest"
  if (item.type === "message.created" || item.type === "message.updated") return item.role
  if (item.type === "message.removed") return item.messageID
  if (item.type === "message.part.created" || item.type === "message.part.updated") return item.partType
  if (item.type === "message.part.removed") return item.partID
  if (item.type === "autobest.active") return item.key
  return "event"
}

function kind(item: Event) {
  if (item.type.startsWith("session.")) return "session"
  if (item.type.startsWith("message.")) return "message"
  if (item.type.startsWith("prompt.")) return "prompt"
  if (item.type === "tool.state") return "tool"
  return "autobest"
}

export function view(items: Event[]) {
  return items.map((item) => ({
    ts: item.ts,
    type: item.type,
    kind: kind(item),
    text: title(item),
  }))
}

export function changes(items: Event[]) {
  return items
    .filter((item): item is Extract<Event, { type: "session.summary.updated" }> => item.type === "session.summary.updated")
    .flatMap((item, ix, list) => {
      if (!item.summary) return []
      const prev = list.slice(0, ix).findLast((entry) => entry.summary)
      const next = {
        ts: item.ts,
        files: item.summary.files ?? 0,
        additions: item.summary.additions ?? 0,
        deletions: item.summary.deletions ?? 0,
      }
      return [
        {
          ...next,
          delta: {
            files: next.files - (prev?.summary?.files ?? 0),
            additions: next.additions - (prev?.summary?.additions ?? 0),
            deletions: next.deletions - (prev?.summary?.deletions ?? 0),
          },
          trend: !prev?.summary
            ? "start"
            : next.additions + next.deletions > (prev.summary.additions ?? 0) + (prev.summary.deletions ?? 0)
              ? "up"
              : next.additions + next.deletions < (prev.summary.additions ?? 0) + (prev.summary.deletions ?? 0)
                ? "down"
                : "flat",
        },
      ]
    })
}
