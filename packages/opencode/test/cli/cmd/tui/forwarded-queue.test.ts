import { describe, expect, test } from "bun:test"
import { ForwardedQueue } from "../../../../src/cli/cmd/tui/routes/session/forwarded-queue"
import type { QuestionForwardedToParent } from "@opencode-ai/sdk/v2"

function entry(overrides: Partial<QuestionForwardedToParent> & { requestID: string }): QuestionForwardedToParent {
  const base: QuestionForwardedToParent = {
    parentID: "ses_parent",
    childID: "ses_child",
    requestID: overrides.requestID,
    request: {
      id: overrides.requestID,
      sessionID: overrides.childID ?? "ses_child",
      questions: [
        {
          question: "May I proceed?",
          header: "proceed",
          options: [
            { label: "Allow", description: "approve" },
            { label: "Deny", description: "deny" },
          ],
        },
      ],
    },
  }
  return { ...base, ...overrides }
}

describe("ForwardedQueue (TUI routing)", () => {
  test("empty() starts with no parents", () => {
    const s = ForwardedQueue.empty()
    expect(ForwardedQueue.list(s, "ses_anything")).toEqual([])
    expect(ForwardedQueue.head(s, "ses_anything")).toBeUndefined()
  })

  test("push preserves FIFO order across multiple children asking the same parent", () => {
    let s = ForwardedQueue.empty()
    s = ForwardedQueue.push(s, entry({ requestID: "que_1", childID: "ses_a" }))
    s = ForwardedQueue.push(s, entry({ requestID: "que_2", childID: "ses_b" }))
    s = ForwardedQueue.push(s, entry({ requestID: "que_3", childID: "ses_c" }))

    const list = ForwardedQueue.list(s, "ses_parent")
    expect(list).toHaveLength(3)
    expect(list.map((e) => e.requestID)).toEqual(["que_1", "que_2", "que_3"])
    expect(ForwardedQueue.head(s, "ses_parent")?.requestID).toBe("que_1")
  })

  test("push deduplicates by requestID (idempotent against double delivery)", () => {
    let s = ForwardedQueue.empty()
    const e1 = entry({ requestID: "que_1" })
    s = ForwardedQueue.push(s, e1)
    const before = s
    s = ForwardedQueue.push(s, e1)
    expect(s).toBe(before)
    expect(ForwardedQueue.list(s, "ses_parent")).toHaveLength(1)
  })

  test("push keeps separate queues per parent", () => {
    let s = ForwardedQueue.empty()
    s = ForwardedQueue.push(s, entry({ requestID: "que_1", parentID: "ses_p1" }))
    s = ForwardedQueue.push(s, entry({ requestID: "que_2", parentID: "ses_p2" }))

    expect(ForwardedQueue.list(s, "ses_p1").map((e) => e.requestID)).toEqual(["que_1"])
    expect(ForwardedQueue.list(s, "ses_p2").map((e) => e.requestID)).toEqual(["que_2"])
  })

  test("dismissByRequestID removes the correct entry without disturbing order", () => {
    let s = ForwardedQueue.empty()
    s = ForwardedQueue.push(s, entry({ requestID: "que_1" }))
    s = ForwardedQueue.push(s, entry({ requestID: "que_2" }))
    s = ForwardedQueue.push(s, entry({ requestID: "que_3" }))

    s = ForwardedQueue.dismissByRequestID(s, "que_2")

    const list = ForwardedQueue.list(s, "ses_parent")
    expect(list.map((e) => e.requestID)).toEqual(["que_1", "que_3"])
  })

  test("dismissByRequestID on head promotes the next entry", () => {
    let s = ForwardedQueue.empty()
    s = ForwardedQueue.push(s, entry({ requestID: "que_1" }))
    s = ForwardedQueue.push(s, entry({ requestID: "que_2" }))

    expect(ForwardedQueue.head(s, "ses_parent")?.requestID).toBe("que_1")
    s = ForwardedQueue.dismissByRequestID(s, "que_1")
    expect(ForwardedQueue.head(s, "ses_parent")?.requestID).toBe("que_2")
  })

  test("dismissByRequestID drops parent entry entirely once queue is empty", () => {
    let s = ForwardedQueue.empty()
    s = ForwardedQueue.push(s, entry({ requestID: "que_1" }))
    s = ForwardedQueue.dismissByRequestID(s, "que_1")
    expect(ForwardedQueue.list(s, "ses_parent")).toEqual([])
    expect(Object.keys(s.byParent)).not.toContain("ses_parent")
  })

  test("dismissByRequestID for unknown requestID is a no-op (returns same reference)", () => {
    let s = ForwardedQueue.empty()
    s = ForwardedQueue.push(s, entry({ requestID: "que_1" }))
    const before = s
    s = ForwardedQueue.dismissByRequestID(s, "que_missing")
    expect(s).toBe(before)
  })
})
