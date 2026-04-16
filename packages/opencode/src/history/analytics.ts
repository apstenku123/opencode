import type { Event } from "@/history"
import { read } from "@/history"

type Tool = Extract<Event, { type: "tool.state" }>
type Step = Extract<Event, { type: "step.finish" }>

function tools(items: Event[]) {
  return items.filter((item): item is Tool => item.type === "tool.state")
}

function pick(items: Event[], tool: string) {
  return tools(items).filter((item) => item.tool === tool)
}

function by(items: Tool[], key: "state" | "tool") {
  return items.reduce<Record<string, number>>((acc, item) => {
    const value = key == "state" ? item.state : item.tool
    acc[value] = (acc[value] ?? 0) + 1
    return acc
  }, {})
}

function steps(items: Event[]) {
  return items.filter((item): item is Step => item.type === "step.finish")
}

function latest(items: Event[]) {
  return {
    tool: items.findLast((item): item is Tool => item.type === "tool.state"),
    step: items.findLast((item): item is Step => item.type === "step.finish"),
    subtask: items.findLast((item): item is Extract<Event, { type: "prompt.subtask.state_changed" }> => item.type === "prompt.subtask.state_changed"),
    shell: items.findLast((item): item is Extract<Event, { type: "prompt.shell.state_changed" }> => item.type === "prompt.shell.state_changed"),
  }
}

export function view(items: Event[]) {
  const all = tools(items)
  const done = steps(items)
  const task = pick(items, "task")
  const bash = pick(items, "bash")
  const cost = done.reduce((acc, item) => acc + item.cost, 0)
  const tokens = done.reduce(
    (acc, item) => ({
      input: acc.input + item.tokens.input,
      output: acc.output + item.tokens.output,
      reasoning: acc.reasoning + item.tokens.reasoning,
      cache: {
        read: acc.cache.read + item.tokens.cache.read,
        write: acc.cache.write + item.tokens.cache.write,
      },
      total: (acc.total ?? 0) + (item.tokens.total ?? item.tokens.input + item.tokens.output + item.tokens.reasoning + item.tokens.cache.read + item.tokens.cache.write),
    }),
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
  )
  return {
    total: items.length,
    sessions: {
      created: items.filter((item) => item.type === "session.created").length,
      forked: items.filter((item) => item.type === "session.forked").length,
      summarized: items.filter((item) => item.type === "session.summary.updated").length,
    },
    tools: {
      total: all.length,
      by_state: by(all, "state"),
      by_name: by(all, "tool"),
      interrupted: all.filter((item) => !!item.interrupted).length,
      task: {
        total: task.length,
        by_state: by(task, "state"),
      },
      bash: {
        total: bash.length,
        by_state: by(bash, "state"),
      },
    },
    prompts: {
      reminders: items.filter((item) => item.type === "prompt.reminder.inserted").length,
      subtasks: items.filter((item) => item.type === "prompt.subtask.state_changed").length,
      shells: items.filter((item) => item.type === "prompt.shell.state_changed").length,
    },
    steps: {
      total: done.length,
      cost,
      tokens,
      by_reason: done.reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] ?? 0) + 1
        return acc
      }, {}),
    },
    latest: latest(items),
  }
}

export async function session(sessionID: string) {
  return view(await read(sessionID))
}
