/**
 * Subprocess dispatcher for a single configured command hook.
 *
 * Ports `codex-rs/hooks/src/command_hook.rs`. A hook is a shell command or
 * argv spawned per-event. The hook payload is JSON-encoded onto stdin; the
 * hook exit code and stdout JSON are interpreted per the Claude Code /
 * codex-hooks spec:
 *
 * - exit 0, empty stdout                          → Success(no-op)
 * - exit 0, valid JSON                            → Success(parsed fields)
 * - exit 0, valid JSON w/ `decision: "block"`     → FailedAbort(reason)
 * - exit 0, valid JSON w/ `continue: false`       → FailedAbort(stopReason)
 * - exit 0, `permissionDecision: "deny"` for PreToolUse → FailedAbort
 * - exit 0, `permissionDecision: "ask"` for PreToolUse  → FailedContinue
 * - exit 2                                        → FailedAbort(stderr)
 * - other non-zero                                → FailedContinue(stderr)
 * - spawn error / timeout                         → FailedContinue(err)
 *
 * Shell resolution:
 * - `command: string[]` → argv (no shell interpolation)
 * - `command: string`   → invoked via `Shell.preferred()` with `-c`
 */
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Shell } from "@/shell/shell"
import {
  CommandHookOutput,
  type HookEvent,
  type HookPayload,
  type HookResult,
  HookResultFailedAbort,
  HookResultFailedContinue,
  HookResultSuccess,
  serializeHookPayload,
} from "./types"

/** Default hook timeout (ms). Matches Rust `command_hook.rs` 600s default. */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

export interface HookCommandEntry {
  readonly name: string
  readonly command: string | ReadonlyArray<string>
  /** Optional regex matched against `matchTargetFor(event)`. */
  readonly matcher?: string
  /** Optional group label (e.g. `stop-hooks`). */
  readonly group?: string
  readonly timeoutMs?: number
}

/**
 * Run a single configured command hook. Always resolves to a `HookResult`;
 * never throws. The caller decides how to aggregate multiple results.
 */
type Captured = {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunCommandHookInput {
  readonly hook: HookCommandEntry
  readonly payload: HookPayload
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly cwd?: string
}

export const runCommandHook = (input: RunCommandHookInput): Effect.Effect<HookResult> =>
  Effect.gen(function* () {
    const { hook, payload, spawner } = input
    const cwd = input.cwd ?? payload.cwd
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS

    let program: string
    let args: string[]
    if (Array.isArray(hook.command)) {
      if (hook.command.length === 0) return HookResultSuccess()
      program = hook.command[0]
      args = hook.command.slice(1)
    } else {
      program = Shell.preferred()
      args = ["-c", hook.command as string]
    }

    const json = JSON.stringify(serializeHookPayload(payload))
    const stdinBytes = new TextEncoder().encode(json)

    const captured: Captured | null = yield* Effect.gen(function* () {
      const proc = ChildProcess.make(program, args, {
        cwd,
        extendEnv: true,
        env: {
          TERM: "dumb",
          CLAUDE_PROJECT_DIR: cwd,
          OPENCODE_HOOK_EVENT: payload.hook_event.hook_event_name,
        },
        stdin: Stream.make(stdinBytes),
        forceKillAfter: "1 second",
      })
      const handle = yield* spawner.spawn(proc)
      const stdoutP = Stream.mkString(Stream.decodeText(handle.stdout))
      const stderrP = Stream.mkString(Stream.decodeText(handle.stderr))
      const [stdout, stderr] = yield* Effect.all([stdoutP, stderrP], { concurrency: 2 })
      const exitCode = yield* handle.exitCode
      return { stdout, stderr, exitCode } satisfies Captured
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeoutMs),
      Effect.catchCause(() => Effect.succeed<Captured | null>(null)),
    )

    if (!captured) return HookResultFailedContinue("hook command timed out or spawn failed")

    return interpretOutput({ event: payload.hook_event, captured })
  })

/**
 * Pure interpretation of captured stdout/stderr/exitCode per the hook
 * spec. Exported for unit tests that mock subprocess IO.
 */
export function interpretOutput(input: {
  event: HookEvent
  captured: { stdout: string; stderr: string; exitCode: number }
}): HookResult {
  const { event, captured } = input
  const stdoutText = captured.stdout.trim()
  const stderrText = captured.stderr.trim()
  const exitCode = captured.exitCode

  if (exitCode === 2) {
    return HookResultFailedAbort(stderrText || "Hook exited with code 2 (blocking error)")
  }
  if (exitCode !== 0) {
    return HookResultFailedContinue(stderrText || `Hook exited with code ${exitCode}`)
  }

  // exit 0
  if (stdoutText.length === 0) return HookResultSuccess()

  const parsed = safeParseJSON(stdoutText)
  if (parsed === null) {
    // SessionStart preserves plain text as additional_context; others are no-op.
    if (event.hook_event_name === "SessionStart") {
      if (stdoutText.startsWith("{") || stdoutText.startsWith("[")) {
        return HookResultFailedContinue("hook returned invalid session start JSON output")
      }
      return HookResultSuccess({ additional_context: stdoutText })
    }
    return HookResultSuccess()
  }

  const outParse = CommandHookOutput.safeParse(parsed)
  if (!outParse.success) return HookResultSuccess()
  const output = outParse.data

  // continue: false — abort chain.
  if (output.continue === false) {
    return HookResultFailedAbort(output.stopReason ?? "Hook stopped execution")
  }
  // decision: "block" — abort.
  if (output.decision === "block") {
    return HookResultFailedAbort(output.reason ?? "Blocked by hook")
  }

  let updated_input: unknown | undefined
  let updated_output: unknown | undefined
  let updated_permissions: unknown | undefined
  let decision_behavior: string | undefined
  let decision_message: string | undefined
  let decision_interrupt = false
  const hso = output.hookSpecificOutput

  if (hso?.permissionDecision !== undefined) {
    const pd = hso.permissionDecision
    if (event.hook_event_name === "PreToolUse") {
      if (pd === "allow") {
        // allowed — no side effect beyond optional updatedInput.
      } else if (pd === "deny") {
        return HookResultFailedAbort(hso.permissionDecisionReason ?? "denied by hook")
      } else if (pd === "ask") {
        return HookResultFailedContinue(
          hso.permissionDecisionReason ?? "hook requests user approval",
        )
      } else {
        return HookResultFailedAbort(`unsupported permissionDecision '${pd}'`)
      }
    } else if (event.hook_event_name === "PermissionRequest") {
      if (pd === "allow" || pd === "deny" || pd === "ask") {
        decision_behavior = pd
        decision_message = hso.permissionDecisionReason
      } else {
        return HookResultFailedAbort(`unsupported permissionDecision '${pd}'`)
      }
    } else {
      return HookResultFailedAbort(
        `hook output field 'hookSpecificOutput.permissionDecision' is not supported for ${event.hook_event_name}`,
      )
    }
  }

  if (hso?.updatedMCPToolOutput !== undefined) {
    if (event.hook_event_name === "PostToolUse") {
      updated_output = hso.updatedMCPToolOutput
    } else {
      return HookResultFailedAbort(
        `hook output field 'hookSpecificOutput.updatedMCPToolOutput' is not supported for ${event.hook_event_name}`,
      )
    }
  }

  if (hso?.updatedInput !== undefined) {
    if (
      event.hook_event_name === "PreToolUse" ||
      event.hook_event_name === "PermissionRequest"
    ) {
      updated_input = hso.updatedInput
    } else {
      return HookResultFailedAbort(
        `hook output field 'hookSpecificOutput.updatedInput' is not supported for ${event.hook_event_name}`,
      )
    }
  }

  if (hso?.decision !== undefined) {
    const d = hso.decision
    if (event.hook_event_name === "PermissionRequest") {
      if (d.updatedInput !== undefined) updated_input = d.updatedInput
      if (d.updatedPermissions !== undefined) updated_permissions = d.updatedPermissions
      if (d.behavior !== undefined) decision_behavior = d.behavior
      if (d.message !== undefined) decision_message = d.message
      if (d.interrupt !== undefined) decision_interrupt = d.interrupt
    } else {
      if (d.updatedInput !== undefined)
        return HookResultFailedAbort(
          `hook output field 'hookSpecificOutput.decision.updatedInput' is not supported for ${event.hook_event_name}`,
        )
      if (d.updatedPermissions !== undefined)
        return HookResultFailedAbort(
          `hook output field 'hookSpecificOutput.decision.updatedPermissions' is not supported for ${event.hook_event_name}`,
        )
      if (d.message !== undefined)
        return HookResultFailedAbort(
          `hook output field 'hookSpecificOutput.decision.message' is not supported for ${event.hook_event_name}`,
        )
      if (d.interrupt === true)
        return HookResultFailedAbort(
          `hook output field 'hookSpecificOutput.decision.interrupt' is not supported for ${event.hook_event_name}`,
        )
      if (d.behavior !== undefined)
        return HookResultFailedAbort(
          `hook output field 'hookSpecificOutput.decision.behavior' is not supported for ${event.hook_event_name}`,
        )
    }
  }

  const additional_context = hso?.additionalContext ?? output.additionalContext

  return HookResultSuccess({
    additional_context,
    updated_input,
    updated_output,
    updated_permissions,
    decision_behavior,
    decision_message,
    decision_interrupt,
    system_message: output.systemMessage,
    suppress_output: output.suppressOutput ?? false,
  })
}

function safeParseJSON(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
