import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  compactWindowReaderFromSession,
  detectSkippedPlanStep,
  parseCompactText,
} from "@/autobest/compact"
import type { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"

describe("autobest/compact — parseCompactText", () => {
  test("extracts plan items from '## Plan' section", () => {
    const out = parseCompactText(`
Intro line.
## Plan
- write the test
- ship the patch
## Done
- baseline
`)
    expect(out.actionItems).toEqual(["write the test", "ship the patch"])
    // "## Done" is recognised as a done-section heading.
    expect(out.completed).toEqual(["baseline"])
  })

  test("separates accomplished + plan sections", () => {
    const out = parseCompactText(`
## Accomplished
- tests written
- lint green
## Next Steps
1. deploy the branch
2. update changelog
`)
    expect(out.completed).toEqual(["tests written", "lint green"])
    expect(out.actionItems).toEqual(["deploy the branch", "update changelog"])
  })

  test("falls back to top-level bullets when no sections present", () => {
    const out = parseCompactText(`- alpha\n- beta\n- gamma`)
    expect(out.actionItems).toEqual(["alpha", "beta", "gamma"])
    expect(out.completed).toEqual([])
  })

  test("handles numbered lists with both '.' and ')' delimiters", () => {
    const out = parseCompactText(`## Plan\n1. first\n2) second`)
    expect(out.actionItems).toEqual(["first", "second"])
  })

  test("normalises heading case and punctuation", () => {
    const out = parseCompactText(`## NEXT STEPS:\n- item`)
    expect(out.actionItems).toEqual(["item"])
  })

  test("returns empty sets for compact summary with only prose", () => {
    const out = parseCompactText(`## Goal\nThe user asked about X.\n## Discoveries\nFound Y.`)
    expect(out.actionItems).toEqual([])
    expect(out.completed).toEqual([])
  })
})

describe("autobest/compact — detectSkippedPlanStep", () => {
  const w = { id: 1, actionItems: ["deploy the branch", "update changelog"], completed: [] }

  test("returns first unfinished item not mentioned in tail", () => {
    expect(
      detectSkippedPlanStep({ window: w, assistantTail: "I wrote tests and then stopped." }),
    ).toBe("deploy the branch")
  })

  test("skips items mentioned verbatim in tail", () => {
    expect(
      detectSkippedPlanStep({
        window: w,
        assistantTail: "Next, I will deploy the branch and hand off.",
      }),
    ).toBe("update changelog")
  })

  test("returns undefined when tail covers every item", () => {
    expect(
      detectSkippedPlanStep({
        window: w,
        assistantTail: "I will deploy the branch and update changelog now.",
      }),
    ).toBeUndefined()
  })

  test("respects completed set", () => {
    expect(
      detectSkippedPlanStep({
        window: { ...w, completed: ["deploy the branch"] },
        assistantTail: "unrelated text",
      }),
    ).toBe("update changelog")
  })

  test("ignores short plan items to avoid false positives", () => {
    const out = detectSkippedPlanStep({
      window: { id: 1, actionItems: ["go", "do"], completed: [] },
      assistantTail: "anything",
    })
    expect(out).toBeUndefined()
  })
})

describe("autobest/compact — compactWindowReaderFromSession", () => {
  function fakeSession(msgs: MessageV2.WithParts[]): Session.Interface {
    return {
      messages: () => Effect.succeed(msgs),
    } as unknown as Session.Interface
  }
  const asst = (summary: boolean, text: string): MessageV2.WithParts =>
    ({
      info: { role: "assistant", summary },
      parts: [{ type: "text", text }],
    }) as unknown as MessageV2.WithParts

  test("returns undefined when no summary assistant messages exist", async () => {
    const reader = compactWindowReaderFromSession(fakeSession([asst(false, "hi")]))
    const out = await Effect.runPromise(reader("sess_x"))
    expect(out).toBeUndefined()
  })

  test("returns parsed window from the latest summary message", async () => {
    const msgs = [
      asst(true, "## Plan\n- old step"),
      asst(false, "regular assistant reply"),
      asst(true, "## Plan\n- new step 1\n- new step 2"),
      asst(false, "more regular reply"),
    ]
    const reader = compactWindowReaderFromSession(fakeSession(msgs))
    const out = await Effect.runPromise(reader("sess_x"))
    expect(out).toBeDefined()
    expect(out?.actionItems).toEqual(["new step 1", "new step 2"])
  })

  test("skips summary assistant messages with empty text", async () => {
    const msgs = [asst(true, "## Plan\n- real step"), asst(true, "")]
    const reader = compactWindowReaderFromSession(fakeSession(msgs))
    const out = await Effect.runPromise(reader("sess_x"))
    expect(out?.actionItems).toEqual(["real step"])
  })

  test("returns undefined when session.messages throws", async () => {
    const session = {
      messages: () => Effect.fail(new Error("not found")),
    } as unknown as Session.Interface
    const reader = compactWindowReaderFromSession(session)
    const out = await Effect.runPromise(reader("sess_x"))
    expect(out).toBeUndefined()
  })
})
