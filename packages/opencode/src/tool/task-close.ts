import * as Tool from "./tool"
import z from "zod"
import { Effect } from "effect"
import { SessionID } from "../session/schema"
import { SubagentRegistry } from "../subagent/registry"

/**
 * `task_close` — cancel a running sub-agent child and release its registry
 * lease. Port of Rust `multi_agents/close_agent.rs` (172 LOC).
 *
 * Invokes the child's registered cancel callback (which interrupts its
 * forked fiber and signals the session runner), then records a `cancelled`
 * summary so any pending `task_wait` unblocks.
 *
 * Idempotent: closing an already-finished child is a no-op.
 */
const id = "task_close"

const parameters = z.object({
  session_id: z
    .string()
    .describe("The child sub-agent session id to cancel."),
})

export const TaskCloseTool = Tool.define(
  id,
  Effect.gen(function* () {
    const subagents = yield* SubagentRegistry.Service

    const run = Effect.fn("TaskCloseTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const parentID = SessionID.make(ctx.sessionID)
      const childID = SessionID.make(params.session_id)
      const cancelled = yield* subagents.cancelChild(parentID, childID)
      if (cancelled) {
        return {
          title: "task_close",
          metadata: { sessionId: childID, cancelled: true } as Record<string, unknown>,
          output: `Cancelled child ${childID}.`,
        }
      }
      // Either already finished or foreign / unknown. Look up existing
      // summary so the model gets actionable detail.
      const summary = yield* subagents.summary(childID)
      if (summary) {
        if (summary.parentID !== parentID) {
          return {
            title: "task_close",
            metadata: { sessionId: childID, cancelled: false, reason: "foreign" } as Record<string, unknown>,
            output: `task_close: child ${childID} is owned by a different parent; no action taken.`,
          }
        }
        return {
          title: "task_close",
          metadata: {
            sessionId: childID,
            cancelled: false,
            reason: "already-finished",
            status: summary.status,
          } as Record<string, unknown>,
          output: `task_close: child ${childID} already finished with status ${summary.status}; no action taken.`,
        }
      }
      return {
        title: "task_close",
        metadata: { sessionId: childID, cancelled: false, reason: "unknown" } as Record<string, unknown>,
        output: `task_close: child ${childID} is not registered; no action taken.`,
      }
    })

    return {
      description:
        "Cancel a running sub-agent child and release its registry slot.\n" +
        "Interrupts the child's fiber and records a `cancelled` summary. Any pending `task_wait` on this child resolves immediately.\n" +
        "Idempotent — closing an already-finished or unknown child is a no-op with a descriptive output.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
