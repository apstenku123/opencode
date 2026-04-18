/**
 * Sub-agent approval Guardian — intercepts {@link Question.Event.Asked}
 * emitted by child sessions (spawned via `tool/task.ts` with `async: true`)
 * and routes approval decisions through the parent session's permission
 * ruleset.
 *
 * Port of `codex-rs/core/src/codex_delegate_guardian.rs` — the Rust guardian
 * inspects a proposed action from a delegate agent, consults the parent's
 * approval policy, and either auto-approves (ruleset match), rejects, or
 * forwards the question upward for the parent's UI to render.
 *
 * # Routing rules (round 3)
 *
 * When a question is asked by a session id `X`:
 *
 * 1. If `X` has no registered parent in {@link SubagentRegistry}, the
 *    Guardian does nothing — top-level questions flow to the parent UI
 *    via the existing `Question.Event.Asked` channel.
 * 2. Otherwise, look up `parent = SubagentRegistry.parentOf(X)` and read
 *    `parent.permission` from `Session.Service.get(parent)`.
 * 3. For each {@link Question.Info} in the request, probe the ruleset with
 *    permission key `"subagent"` and pattern `info.header`. If the merged
 *    ruleset evaluates to `allow` AND the info has at least one option,
 *    auto-reply with the first option label via
 *    {@link Question.Service.reply}.
 * 4. Otherwise, emit {@link Question.Event.ForwardedToParent} so parent
 *    UI consumers can render the question in the parent's context. The
 *    original Deferred in `Question.Service` remains pending; parent UI
 *    replies via the normal `Question.Service.reply` / `reject` API.
 *
 * The Guardian is side-effect-only — the actual deferred resolution goes
 * through `Question.Service` so consumers relying on `Question.ask` still
 * get the same response semantics.
 *
 * # Rationale for `"subagent"` permission key
 *
 * The `tool/task.ts` async spawn path already uses the `task` permission
 * key (see `ctx.ask({ permission: "task", ... })`). We use a distinct
 * `"subagent"` key for the guardian so users can express a policy like
 * "allow child questions with header matching `glob:*read*`" without
 * mixing it with the spawn permission. Top-level `Question.ask` calls
 * from primary agents bypass the guardian entirely.
 */

import { Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { Log } from "@/util"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { SubagentRegistry } from "./registry"

export namespace Guardian {
  const log = Log.create({ service: "subagent.guardian" })

  export interface Interface {
    /**
     * Evaluate a {@link Question.Request} synchronously against the
     * parent's ruleset. Returns the routing decision without side-effects.
     * Used by tests and by the bus subscriber. Pure wrt the request and
     * registry/session lookups (idempotent).
     */
    readonly evaluate: (request: Question.Request) => Effect.Effect<Decision>
    /** Read-only snapshot of total routed (auto-approved + forwarded) requests. */
    readonly stats: () => Effect.Effect<Stats>
  }

  export type Decision =
    | { readonly kind: "pass"; readonly reason: "top-level-session" | "unknown-session" }
    | {
        readonly kind: "auto-approve"
        readonly parentID: SessionID
        readonly reply: ReadonlyArray<ReadonlyArray<string>>
      }
    | {
        readonly kind: "forward"
        readonly parentID: SessionID
        readonly reason: "no-matching-rule" | "deny-rule" | "no-options"
      }

  export interface Stats {
    readonly autoApproved: number
    readonly forwarded: number
    readonly passed: number
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentGuardian") {}

  /**
   * Permission key used for guardian ruleset evaluation. Parent sessions
   * opt into auto-approving child questions by adding rules like
   * `{ permission: "subagent", pattern: "read-file", action: "allow" }`.
   */
  export const PERMISSION_KEY = "subagent"

  /**
   * Core decision function — exported for direct unit tests. Evaluates
   * a question request against a parent session's ruleset without
   * mutating any state or touching the bus.
   */
  export function decide(input: {
    request: Question.Request
    parentID: SessionID | undefined
    parentRuleset: Permission.Ruleset | undefined
  }): Decision {
    if (!input.parentID) {
      return { kind: "pass", reason: "top-level-session" }
    }
    const ruleset = input.parentRuleset ?? []
    const autoReplies: string[][] = []
    for (const info of input.request.questions) {
      const rule = Permission.evaluate(PERMISSION_KEY, info.header, ruleset)
      if (rule.action === "deny") {
        return { kind: "forward", parentID: input.parentID, reason: "deny-rule" }
      }
      if (rule.action === "allow") {
        if (info.options.length === 0) {
          return { kind: "forward", parentID: input.parentID, reason: "no-options" }
        }
        // Auto-approve: pick the first option (conventionally the
        // "approve" choice). If `multiple`, still answer with the single
        // first label — callers that need multi-select should not rely
        // on auto-approval.
        autoReplies.push([info.options[0].label])
        continue
      }
      // action === "ask"  →  forward
      return { kind: "forward", parentID: input.parentID, reason: "no-matching-rule" }
    }
    return { kind: "auto-approve", parentID: input.parentID, reply: autoReplies }
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const question = yield* Question.Service
      const registry = yield* SubagentRegistry.Service
      const sessions = yield* Session.Service

      let autoApproved = 0
      let forwarded = 0
      let passed = 0

      const lookup = Effect.fn("Guardian.lookup")(function* (childID: SessionID) {
        const parentID = yield* registry.parentOf(childID)
        if (!parentID) return { parentID: undefined, ruleset: undefined as Permission.Ruleset | undefined }
        // `Session.Service.get` throws on missing session — tolerate that
        // as "no ruleset available" rather than failing the whole bus
        // handler.
        const parent = yield* sessions
          .get(parentID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        return { parentID, ruleset: parent?.permission }
      })

      const evaluate: Interface["evaluate"] = (request) =>
        Effect.gen(function* () {
          const { parentID, ruleset } = yield* lookup(request.sessionID)
          const decision = decide({ request, parentID, parentRuleset: ruleset })
          return decision
        })

      const handle = Effect.fn("Guardian.handle")(function* (request: Question.Request) {
        const decision = yield* evaluate(request)
        if (decision.kind === "pass") {
          passed += 1
          return
        }
        if (decision.kind === "auto-approve") {
          autoApproved += 1
          log.info("auto-approved", {
            requestID: request.id,
            childID: request.sessionID,
            parentID: decision.parentID,
          })
          yield* question.reply({ requestID: request.id, answers: decision.reply }).pipe(Effect.ignore)
          return
        }
        forwarded += 1
        log.info("forwarded to parent", {
          requestID: request.id,
          childID: request.sessionID,
          parentID: decision.parentID,
          reason: decision.reason,
        })
        yield* bus.publish(Question.Event.ForwardedToParent, {
          parentID: decision.parentID,
          childID: request.sessionID,
          requestID: request.id,
          request,
        })
      })

      // Subscribe to Question.Event.Asked. Handler runs off-bus so the
      // publisher (Question.ask) doesn't block on guardian dispatch.
      const off = yield* bus.subscribeCallback(Question.Event.Asked, (evt) => {
        void Effect.runPromise(handle(evt.properties).pipe(Effect.catchCause(() => Effect.void)))
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const stats: Interface["stats"] = () =>
        Effect.sync(() => ({ autoApproved, forwarded, passed }))

      return Service.of({ evaluate, stats })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(SubagentRegistry.defaultLayer),
    Layer.provide(Session.defaultLayer),
  )
}
