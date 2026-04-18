import { RequestError, type AgentSideConnection, type PermissionOption } from "@agentclientprotocol/sdk"
import { Log } from "../util"

/**
 * ACP elicitation — out-of-band user-input requests issued by the agent
 * mid-turn. The Rust `acp-server` sends these as permission-style prompts
 * carrying an `_meta.elicitation` extension; any ACP client that
 * understands the extension surfaces them as free-form text input, and
 * clients that don't fall back to the underlying permission dialog.
 *
 * We piggy-back on `requestPermission`, but tag the tool-call metadata so
 * clients opting into the extension can render a text-entry UI. The
 * response's `optionId` is interpreted as the elicited value (or a
 * sentinel `__elicitation_cancel__` for explicit cancel).
 *
 * Parity with Rust `codex-rs/acp-server/src/server.rs::elicitation`:
 * increments a per-session counter, writes the elicitation text into the
 * permission rawInput block, and rejects with `ElicitationCancelled` if
 * the user declines.
 *
 * This module is deliberately transport-only: it does not persist state
 * across process restarts. Callers (Agent) own the per-session counter
 * so the ACP session state can be serialised.
 */
export namespace Elicitation {
  const log = Log.create({ service: "acp-elicitation" })

  export const CANCEL_OPTION_ID = "__elicitation_cancel__"
  export const SUBMIT_OPTION_ID = "__elicitation_submit__"
  export const META_KEY = "elicitation"

  export interface Request {
    /** ACP session id */
    sessionId: string
    /** Stable id for this elicitation (used for the synthetic toolCallId) */
    id: string
    /** Short question/prompt shown to the user */
    prompt: string
    /** Optional additional context / help text for the UI */
    description?: string
    /** Optional default value the UI may pre-fill */
    defaultValue?: string
    /** Optional list of discrete choices; if omitted the UI is free-form */
    choices?: Array<{ value: string; label?: string }>
    /** Called when the user explicitly cancels */
    onCancel?: () => void
  }

  export interface Response {
    /** Whether the user submitted or cancelled */
    outcome: "submitted" | "cancelled"
    /** The text value the user entered (or the selected choice's value) */
    value?: string
  }

  /**
   * Options we offer via `requestPermission`. A client that understands the
   * `_meta.elicitation` extension ignores these and drives its own UI —
   * when the user submits free-text the client should return
   * `optionId = <SUBMIT_OPTION_ID>` plus `_meta.elicitation.value = <text>`.
   * A legacy client without the extension treats it as a binary
   * submit/cancel prompt with no text input.
   */
  export function permissionOptions(req: Request): PermissionOption[] {
    if (req.choices && req.choices.length > 0) {
      return [
        ...req.choices.map(
          (choice, i): PermissionOption => ({
            optionId: `choice_${i}_${choice.value}`,
            kind: i === 0 ? "allow_once" : "allow_once",
            name: choice.label ?? choice.value,
          }),
        ),
        {
          optionId: CANCEL_OPTION_ID,
          kind: "reject_once",
          name: "Cancel",
        },
      ]
    }
    return [
      {
        optionId: SUBMIT_OPTION_ID,
        kind: "allow_once",
        name: "Submit",
      },
      {
        optionId: CANCEL_OPTION_ID,
        kind: "reject_once",
        name: "Cancel",
      },
    ]
  }

  /**
   * Build the `_meta` block the ACP client reads to recognise this
   * permission request as an elicitation. Shape follows the Rust
   * `acp-server` extension: a namespaced object keyed by `elicitation`.
   */
  export function buildMeta(req: Request): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      id: req.id,
      prompt: req.prompt,
    }
    if (req.description !== undefined) meta["description"] = req.description
    if (req.defaultValue !== undefined) meta["defaultValue"] = req.defaultValue
    if (req.choices && req.choices.length > 0) meta["choices"] = req.choices
    return { [META_KEY]: meta }
  }

  /**
   * Parse a `requestPermission` response into an elicitation outcome.
   * Extracts the free-text value from the client-returned `_meta.elicitation.value`
   * if the client supports the extension, else falls back to mapping
   * choice-option ids to their values, else returns `{ outcome: "cancelled" }`.
   */
  export function parseOutcome(
    req: Request,
    raw: { outcome: { outcome: "cancelled" | "selected"; optionId?: string }; _meta?: Record<string, unknown> } | null,
  ): Response {
    if (!raw || raw.outcome.outcome === "cancelled") {
      return { outcome: "cancelled" }
    }
    const optionId = raw.outcome.optionId
    if (optionId === CANCEL_OPTION_ID) {
      return { outcome: "cancelled" }
    }

    // Client-supplied free-text via extension meta
    const metaBlob = raw._meta?.[META_KEY]
    if (metaBlob && typeof metaBlob === "object" && metaBlob !== null) {
      const value = (metaBlob as Record<string, unknown>)["value"]
      if (typeof value === "string") {
        return { outcome: "submitted", value }
      }
    }

    // Choice shortcut: optionId = "choice_<i>_<value>"
    if (optionId && optionId.startsWith("choice_")) {
      const idx = optionId.indexOf("_", "choice_".length)
      if (idx > 0) {
        return { outcome: "submitted", value: optionId.slice(idx + 1) }
      }
    }

    // Legacy submit without payload — accept default or empty string
    if (optionId === SUBMIT_OPTION_ID) {
      return { outcome: "submitted", value: req.defaultValue ?? "" }
    }

    return { outcome: "cancelled" }
  }

  /**
   * Drive an elicitation round-trip over an `AgentSideConnection`.
   * Returns the user-supplied value or `undefined` if cancelled.
   */
  export async function ask(
    connection: Pick<AgentSideConnection, "requestPermission">,
    req: Request,
  ): Promise<Response> {
    log.info("elicitation.ask", { sessionId: req.sessionId, id: req.id, prompt: req.prompt })
    const meta = buildMeta(req)
    let raw:
      | { outcome: { outcome: "cancelled" | "selected"; optionId?: string }; _meta?: Record<string, unknown> }
      | null = null
    try {
      raw = (await connection.requestPermission({
        sessionId: req.sessionId,
        toolCall: {
          toolCallId: `elicitation_${req.id}`,
          status: "pending",
          title: req.prompt,
          kind: "other",
          locations: [],
          rawInput: {
            prompt: req.prompt,
            description: req.description,
            defaultValue: req.defaultValue,
            choices: req.choices,
          },
          _meta: meta,
        },
        options: permissionOptions(req),
      })) as any
    } catch (error) {
      log.error("elicitation.requestPermission failed", { error, id: req.id })
      return { outcome: "cancelled" }
    }

    const parsed = parseOutcome(req, raw)
    if (parsed.outcome === "cancelled" && req.onCancel) {
      req.onCancel()
    }
    return parsed
  }

  /**
   * Increments and returns a per-session out-of-band elicitation counter.
   * Mirrors Rust's `Session::out_of_band_elicitation_count` and is used
   * by agent loops that need to cap the number of mid-turn user prompts.
   */
  export class Counter {
    private counts = new Map<string, number>()

    next(sessionId: string): number {
      const n = (this.counts.get(sessionId) ?? 0) + 1
      this.counts.set(sessionId, n)
      return n
    }

    get(sessionId: string): number {
      return this.counts.get(sessionId) ?? 0
    }

    reset(sessionId: string): void {
      this.counts.delete(sessionId)
    }
  }

  /**
   * Convenience: throw a RequestError when the caller requires a value
   * but the user cancelled. Mirrors Rust `ElicitationCancelled`.
   */
  export function requireValue(response: Response, context: string): string {
    if (response.outcome === "cancelled" || response.value === undefined) {
      throw RequestError.invalidParams(JSON.stringify({ error: `Elicitation cancelled: ${context}` }))
    }
    return response.value
  }
}
