/**
 * opencode Hook subsystem.
 *
 * Ports `codex-rs/hooks/*` — a 17-event hook framework that dispatches
 * user-configured subprocesses (and in-process hooks) at well-known
 * lifecycle points (SessionStart, PreToolUse, Stop, SubagentStart, …).
 *
 * Callers use `Hook.Service` to `dispatch` an event — each event routes
 * through zero or more command hooks configured under
 * `experimental.hooks.<EventName>` plus in-process hooks registered at
 * service construction time.
 */
export * from "./types"
export * from "./command"
export {
  Service,
  layer,
  defaultLayer,
  noopLayer,
  buildPayload,
  reduceResponses,
  getCommandHooksFor,
  type DispatchInput,
  type HookDispatchOutcome,
  type HookDispatchResult,
  type Interface,
  type RegisteredHook,
  type InProcessHookFn,
} from "./registry"
