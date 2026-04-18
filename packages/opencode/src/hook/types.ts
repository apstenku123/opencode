/**
 * Type definitions for the opencode Hook subsystem.
 *
 * Ports the Rust `codex-hooks` crate (`codex-rs/hooks/src/types.rs`) to
 * TypeScript. The wire shape is kept stable with the Rust serialization so
 * that external hook scripts written against Claude Code / codex-rs hooks
 * continue to work when targeted at opencode.
 *
 * Event kinds covered (17 total — matches `HookEvent` enum in Rust):
 *
 *   - `SessionStart` / `SessionEnd`
 *   - `UserPromptSubmit` (replaces "UserMessage" naming)
 *   - `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `AfterToolUse`
 *   - `AfterAgent` (turn-end — analogous to "AssistantMessage")
 *   - `Stop` (existing opencode behaviour — `stopHooks`)
 *   - `SubagentStart` / `SubagentStop`
 *   - `PermissionRequest`
 *   - `PreCompact` / `PostCompact`
 *   - `Notification` / `ConfigChange` / `InstructionsLoaded`
 *   - `TeammateIdle` / `TaskCompleted`
 *   - `WorktreeCreate` / `WorktreeRemove`
 *
 * The TS schemas use zod for runtime validation and double as the source of
 * truth for `Hook.dispatch` payloads.
 */
import { z } from "zod"

export const HookEventName = z.enum([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "AfterToolUse",
  "AfterAgent",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Notification",
  "ConfigChange",
  "InstructionsLoaded",
  "TeammateIdle",
  "TaskCompleted",
  "WorktreeCreate",
  "WorktreeRemove",
])
export type HookEventName = z.infer<typeof HookEventName>

/**
 * The 17 (+3) event kinds opencode fires. Names mirror
 * `HookEventName` so a hook script can discriminate via `hook_event_name`.
 */

export const HookSessionSourceKind = z.enum([
  "cli",
  "vscode",
  "exec",
  "acp",
  "mcp",
  "sub_agent",
  "unknown",
])
export type HookSessionSourceKind = z.infer<typeof HookSessionSourceKind>

export const HookSubagentSourceKind = z.enum([
  "review",
  "compact",
  "thread_spawn",
  "memory_consolidation",
  "other",
])
export type HookSubagentSourceKind = z.infer<typeof HookSubagentSourceKind>

export const HookSubagentContext = z.object({
  source: HookSubagentSourceKind,
  parent_session_id: z.string().optional(),
  depth: z.number().int().optional(),
  agent_nickname: z.string().optional(),
  agent_role: z.string().optional(),
  detail: z.string().optional(),
})
export type HookSubagentContext = z.infer<typeof HookSubagentContext>

export const HookSessionContext = z.object({
  source: HookSessionSourceKind,
  subagent: HookSubagentContext.optional(),
})
export type HookSessionContext = z.infer<typeof HookSessionContext>

export const HookToolKind = z.enum(["function", "custom", "local_shell", "mcp"])
export type HookToolKind = z.infer<typeof HookToolKind>

// --- per-event payload shapes ---------------------------------------------

const EventStop = z.object({
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().nullable().optional(),
})

const EventSessionStart = z.object({
  hook_event_name: z.literal("SessionStart"),
  source: z.string(),
  model: z.string(),
  /**
   * Absolute path to the session's rollout JSONL file on disk, when the
   * session has one (Stream G / rollout subsystem). Scripts that tail or
   * post-process rollouts can pick this up directly from the payload.
   */
  rolloutPath: z.string().optional(),
})

const EventSessionEnd = z.object({
  hook_event_name: z.literal("SessionEnd"),
  reason: z.string(),
  /** See `EventSessionStart.rolloutPath`. */
  rolloutPath: z.string().optional(),
})

const EventUserPromptSubmit = z.object({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
})

const EventPreToolUse = z.object({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string().optional(),
})

const EventPostToolUse = z.object({
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_response: z.unknown(),
  tool_use_id: z.string(),
})

const EventPostToolUseFailure = z.object({
  hook_event_name: z.literal("PostToolUseFailure"),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string(),
  error: z.string(),
  is_interrupt: z.boolean(),
})

const EventAfterToolUse = z.object({
  hook_event_name: z.literal("AfterToolUse"),
  turn_id: z.string(),
  call_id: z.string(),
  tool_name: z.string(),
  tool_kind: HookToolKind,
  tool_input: z.unknown(),
  executed: z.boolean(),
  success: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  mutating: z.boolean(),
  sandbox: z.string(),
  sandbox_policy: z.string(),
  output_preview: z.string(),
})

const EventAfterAgent = z.object({
  hook_event_name: z.literal("AfterAgent"),
  thread_id: z.string(),
  turn_id: z.string(),
  input_messages: z.array(z.string()),
  last_assistant_message: z.string().nullable().optional(),
})

const EventSubagentStart = z.object({
  hook_event_name: z.literal("SubagentStart"),
  agent_id: z.string(),
  agent_type: z.string(),
  // Round 7 Stream 3: explicit parent / child session identifiers and the
  // prompt string the subagent was spawned with. `agent_id` aliases the
  // child_session_id and is retained for wire compatibility with
  // codex-rs hooks. All three new fields are optional — hooks written
  // against the original shape keep working.
  parent_session_id: z.string().optional(),
  child_session_id: z.string().optional(),
  prompt: z.string().optional(),
})

const EventSubagentStop = z.object({
  hook_event_name: z.literal("SubagentStop"),
  stop_hook_active: z.boolean(),
  agent_id: z.string(),
  agent_type: z.string(),
  last_assistant_message: z.string().nullable().optional(),
  // Round 7 Stream 3: explicit parent / child session identifiers, the
  // summary (final assistant text or error message) and a normalized
  // completion reason. `reason` values: "completed" | "cancelled" | "failed".
  parent_session_id: z.string().optional(),
  child_session_id: z.string().optional(),
  summary: z.string().optional(),
  reason: z.enum(["completed", "cancelled", "failed"]).optional(),
})

const EventPermissionRequest = z.object({
  hook_event_name: z.literal("PermissionRequest"),
  tool_name: z.string(),
  tool_input: z.unknown(),
})

const EventPreCompact = z.object({
  hook_event_name: z.literal("PreCompact"),
  trigger: z.string(),
  custom_instructions: z.string(),
  /** Number of messages present in the session prior to compaction. */
  message_count: z.number().int().nonnegative().optional(),
  /** Estimated token count of the session before compaction runs. */
  token_count_before: z.number().int().nonnegative().optional(),
})

const EventPostCompact = z.object({
  hook_event_name: z.literal("PostCompact"),
  trigger: z.string(),
  /** Count of messages retained post-compaction (summary + replay + continue). */
  kept_messages: z.number().int().nonnegative(),
  /** Count of messages collapsed into the summary. */
  dropped_messages: z.number().int().nonnegative(),
  /** Estimated token count after compaction (summary + any retained turns). */
  token_count_after: z.number().int().nonnegative(),
  /** Text of the generated compaction summary. May be empty if none found. */
  summary: z.string(),
})

const EventNotification = z.object({
  hook_event_name: z.literal("Notification"),
  message: z.string(),
  title: z.string().optional(),
  notification_type: z.string(),
})

const EventConfigChange = z.object({
  hook_event_name: z.literal("ConfigChange"),
  source: z.string(),
  file_path: z.string().optional(),
})

const EventInstructionsLoaded = z.object({
  hook_event_name: z.literal("InstructionsLoaded"),
  file_path: z.string(),
  memory_type: z.string(),
  load_reason: z.string(),
  globs: z.array(z.string()).optional(),
  trigger_file_path: z.string().optional(),
  parent_file_path: z.string().optional(),
})

const EventTeammateIdle = z.object({
  hook_event_name: z.literal("TeammateIdle"),
  teammate_name: z.string(),
  team_name: z.string(),
})

const EventTaskCompleted = z.object({
  hook_event_name: z.literal("TaskCompleted"),
  task_id: z.string(),
  task_subject: z.string(),
  task_description: z.string().optional(),
  teammate_name: z.string().optional(),
  team_name: z.string().optional(),
})

const EventWorktreeCreate = z.object({
  hook_event_name: z.literal("WorktreeCreate"),
  name: z.string(),
})

const EventWorktreeRemove = z.object({
  hook_event_name: z.literal("WorktreeRemove"),
  worktree_path: z.string(),
})

export const HookEvent = z.discriminatedUnion("hook_event_name", [
  EventStop,
  EventSessionStart,
  EventSessionEnd,
  EventUserPromptSubmit,
  EventPreToolUse,
  EventPostToolUse,
  EventPostToolUseFailure,
  EventAfterToolUse,
  EventAfterAgent,
  EventSubagentStart,
  EventSubagentStop,
  EventPermissionRequest,
  EventPreCompact,
  EventPostCompact,
  EventNotification,
  EventConfigChange,
  EventInstructionsLoaded,
  EventTeammateIdle,
  EventTaskCompleted,
  EventWorktreeCreate,
  EventWorktreeRemove,
])
export type HookEvent = z.infer<typeof HookEvent>

/**
 * Return the regex match target for an event (mirrors `HookEvent.match_target`
 * in Rust). Returns `undefined` for events that do not support filtering —
 * in that case the matcher is ignored and the hook fires unconditionally.
 */
export function matchTargetFor(event: HookEvent): string | undefined {
  switch (event.hook_event_name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "AfterToolUse":
    case "PermissionRequest":
      return event.tool_name
    case "Notification":
      return event.notification_type
    case "SessionStart":
    case "ConfigChange":
      return event.source
    case "SessionEnd":
      return event.reason
    case "SubagentStart":
    case "SubagentStop":
      return event.agent_type
    case "PreCompact":
    case "PostCompact":
      return event.trigger
    case "Stop":
      return event.last_assistant_message ?? undefined
    default:
      return undefined
  }
}

export const HookPayload = z.object({
  session_id: z.string(),
  agent_level: z.number().int(),
  session_context: HookSessionContext,
  cwd: z.string(),
  client: z.string().optional(),
  triggered_at: z.string(),
  permission_mode: z.string().optional(),
  transcript_path: z.string().optional(),
  // hook_event fields are flattened on the wire.
  hook_event: HookEvent,
})
export type HookPayload = z.infer<typeof HookPayload>

/**
 * Serialize a HookPayload to the Rust-compatible flat JSON shape: the
 * `hook_event` discriminated union fields are hoisted up into the payload
 * root alongside `hook_event_name`.
 */
export function serializeHookPayload(payload: HookPayload): Record<string, unknown> {
  const { hook_event, ...rest } = payload
  return {
    ...rest,
    ...hook_event,
  }
}

/**
 * Parsed stdout JSON from a command hook. Mirrors
 * `codex-rs/hooks/src/command_hook.rs:CommandHookOutput`.
 *
 * A successful (exit=0) hook may return JSON on stdout describing:
 *   - `decision: "block"` — abort the action (optionally with `reason`)
 *   - `continue: false`   — stop all further hook processing (`stopReason`)
 *   - `additionalContext` — extra text injected into the conversation
 *   - `systemMessage`     — a user-facing system note
 *   - `suppressOutput`    — hide verbose output
 *   - `hookSpecificOutput.{permissionDecision,updatedInput,updatedMCPToolOutput,decision}`
 */
export const HookDecision = z.object({
  behavior: z.string().optional(),
  updatedInput: z.unknown().optional(),
  updatedPermissions: z.unknown().optional(),
  message: z.string().optional(),
  interrupt: z.boolean().optional(),
})
export type HookDecision = z.infer<typeof HookDecision>

export const HookSpecificOutput = z.object({
  hookEventName: z.string().optional(),
  permissionDecision: z.string().optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.unknown().optional(),
  additionalContext: z.string().optional(),
  decision: HookDecision.optional(),
  updatedMCPToolOutput: z.unknown().optional(),
})
export type HookSpecificOutput = z.infer<typeof HookSpecificOutput>

export const CommandHookOutput = z.object({
  decision: z.string().optional(),
  reason: z.string().optional(),
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  hookSpecificOutput: HookSpecificOutput.optional(),
  additionalContext: z.string().optional(),
  systemMessage: z.string().optional(),
  suppressOutput: z.boolean().optional(),
})
export type CommandHookOutput = z.infer<typeof CommandHookOutput>

/**
 * Structured outcome from running a single hook. Mirrors
 * `codex-rs/hooks/src/types.rs:HookResult` — a union of
 * `Success`, `FailedContinue`, `FailedAbort`.
 */
export type HookResult =
  | {
      readonly kind: "success"
      readonly additional_context?: string
      readonly updated_input?: unknown
      readonly updated_output?: unknown
      readonly updated_permissions?: unknown
      readonly decision_behavior?: string
      readonly decision_message?: string
      readonly decision_interrupt: boolean
      readonly system_message?: string
      readonly suppress_output: boolean
    }
  | {
      readonly kind: "failed_continue"
      readonly error: string
    }
  | {
      readonly kind: "failed_abort"
      readonly error: string
    }

export const HookResultSuccess = (overrides: Partial<Extract<HookResult, { kind: "success" }>> = {}): HookResult => ({
  kind: "success",
  decision_interrupt: false,
  suppress_output: false,
  ...overrides,
})

export const HookResultFailedContinue = (error: string): HookResult => ({
  kind: "failed_continue",
  error,
})

export const HookResultFailedAbort = (error: string): HookResult => ({
  kind: "failed_abort",
  error,
})

export function shouldAbort(result: HookResult): boolean {
  return result.kind === "failed_abort"
}

export interface HookResponse {
  readonly hook_name: string
  readonly result: HookResult
}
