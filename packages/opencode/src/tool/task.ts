import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { SubagentRegistry } from "../subagent/registry"
import * as Hook from "../hook"
import { Cause, Effect, Fiber, Option } from "effect"

function subagentHookContext(parentSessionID: SessionID, agentType: string) {
  return {
    agentLevel: 1,
    sessionContext: {
      source: "sub_agent" as const,
      subagent: {
        source: "thread_spawn" as const,
        parent_session_id: parentSessionID,
        depth: 1,
        agent_role: agentType,
      },
    },
  }
}

/**
 * Max wait for an available Copilot slot before giving up and returning
 * `"Copilot pool exhausted, retry later"` from an async `task` spawn.
 * Mirrors the 10 s soft deadline used by Rust's spawn-throttle path.
 */
export const SPAWN_THROTTLE_MAX_WAIT_MS = 10_000
export const SPAWN_THROTTLE_POLL_MS = 500

/**
 * Default cascade-breaker check: consults the Copilot runtime state's
 * `shouldThrottleSpawns` hook. Dynamically imports the Copilot plugin module
 * the first time it's needed so non-Copilot deployments are unaffected, and
 * so we avoid a tool-layer → plugin-layer compile-time cycle.
 */
let copilotRuntimeStateCache:
  | { shouldThrottleSpawns?: () => boolean }
  | undefined

async function copilotShouldThrottleSpawnsAsync(): Promise<boolean> {
  try {
    if (!copilotRuntimeStateCache) {
      const mod = (await import("../plugin/github-copilot/copilot")) as {
        CopilotRuntimeState?: { shouldThrottleSpawns?: () => boolean }
      }
      copilotRuntimeStateCache = mod.CopilotRuntimeState ?? {}
    }
    return copilotRuntimeStateCache.shouldThrottleSpawns?.() ?? false
  } catch {
    return false
  }
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  /**
   * Fork the given effect as a detached top-level fiber (not bound to the
   * caller's scope). Used by the `async: true` path of the task tool so the
   * child session keeps running after the tool's `execute` returns. Returns
   * the fiber so the caller can interrupt it on cancel.
   */
  fork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E>
}

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  async: z
    .boolean()
    .describe(
      "When true, spawn the sub-agent asynchronously and return immediately with its session id. The parent loop's pre-break hook may choose to wait for active children before exiting (round 2).",
    )
    .optional(),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const subagents = yield* SubagentRegistry.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // The tool-input-start / tool-call stream events (which register the tool part and
      // transition it to "running") run concurrently with tool execution. If we call
      // ctx.metadata before those events have landed, the processor has no toolcall entry
      // and silently drops the update. Retry until we can observe our tool part so the
      // metadata write actually sticks before we hand off to the child prompt loop.
      const metadataPayload = {
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      }
      yield* Effect.gen(function* () {
        const deadline = Date.now() + 2_000
        while (true) {
          yield* ctx.metadata(metadataPayload)
          const observed = yield* Effect.sync(() => {
            const refreshed = MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
            const toolPart = refreshed.parts.find(
              (part): part is MessageV2.ToolPart =>
                part.type === "tool" && part.callID === ctx.callID,
            )
            return toolPart?.state.status === "running" && toolPart.state.metadata?.sessionId === nextSession.id
          })
          if (observed) break
          if (Date.now() >= deadline) break
          yield* Effect.sleep("10 millis")
        }
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()

      // Round 7 Stream 3: fire `SubagentStart` for every spawn (sync + async).
      // Hook service is a soft dependency — when unavailable (e.g. in unit
      // tests that don't provide the hook layer) we silently skip dispatch.
      const hookOpt = yield* Effect.serviceOption(Hook.Service)
      const fireSubagentStart = Effect.gen(function* () {
        if (Option.isNone(hookOpt)) return
        const hookContext = subagentHookContext(ctx.sessionID, next.name)
        yield* hookOpt.value
          .dispatch({
            event: {
              hook_event_name: "SubagentStart",
              agent_id: nextSession.id,
              agent_type: next.name,
              parent_session_id: ctx.sessionID,
              child_session_id: nextSession.id,
              prompt: params.prompt,
            },
            sessionID: ctx.sessionID,
            ...hookContext,
          })
          .pipe(Effect.ignore)
      })

      function cancel() {
        ops.cancel(nextSession.id)
      }

      const childTools = {
        ...(canTodo ? {} : { todowrite: false }),
        ...(canTask ? {} : { task: false }),
        ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
      }

      // Async variant (round 2):
      // Register the child with SubagentRegistry, fork the child prompt under
      // the ambient scope, and return immediately with the child session id.
      // The parent loop's preBreak hook calls `subagents.waitForAll(parent)`
      // before exiting if any children are still active. Cancel propagation
      // flows via the registered `cancel` callback (also wired to ctx.abort).
      if (params.async === true) {
        // Depth-limit guard — port of `agent::exceeds_thread_spawn_depth_limit`.
        // Walks the registered parent chain; the new child is one deeper than
        // its parent. Reject when adding a child would exceed `depthLimit`
        // (default 3). Synchronous variant is unaffected.
        const depthLimit = cfg.experimental?.subagent?.depthLimit ?? 3
        const parentDepth = yield* subagents.depth(SessionID.make(ctx.sessionID))
        if (parentDepth + 1 > depthLimit) {
          return yield* Effect.fail(
            new Error(
              `Sub-agent depth limit exceeded: parent at depth ${parentDepth}, attempting depth ${parentDepth + 1} > limit ${depthLimit}`,
            ),
          )
        }

        // Concurrency ceiling — port of Rust `agent::exceeds_concurrent_children_limit`.
        // The parent may already own N active children; reject before the
        // spawn rather than after, so failure surfaces in the tool output and
        // the model can retry with `task_wait` first. Default 8.
        const maxConcurrent = cfg.experimental?.subagent?.maxConcurrent ?? 8
        const activeChildren = yield* subagents.active(SessionID.make(ctx.sessionID))
        if (activeChildren.size >= maxConcurrent) {
          return yield* Effect.fail(
            new Error(
              `Sub-agent concurrency limit reached: ${activeChildren.size} active >= ${maxConcurrent}. Call task_wait or task_close first.`,
            ),
          )
        }

        // Cascade-breaker — Rust `should_throttle_spawns`
        // (`core/src/account_pool.rs:1390-1430`). When > 50% of Copilot
        // accounts are in cooldown, defer spawning a new async child so we
        // don't amplify the outage. Wait up to `SPAWN_THROTTLE_MAX_WAIT_MS`
        // polling at 500 ms; if the pool never recovers, fail with a
        // retry-later message so the parent can back off.
        const throttleChecker = ctx.extra?.shouldThrottleSpawns as
          | (() => boolean | Promise<boolean>)
          | undefined
        const throttleMaxWaitMs =
          (ctx.extra?.spawnThrottleMaxWaitMs as number | undefined) ?? SPAWN_THROTTLE_MAX_WAIT_MS
        const throttlePollMs =
          (ctx.extra?.spawnThrottlePollMs as number | undefined) ?? SPAWN_THROTTLE_POLL_MS
        yield* Effect.callback<void, Error>((resume) => {
          const deadline = Date.now() + throttleMaxWaitMs
          let cancelled = false
          let timer: ReturnType<typeof setTimeout> | undefined
          const check = async () => {
            if (cancelled) return
            let throttled = false
            try {
              throttled = throttleChecker
                ? await throttleChecker()
                : await copilotShouldThrottleSpawnsAsync()
            } catch {
              throttled = false
            }
            if (cancelled) return
            if (!throttled) {
              resume(Effect.void)
              return
            }
            if (Date.now() >= deadline) {
              resume(Effect.fail(new Error("Copilot pool exhausted, retry later")))
              return
            }
            timer = setTimeout(() => void check(), throttlePollMs)
          }
          void check()
          return Effect.sync(() => {
            cancelled = true
            if (timer) clearTimeout(timer)
          })
        })

        let cancelFiber: (() => void) | undefined

        yield* subagents.spawn(SessionID.make(ctx.sessionID), nextSession.id, {
          cancel: () => cancelFiber?.(),
          agentType: next.name,
        })
        yield* fireSubagentStart
        const runChild = Effect.gen(function* () {
          const parts = yield* ops.resolvePromptParts(params.prompt)
          return yield* ops.prompt({
            messageID,
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            agent: next.name,
            tools: childTools,
            parts,
          })
        })
        // The child runs in a detached top-level fiber (`ops.fork`) rather
        // than `Effect.forkChild`. Using `forkChild` would bind the child to
        // the tool-execute fiber's scope and — since the async variant
        // returns its output object synchronously — the child would be
        // interrupted the moment the tool returns, before it could reach a
        // terminal state. A top-level fiber survives the tool return and
        // keeps running until it finishes on its own or is explicitly
        // cancelled via `ctx.abort` / `subagents.cancelChild`.
        //
        const fiber = ops.fork(
          runChild.pipe(
            Effect.matchCauseEffect({
              onSuccess: (result) =>
                Effect.gen(function* () {
                  const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
                  // Registry close keeps `waitForAll` / `listChildren` in sync.
                  yield* subagents.close(nextSession.id, { status: "completed", result: text })
                }),
              onFailure: (cause) =>
                Effect.gen(function* () {
                  const status = Cause.hasInterruptsOnly(cause) ? "cancelled" : "error"
                  yield* subagents.close(nextSession.id, {
                    status,
                    error: Cause.pretty(cause),
                  })
                }),
            }),
          ),
        )
        cancelFiber = () => {
          // Best-effort: signal the child runner to stop and interrupt the
          // forked fiber. Either alone is sufficient; both is defensive.
          try {
            ops.cancel(nextSession.id)
          } catch {}
          void Effect.runPromise(Fiber.interrupt(fiber))
        }
        ctx.abort.addEventListener("abort", () => cancelFiber?.())
        return {
          title: params.description,
          metadata: {
            sessionId: nextSession.id,
            model,
            async: true,
          },
          output: [
            `task_id: ${nextSession.id} (async; use task_id to resume or poll)`,
            "",
            "<task_async>Child spawned; parent loop will rendezvous at pre-break.</task_async>",
          ].join("\n"),
        }
      }

      // Synchronous variant also fires SubagentStart before the child runs.
      // SubagentStop is fired on completion / failure / cancellation below —
      // the sync variant doesn't go through SubagentRegistry.close, so we
      // dispatch the stop event directly here (mirrors what the registry's
      // close() does for async spawns).
      yield* fireSubagentStart
      const fireSubagentStopSync = (opts: {
        reason: "completed" | "cancelled" | "failed"
        summary: string
        lastAssistantMessage: string | null
      }) =>
        Effect.gen(function* () {
          if (Option.isNone(hookOpt)) return
          yield* hookOpt.value
            .dispatch({
              event: {
                hook_event_name: "SubagentStop",
                stop_hook_active: false,
                agent_id: nextSession.id,
                agent_type: next.name,
                parent_session_id: ctx.sessionID,
                child_session_id: nextSession.id,
                summary: opts.summary,
                reason: opts.reason,
                last_assistant_message: opts.lastAssistantMessage,
              },
              sessionID: ctx.sessionID,
            })
            .pipe(Effect.ignore)
        })

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const result = yield* Effect.matchCauseEffect(
              ops.prompt({
                messageID,
                sessionID: nextSession.id,
                model: {
                  modelID: model.modelID,
                  providerID: model.providerID,
                },
                agent: next.name,
                tools: childTools,
                parts,
              }),
              {
                onSuccess: (value) =>
                  Effect.gen(function* () {
                    const text = value.parts.findLast((item) => item.type === "text")?.text ?? ""
                    yield* fireSubagentStopSync({
                      reason: "completed",
                      summary: text,
                      lastAssistantMessage: text.length > 0 ? text : null,
                    })
                    return { ok: true as const, value }
                  }),
                onFailure: (cause) =>
                  Effect.gen(function* () {
                    const reason: "cancelled" | "failed" = Cause.hasInterruptsOnly(cause)
                      ? "cancelled"
                      : "failed"
                    yield* fireSubagentStopSync({
                      reason,
                      summary: reason === "failed" ? Cause.pretty(cause) : "",
                      lastAssistantMessage: null,
                    })
                    return { ok: false as const, cause }
                  }),
              },
            )
            if (!result.ok) return yield* Effect.failCause(result.cause)
            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.value.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
