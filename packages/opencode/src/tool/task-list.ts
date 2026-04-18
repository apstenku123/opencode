import * as Tool from "./tool"
import z from "zod"
import { Effect } from "effect"
import { SessionID } from "../session/schema"
import { SubagentRegistry } from "../subagent/registry"

/**
 * `task_list` — enumerate every sub-agent child registered under the current
 * parent session. Port of Rust `multi_agents/list_agents.rs` (138 LOC).
 *
 * Returns both running and finished children as a single array sorted by
 * `startedAt` ascending. The model uses this to decide whether to call
 * `task_wait` (running children present) or simply re-read a finished child's
 * session output.
 *
 * Parameters: none — scope is always the calling session.
 */
const id = "task_list"

const parameters = z.object({})

export const TaskListTool = Tool.define(
  id,
  Effect.gen(function* () {
    const subagents = yield* SubagentRegistry.Service

    const run = Effect.fn("TaskListTool.execute")(function* (
      _params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const rows = yield* subagents.listChildren(SessionID.make(ctx.sessionID))
      if (rows.length === 0) {
        return {
          title: "task_list",
          metadata: { count: 0 } as Record<string, unknown>,
          output: "No sub-agent children registered under this session.",
        }
      }
      const lines = rows.map((row) => {
        const base = `- ${row.sessionID} [${row.status}]`
        const detail =
          row.status === "running"
            ? `started ${new Date(row.startedAt).toISOString()}`
            : row.status === "error"
              ? row.error?.slice(0, 200) ?? "<unknown error>"
              : row.result?.slice(0, 200) ?? "<no output>"
        return `${base}: ${detail}`
      })
      return {
        title: "task_list",
        metadata: {
          count: rows.length,
          running: rows.filter((r) => r.status === "running").length,
          completed: rows.filter((r) => r.status === "completed").length,
          cancelled: rows.filter((r) => r.status === "cancelled").length,
          errored: rows.filter((r) => r.status === "error").length,
        } as Record<string, unknown>,
        output: [`Sub-agent children for ${ctx.sessionID} (${rows.length}):`, ...lines].join("\n"),
      }
    })

    return {
      description:
        "List every sub-agent child session registered under the current parent session.\n" +
        "Returns both running and finished (completed/cancelled/errored) children, sorted by start time.\n" +
        "Use this before `task_wait` to discover pending child ids, or after auto-wait to inspect outcomes.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
