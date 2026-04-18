import * as Tool from "./tool"
import z from "zod"
import { Effect } from "effect"
import { Session } from "../session"
import { SessionID } from "../session/schema"
import { SubagentRegistry } from "../subagent/registry"

/**
 * `task_send_input` — inject a user message into a running sub-agent child's
 * session. Port of Rust `multi_agents/send_input.rs` (163 LOC).
 *
 * The message is written via `Session.appendUserText` with `agent: "parent"`
 * so the child can trace the injection source. Only running children are
 * accepted — sending input to a completed/cancelled child fails with a
 * descriptive error (matches Rust's `ensure_active` check).
 */
const id = "task_send_input"

const parameters = z.object({
  session_id: z
    .string()
    .describe("The child sub-agent session id (returned by the async `task` spawn)."),
  text: z.string().describe("The user-role text to inject into the child session."),
})

export const TaskSendInputTool = Tool.define(
  id,
  Effect.gen(function* () {
    const subagents = yield* SubagentRegistry.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskSendInputTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const parentID = SessionID.make(ctx.sessionID)
      const childID = SessionID.make(params.session_id)

      // Validate the child exists, is active, and is owned by this parent.
      const active = yield* subagents.active(parentID)
      if (!active.has(childID)) {
        const existing = yield* subagents.summary(childID)
        if (existing) {
          return yield* Effect.fail(
            new Error(
              `task_send_input: child ${childID} is no longer active (status: ${existing.status}).`,
            ),
          )
        }
        return yield* Effect.fail(
          new Error(
            `task_send_input: child ${childID} is not registered under this parent session.`,
          ),
        )
      }

      const messageID = yield* sessions.appendUserText({
        sessionID: childID,
        text: params.text,
        agent: "parent",
      })

      return {
        title: "task_send_input",
        metadata: {
          sessionId: childID,
          messageId: messageID,
          bytes: params.text.length,
        },
        output: [
          `Injected user message into child ${childID}.`,
          `message_id: ${messageID}`,
        ].join("\n"),
      }
    })

    return {
      description:
        "Send a user-role message to a running sub-agent child's session.\n" +
        "The message is enqueued as the next user turn for that child. Returns the injected message id.\n" +
        "Fails if the child is unknown, finished, or owned by a different parent.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
