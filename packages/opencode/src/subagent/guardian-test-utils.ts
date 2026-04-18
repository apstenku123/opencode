/**
 * Test-only utilities for {@link Guardian}. Builds synthetic
 * {@link Question.Request} payloads without touching the bus so unit
 * tests can drive `Guardian.decide` directly.
 *
 * Not re-exported from any public index — callers must import this path
 * explicitly. Keep this file TEST-scope only; production code MUST NOT
 * depend on it.
 */

import { Schema } from "effect"
import { Question } from "@/question"
import { SessionID } from "@/session/schema"
import { QuestionID } from "@/question/schema"
import { Permission } from "@/permission"
import { Guardian } from "./guardian"

export namespace GuardianTestUtils {
  export function makeRequest(input: {
    sessionID: string
    header?: string
    question?: string
    options?: Array<{ label: string; description: string }>
    multiple?: boolean
    id?: string
  }): Question.Request {
    const header = input.header ?? "approve-subagent-action"
    return Schema.decodeUnknownSync(Question.Request)({
      id: input.id ?? QuestionID.ascending(),
      sessionID: SessionID.make(input.sessionID),
      questions: [
        {
          question: input.question ?? `May the sub-agent proceed with ${header}?`,
          header,
          options: input.options ?? [
            { label: "yes", description: "approve" },
            { label: "no", description: "reject" },
          ],
          multiple: input.multiple,
        },
      ],
    })
  }

  /**
   * Convenience: run {@link Guardian.decide} against a request using a
   * provided parent ruleset. Mirrors the production `lookup` path without
   * the `Session.Service` round-trip.
   */
  export function decideAgainst(
    request: Question.Request,
    parentID: string | undefined,
    ruleset: Permission.Ruleset,
  ): Guardian.Decision {
    return Guardian.decide({
      request,
      parentID: parentID ? SessionID.make(parentID) : undefined,
      parentRuleset: ruleset,
    })
  }

  /**
   * Build a parent ruleset that auto-approves questions matching the
   * supplied header pattern under the canonical `"subagent"` permission key.
   */
  export function allowHeader(pattern: string): Permission.Ruleset {
    return [{ permission: Guardian.PERMISSION_KEY, pattern, action: "allow" }]
  }

  export function denyHeader(pattern: string): Permission.Ruleset {
    return [{ permission: Guardian.PERMISSION_KEY, pattern, action: "deny" }]
  }
}
