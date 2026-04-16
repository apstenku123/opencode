import path from "path"
import * as Filesystem from "@/util/filesystem"
import { Global } from "@/global"

export type Event =
  | {
      ts: number
      type: "session.created"
      sessionID: string
      title?: string
    }
  | {
      ts: number
      type: "session.forked"
      sessionID: string
      parentID: string
    }
  | {
      ts: number
      type: "session.summary.updated"
      sessionID: string
      summary:
        | {
            additions?: number
            deletions?: number
            files?: number
          }
        | null
    }
  | {
      ts: number
      type: "message.created"
      sessionID: string
      messageID: string
      role: "user" | "assistant"
    }
  | {
      ts: number
      type: "message.updated"
      sessionID: string
      messageID: string
      role: "user" | "assistant"
    }
  | {
      ts: number
      type: "message.removed"
      sessionID: string
      messageID: string
    }
  | {
      ts: number
      type: "message.part.created"
      sessionID: string
      messageID: string
      partID: string
      partType: string
    }
  | {
      ts: number
      type: "message.part.updated"
      sessionID: string
      messageID: string
      partID: string
      partType: string
    }
  | {
      ts: number
      type: "message.part.removed"
      sessionID: string
      messageID: string
      partID: string
    }
  | {
      ts: number
      type: "tool.state"
      sessionID: string
      messageID: string
      partID: string
      tool: string
      callID: string
      state: "pending" | "running" | "completed" | "error"
      title?: string
      output?: number
      attachments?: number
      error?: string
      interrupted?: boolean
    }
  | {
      ts: number
      type: "step.finish"
      sessionID: string
      messageID: string
      reason: string
      cost: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: {
          read: number
          write: number
        }
        total?: number
      }
    }
  | {
      ts: number
      type: "prompt.reminder.inserted"
      sessionID: string
      messageID: string
      agent: string
      kind: "plan_prompt" | "build_switch" | "plan_mode"
      source: "agent_match" | "prior_plan_assistant" | "plan_file_exists"
      synthetic: true
    }
  | {
      ts: number
      type: "prompt.subtask.state_changed"
      sessionID: string
      messageID: string
      callID: string
      agent: string
      status: "running" | "completed" | "error"
      description: string
    }
  | {
      ts: number
      type: "prompt.shell.state_changed"
      sessionID: string
      messageID: string
      callID: string
      cwd: string
      shell: string
      status: "running" | "completed" | "aborted"
    }
  | {
      ts: number
      type: "autobest.active"
      sessionID: string
      source: "manual" | "auto"
      key: string
      score?: number
      changed: boolean
      picks: number
      candidates?: {
        key: string
        score: number
      }[]
    }
  | {
      ts: number
      type: "autobest.enabled"
      sessionID: string
      enabled: boolean
    }
  | {
      ts: number
      type: "autobest.state"
      sessionID: string
      active?: {
        key: string
        score?: number
        source: "manual" | "auto"
        ts: number
      }
      selected?: {
        key: string
        score: number
        reason?: string[]
      }
      changed: boolean
      candidates: number
      top?: {
        key: string
        score: number
        reason?: string[]
      }
      log?: {
        active?: {
          key: string
          score?: number
          source: "manual" | "auto"
          ts: number
        }
        selected?: {
          key: string
          score: number
          reason?: string[]
        }
        changed: boolean
        candidates: {
          key: string
          score: number
          reason?: string[]
        }[]
      }
    }
  | {
      ts: number
      type: "autobest.result"
      sessionID: string
      selected?: {
        key: string
        score: number
        reason?: string[]
      }
      changed: boolean
      candidates: {
        key: string
        score: number
        reason?: string[]
      }[]
    }

export function file(sessionID: string) {
  return path.join(Global.Path.data, "history", `${sessionID}.jsonl`)
}

export async function exists(sessionID: string) {
  return Filesystem.exists(file(sessionID))
}

export async function append(sessionID: string, event: Event) {
  const next = JSON.stringify(event) + "\n"
  const prev = (await Filesystem.readText(file(sessionID)).catch(() => "")) + next
  await Filesystem.write(file(sessionID), prev)
}

export async function read(sessionID: string) {
  const raw = await Filesystem.readText(file(sessionID)).catch(() => "")
  if (!raw) return []
  return raw
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean)
    .flatMap((line: string) => {
      try {
        return [JSON.parse(line) as Event]
      } catch {
        return []
      }
    })
}

export async function readByType<T extends Event["type"]>(sessionID: string, type: T) {
  return (await read(sessionID)).filter((item: Event): item is Extract<Event, { type: T }> => item.type === type)
}

export async function last<T extends Event["type"]>(sessionID: string, type: T) {
  const items = await readByType(sessionID, type)
  return items.at(-1)
}
