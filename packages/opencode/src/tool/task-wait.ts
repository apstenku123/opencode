import * as Tool from "./tool"
import z from "zod"
import { Effect } from "effect"
import { SessionID } from "../session/schema"
import { SubagentRegistry } from "../subagent/registry"

/**
 * `task_wait` — block until one or more sub-agent children complete (or a
 * timeout elapses). Port of Rust `multi_agents/wait.rs` (366 LOC).
 *
 * Two shapes:
 * - `ids: [...]` — wait for a specific set of children (all must belong to
 *   this parent). Already-finished ids resolve immediately with their
 *   recorded summary.
 * - omit `ids` — wait for every currently-active child under this parent.
 *
 * `timeout_ms` is clamped to `[MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS]` to
 * match Rust behaviour. On timeout, whatever summaries have landed so far are
 * returned; pending children remain active.
 */
const id = "task_wait"

/** Matches Rust `MIN_WAIT_TIMEOUT_MS` / `MAX_WAIT_TIMEOUT_MS`. */
export const MIN_WAIT_TIMEOUT_MS = 100
export const MAX_WAIT_TIMEOUT_MS = 600_000
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000

const parameters = z.object({
  ids: z
    .array(z.string())
    .optional()
    .describe(
      "Specific child session ids to wait for. Omit to wait for every currently-active child under the calling parent.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Hard timeout in milliseconds. Clamped to [${MIN_WAIT_TIMEOUT_MS}, ${MAX_WAIT_TIMEOUT_MS}]. Default ${DEFAULT_WAIT_TIMEOUT_MS}.`,
    ),
})

export const TaskWaitTool = Tool.define(
  id,
  Effect.gen(function* () {
    const subagents = yield* SubagentRegistry.Service

    const run = Effect.fn("TaskWaitTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const raw = params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS
      const timeoutMs = Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, raw))
      const parentID = SessionID.make(ctx.sessionID)

      const summaries = params.ids && params.ids.length > 0
        ? yield* subagents.waitForIds(
            parentID,
            params.ids.map((s) => SessionID.make(s)),
            { timeoutMs },
          )
        : yield* subagents.waitForAll(parentID, { timeoutMs })

      const body = SubagentRegistry.summarize(summaries)
      return {
        title: "task_wait",
        metadata: {
          count: summaries.length,
          timeoutMs,
          completed: summaries.filter((s) => s.status === "completed").length,
          cancelled: summaries.filter((s) => s.status === "cancelled").length,
          errored: summaries.filter((s) => s.status === "error").length,
        },
        output:
          summaries.length === 0
            ? "task_wait: no children completed within the timeout window."
            : body,
      }
    })

    return {
      description:
        "Block the parent turn until one or more sub-agent children complete.\n" +
        "- Pass `ids: [...]` to wait for specific children.\n" +
        "- Omit `ids` to wait for every active child.\n" +
        "Returns a summary of each completed child (status, result text, error). Timeout returns whatever has landed so far; pending children remain active.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
