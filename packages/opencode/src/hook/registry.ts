/**
 * `Hook.Service` — registry + dispatcher facade for the opencode hook
 * subsystem. Ports `codex-rs/hooks/src/registry.rs` as an Effect service.
 *
 * Design:
 *
 * - Hooks live either in `experimental.hooks.<EventName>` config (user
 *   defined command hooks) or are registered programmatically via
 *   {@link Interface.register}.
 * - `dispatch(event, overrides)` assembles a {@link HookPayload}, reads
 *   user hooks from Config for the event's name, filters by matcher
 *   regex, and runs each command via {@link runCommandHook}. In-process
 *   hooks registered via {@link Interface.register} run after command
 *   hooks; they may observe the aggregated results.
 * - A `FailedAbort` result short-circuits the chain. Remaining results
 *   are returned so the caller can thread decision/updatedInput back.
 *
 * The dispatcher is designed to be safe to call from any site — missing
 * config, empty hook arrays, and all subprocess failures collapse to a
 * no-op (`HookDispatchResult.outcome === "continue"`).
 */
import { Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Config } from "@/config"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { InstanceState } from "@/effect"
import * as ConfigOverlay from "@/session/config-overlay"
import { type HookCommandEntry, runCommandHook } from "./command"
import {
  type HookEvent,
  type HookEventName,
  type HookPayload,
  type HookResponse,
  type HookResult,
  type HookSessionContext,
  HookSessionSourceKind,
  matchTargetFor,
  shouldAbort,
} from "./types"

export type InProcessHookFn = (payload: HookPayload) => Effect.Effect<HookResult>

export interface RegisteredHook {
  readonly name: string
  readonly event?: HookEventName
  readonly matcher?: RegExp
  readonly group?: string
  readonly run: InProcessHookFn
}

export type HookDispatchOutcome = "continue" | "abort"

export interface HookDispatchResult {
  readonly outcome: HookDispatchOutcome
  readonly responses: ReadonlyArray<HookResponse>
  /** Aggregate convenience accessors (first-wins). */
  readonly additionalContext?: string
  readonly updatedInput?: unknown
  readonly updatedOutput?: unknown
  readonly decisionBehavior?: string
  readonly decisionMessage?: string
  readonly abortReason?: string
}

export interface DispatchInput {
  readonly event: HookEvent
  readonly sessionID?: string
  readonly agentLevel?: number
  readonly sessionContext?: HookSessionContext
  readonly cwd?: string
  readonly client?: string
  readonly permissionMode?: string
  readonly transcriptPath?: string
  /** Optional timestamp override for tests. */
  readonly triggeredAt?: string
}

export interface Interface {
  readonly register: (hook: RegisteredHook) => Effect.Effect<() => void>
  readonly listed: () => Effect.Effect<ReadonlyArray<string>>
  readonly dispatch: (input: DispatchInput) => Effect.Effect<HookDispatchResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Hook") {}

function asRegExp(source: string | undefined): RegExp | undefined {
  if (!source) return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

function matches(matcher: RegExp | undefined, event: HookEvent): boolean {
  if (!matcher) return true
  const target = matchTargetFor(event)
  if (target === undefined) return true
  return matcher.test(target)
}

/**
 * Build a default payload when the caller supplies only `event`. All
 * optional fields are filled with safe placeholders so that hooks can
 * always rely on top-level wire keys being present.
 */
export function buildPayload(input: DispatchInput, cwd: string): HookPayload {
  const ctx: HookSessionContext = input.sessionContext ?? {
    source: HookSessionSourceKind.enum.cli,
  }
  return {
    session_id: input.sessionID ?? "session_unknown",
    agent_level: input.agentLevel ?? 0,
    session_context: ctx,
    cwd,
    client: input.client,
    triggered_at: input.triggeredAt ?? new Date().toISOString(),
    permission_mode: input.permissionMode,
    transcript_path: input.transcriptPath,
    hook_event: input.event,
  }
}

/**
 * Reduce a list of hook responses into the aggregated {@link HookDispatchResult}.
 * The reducer applies first-wins semantics for single-valued fields
 * (additional_context, updated_input, …) and stops early on FailedAbort.
 */
export function reduceResponses(responses: ReadonlyArray<HookResponse>): HookDispatchResult {
  let outcome: HookDispatchOutcome = "continue"
  let additionalContext: string | undefined
  let updatedInput: unknown | undefined
  let updatedOutput: unknown | undefined
  let decisionBehavior: string | undefined
  let decisionMessage: string | undefined
  let abortReason: string | undefined
  for (const r of responses) {
    if (r.result.kind === "success") {
      if (additionalContext === undefined && r.result.additional_context !== undefined)
        additionalContext = r.result.additional_context
      if (updatedInput === undefined && r.result.updated_input !== undefined)
        updatedInput = r.result.updated_input
      if (updatedOutput === undefined && r.result.updated_output !== undefined)
        updatedOutput = r.result.updated_output
      if (decisionBehavior === undefined && r.result.decision_behavior !== undefined)
        decisionBehavior = r.result.decision_behavior
      if (decisionMessage === undefined && r.result.decision_message !== undefined)
        decisionMessage = r.result.decision_message
    } else if (r.result.kind === "failed_abort") {
      outcome = "abort"
      abortReason = r.result.error
      break
    }
  }
  return {
    outcome,
    responses,
    additionalContext,
    updatedInput,
    updatedOutput,
    decisionBehavior,
    decisionMessage,
    abortReason,
  }
}

interface State {
  readonly inProcess: RegisteredHook[]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const data = yield* InstanceState.make<State>(
      Effect.fnUntraced(function* () {
        return { inProcess: [] as RegisteredHook[] }
      }),
    )
    const get = InstanceState.get(data)

    const register: Interface["register"] = (hook) =>
      Effect.gen(function* () {
        const state = yield* get
        state.inProcess.push(hook)
        return () => {
          const i = state.inProcess.indexOf(hook)
          if (i >= 0) state.inProcess.splice(i, 1)
        }
      })

    const listed: Interface["listed"] = () =>
      Effect.gen(function* () {
        const state = yield* get
        return state.inProcess.map((h) => h.name)
      })

    const dispatch: Interface["dispatch"] = (input) =>
      Effect.gen(function* () {
        const rawCfg = yield* config.get()
        // Apply per-session overlay so tests (and future runtime tweaks) can
        // register event handlers for a single session without mutating the
        // shared on-disk config. No-op when no overlay is registered.
        const cfg = ConfigOverlay.applyOverlay(rawCfg, input.sessionID)
        const eventName = input.event.hook_event_name
        const cwd = input.cwd ?? process.cwd()
        const payload = buildPayload(input, cwd)

        const responses: HookResponse[] = []

        // 1) User-configured command hooks for this event.
        const perEvent = getCommandHooksFor(cfg, eventName)
        for (const entry of perEvent) {
          const matcher = asRegExp(entry.matcher)
          if (!matches(matcher, input.event)) continue
          const result = yield* runCommandHook({
            hook: entry,
            payload,
            spawner,
            cwd,
          })
          responses.push({ hook_name: entry.name, result })
          if (shouldAbort(result)) return reduceResponses(responses)
        }

        // 2) In-process registered hooks — fire after command hooks.
        const state = yield* get
        for (const reg of state.inProcess) {
          if (reg.event !== undefined && reg.event !== eventName) continue
          if (!matches(reg.matcher, input.event)) continue
          const result = yield* reg.run(payload).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed<HookResult>({
                kind: "failed_continue",
                error: `in-process hook '${reg.name}' failed: ${String(cause)}`,
              }),
            ),
          )
          responses.push({ hook_name: reg.name, result })
          if (shouldAbort(result)) return reduceResponses(responses)
        }

        return reduceResponses(responses)
      })

    return Service.of({ register, listed, dispatch })
  }),
)

/**
 * Load user-configured command hooks for an event from
 * `experimental.hooks.<EventName>`. Also honours the legacy
 * `experimental.hooks.stopHooks` array for the `Stop` event so existing
 * configs continue to work.
 */
export function getCommandHooksFor(
  cfg: Config.Info,
  event: HookEventName,
): HookCommandEntry[] {
  const root = cfg.experimental?.hooks
  if (!root) return []
  const entries: HookCommandEntry[] = []
  const anyRoot = root as unknown as Record<string, unknown>
  const perEvent = anyRoot[event]
  if (Array.isArray(perEvent)) {
    for (const raw of perEvent as Array<Record<string, unknown>>) {
      const name = String(raw.name ?? "hook")
      const command = raw.command as string | ReadonlyArray<string> | undefined
      if (command === undefined) continue
      entries.push({
        name,
        command,
        matcher: typeof raw.matcher === "string" ? raw.matcher : undefined,
        group: typeof raw.group === "string" ? raw.group : undefined,
        timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
      })
    }
  }
  if (event === "Stop" && Array.isArray(root.stopHooks)) {
    for (const raw of root.stopHooks) {
      entries.push({
        name: raw.name,
        command: raw.command,
        timeoutMs: raw.timeoutMs,
      })
    }
  }
  return entries
}

/**
 * Shared default layer — for tests and for the app runtime. Bundles
 * `Config.defaultLayer` and `CrossSpawnSpawner.defaultLayer` so the
 * Hook service's inputs are fully satisfied when merged into a larger
 * layer set (e.g. `AppLayer`). ManagedRuntime memoMap de-duplicates the
 * shared `Config.Service` instance.
 */
export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

/**
 * A self-contained test layer — a Hook.Service that loads no config and
 * supports in-process registrations. Useful for services that fire
 * lifecycle events (Permission, Question) when exercised outside the full
 * `AppLayer` runtime where `Config.defaultLayer` would otherwise pull in
 * Auth/Plugin/Storage dependencies.
 */
export const noopLayer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const inProcess: RegisteredHook[] = []
    const register: Interface["register"] = (hook) =>
      Effect.sync(() => {
        inProcess.push(hook)
        return () => {
          const i = inProcess.indexOf(hook)
          if (i >= 0) inProcess.splice(i, 1)
        }
      })
    const listed: Interface["listed"] = () => Effect.sync(() => inProcess.map((h) => h.name))
    const dispatch: Interface["dispatch"] = (input) =>
      Effect.gen(function* () {
        const eventName = input.event.hook_event_name
        const cwd = input.cwd ?? process.cwd()
        const payload = buildPayload(input, cwd)
        const responses: HookResponse[] = []
        for (const reg of inProcess) {
          if (reg.event !== undefined && reg.event !== eventName) continue
          if (!matches(reg.matcher, input.event)) continue
          const result = yield* reg.run(payload).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed<HookResult>({
                kind: "failed_continue",
                error: `in-process hook '${reg.name}' failed: ${String(cause)}`,
              }),
            ),
          )
          responses.push({ hook_name: reg.name, result })
          if (shouldAbort(result)) return reduceResponses(responses)
        }
        return reduceResponses(responses)
      })
    return Service.of({ register, listed, dispatch })
  }),
)
