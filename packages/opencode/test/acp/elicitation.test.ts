import { describe, expect, test } from "bun:test"
import { Elicitation } from "../../src/acp/elicitation"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"

type RequestPermissionParams = Parameters<AgentSideConnection["requestPermission"]>[0]
type RequestPermissionResult = Awaited<ReturnType<AgentSideConnection["requestPermission"]>>

function fakeConnection(
  handler: (params: RequestPermissionParams) => RequestPermissionResult | Promise<RequestPermissionResult>,
) {
  const calls: RequestPermissionParams[] = []
  const connection: Pick<AgentSideConnection, "requestPermission"> = {
    async requestPermission(params: RequestPermissionParams) {
      calls.push(params)
      return await handler(params)
    },
  }
  return { connection, calls }
}

describe("Elicitation.buildMeta", () => {
  test("packs prompt, description, defaultValue, choices under 'elicitation' namespace", () => {
    const meta = Elicitation.buildMeta({
      sessionId: "ses_1",
      id: "oob_1",
      prompt: "Enter database URL",
      description: "Postgres connection string",
      defaultValue: "postgres://localhost/dev",
      choices: [{ value: "dev" }, { value: "prod", label: "Production" }],
    })
    expect(meta).toHaveProperty(Elicitation.META_KEY)
    const block = meta[Elicitation.META_KEY] as Record<string, unknown>
    expect(block.id).toBe("oob_1")
    expect(block.prompt).toBe("Enter database URL")
    expect(block.description).toBe("Postgres connection string")
    expect(block.defaultValue).toBe("postgres://localhost/dev")
    expect(block.choices).toEqual([{ value: "dev" }, { value: "prod", label: "Production" }])
  })

  test("omits undefined optional fields", () => {
    const meta = Elicitation.buildMeta({
      sessionId: "ses_1",
      id: "oob_1",
      prompt: "q",
    })
    const block = meta[Elicitation.META_KEY] as Record<string, unknown>
    expect(block).toEqual({ id: "oob_1", prompt: "q" })
  })
})

describe("Elicitation.permissionOptions", () => {
  test("returns submit+cancel when no choices given", () => {
    const opts = Elicitation.permissionOptions({ sessionId: "s", id: "i", prompt: "q" })
    expect(opts).toHaveLength(2)
    expect(opts[0].optionId).toBe(Elicitation.SUBMIT_OPTION_ID)
    expect(opts[1].optionId).toBe(Elicitation.CANCEL_OPTION_ID)
  })

  test("returns one option per choice plus cancel", () => {
    const opts = Elicitation.permissionOptions({
      sessionId: "s",
      id: "i",
      prompt: "q",
      choices: [{ value: "a" }, { value: "b", label: "Bee" }],
    })
    expect(opts).toHaveLength(3)
    expect(opts[0].name).toBe("a")
    expect(opts[1].name).toBe("Bee")
    expect(opts[2].optionId).toBe(Elicitation.CANCEL_OPTION_ID)
  })
})

describe("Elicitation.parseOutcome", () => {
  const req: Elicitation.Request = { sessionId: "s", id: "i", prompt: "q" }

  test("cancelled when outcome is cancelled", () => {
    expect(Elicitation.parseOutcome(req, { outcome: { outcome: "cancelled" } })).toEqual({ outcome: "cancelled" })
  })

  test("cancelled when optionId is CANCEL_OPTION_ID", () => {
    expect(
      Elicitation.parseOutcome(req, { outcome: { outcome: "selected", optionId: Elicitation.CANCEL_OPTION_ID } }),
    ).toEqual({ outcome: "cancelled" })
  })

  test("submitted with value from _meta.elicitation.value when client supplies it", () => {
    const response = Elicitation.parseOutcome(req, {
      outcome: { outcome: "selected", optionId: Elicitation.SUBMIT_OPTION_ID },
      _meta: { elicitation: { value: "hello world" } },
    })
    expect(response).toEqual({ outcome: "submitted", value: "hello world" })
  })

  test("submitted with value parsed from choice optionId", () => {
    const response = Elicitation.parseOutcome(req, {
      outcome: { outcome: "selected", optionId: "choice_1_prod" },
    })
    expect(response).toEqual({ outcome: "submitted", value: "prod" })
  })

  test("submitted with defaultValue when legacy client returns SUBMIT without payload", () => {
    const response = Elicitation.parseOutcome(
      { ...req, defaultValue: "def-x" },
      { outcome: { outcome: "selected", optionId: Elicitation.SUBMIT_OPTION_ID } },
    )
    expect(response).toEqual({ outcome: "submitted", value: "def-x" })
  })

  test("returns cancelled for null raw response", () => {
    expect(Elicitation.parseOutcome(req, null)).toEqual({ outcome: "cancelled" })
  })
})

describe("Elicitation.ask", () => {
  test("drives requestPermission with elicitation _meta and returns parsed value", async () => {
    const { connection, calls } = fakeConnection(async () => {
      return {
        outcome: { outcome: "selected", optionId: Elicitation.SUBMIT_OPTION_ID },
        _meta: { elicitation: { value: "42" } },
      } as unknown as RequestPermissionResult
    })
    const res = await Elicitation.ask(connection, {
      sessionId: "ses_1",
      id: "oob_3",
      prompt: "Answer to life?",
    })
    expect(res).toEqual({ outcome: "submitted", value: "42" })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.sessionId).toBe("ses_1")
    expect(call.toolCall.toolCallId).toBe("elicitation_oob_3")
    expect(call.toolCall._meta).toBeDefined()
    expect((call.toolCall._meta as any).elicitation.prompt).toBe("Answer to life?")
  })

  test("runs onCancel callback when user cancels", async () => {
    let cancelled = false
    const { connection } = fakeConnection(async () => {
      return { outcome: { outcome: "cancelled" } } as unknown as RequestPermissionResult
    })
    const res = await Elicitation.ask(connection, {
      sessionId: "ses_1",
      id: "oob_4",
      prompt: "proceed?",
      onCancel: () => {
        cancelled = true
      },
    })
    expect(res).toEqual({ outcome: "cancelled" })
    expect(cancelled).toBe(true)
  })

  test("returns cancelled when requestPermission throws", async () => {
    const { connection } = fakeConnection(async () => {
      throw new Error("connection closed")
    })
    const res = await Elicitation.ask(connection, { sessionId: "s", id: "i", prompt: "q" })
    expect(res).toEqual({ outcome: "cancelled" })
  })
})

describe("Elicitation.Counter", () => {
  test("increments per-session independently and can be reset", () => {
    const counter = new Elicitation.Counter()
    expect(counter.next("a")).toBe(1)
    expect(counter.next("a")).toBe(2)
    expect(counter.next("b")).toBe(1)
    expect(counter.get("a")).toBe(2)
    counter.reset("a")
    expect(counter.get("a")).toBe(0)
    expect(counter.get("b")).toBe(1)
  })
})

describe("Elicitation.requireValue", () => {
  test("returns value on submitted", () => {
    expect(Elicitation.requireValue({ outcome: "submitted", value: "x" }, "ctx")).toBe("x")
  })

  test("throws on cancelled", () => {
    expect(() => Elicitation.requireValue({ outcome: "cancelled" }, "ctx")).toThrow()
  })

  test("throws on submitted without value", () => {
    expect(() => Elicitation.requireValue({ outcome: "submitted" } as Elicitation.Response, "ctx")).toThrow()
  })
})
