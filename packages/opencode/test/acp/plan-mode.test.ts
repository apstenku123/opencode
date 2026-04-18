import { describe, expect, test } from "bun:test"
import { PlanMode } from "../../src/acp/plan-mode"
import type { AgentSideConnection, PlanEntry } from "@agentclientprotocol/sdk"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]

function fakeConnection() {
  const updates: SessionUpdateParams[] = []
  const connection: Pick<AgentSideConnection, "sessionUpdate"> = {
    async sessionUpdate(params: SessionUpdateParams) {
      updates.push(params)
    },
  }
  return { connection, updates }
}

describe("PlanMode.isPlanMode", () => {
  test("recognises the 'plan' mode id", () => {
    expect(PlanMode.isPlanMode("plan")).toBe(true)
  })

  test("rejects other mode ids", () => {
    expect(PlanMode.isPlanMode("build")).toBe(false)
    expect(PlanMode.isPlanMode(undefined)).toBe(false)
    expect(PlanMode.isPlanMode(null)).toBe(false)
  })
})

describe("PlanMode.buildMeta", () => {
  test("namespaces plan-mode fields under 'planMode'", () => {
    const meta = PlanMode.buildMeta({ active: true, title: "Refactor", entriesCount: 3, reason: "enter" })
    const block = meta[PlanMode.META_KEY] as Record<string, unknown>
    expect(block).toEqual({ active: true, title: "Refactor", entriesCount: 3, reason: "enter" })
  })

  test("omits undefined fields", () => {
    const meta = PlanMode.buildMeta({ active: false })
    const block = meta[PlanMode.META_KEY] as Record<string, unknown>
    expect(block).toEqual({ active: false })
  })
})

describe("PlanMode.initializeMeta", () => {
  test("advertises support with modeId", () => {
    const meta = PlanMode.initializeMeta()
    const block = meta[PlanMode.META_KEY] as Record<string, unknown>
    expect(block).toEqual({ supported: true, modeId: PlanMode.PLAN_MODE_ID })
  })
})

describe("PlanMode.announceTransition", () => {
  test("emits current_mode_update with entering planMode _meta", async () => {
    const { connection, updates } = fakeConnection()
    await PlanMode.announceTransition(connection, {
      sessionId: "ses_1",
      from: "build",
      to: "plan",
      automatic: false,
    })
    expect(updates).toHaveLength(1)
    const params = updates[0] as any
    expect(params.sessionId).toBe("ses_1")
    expect(params.update.sessionUpdate).toBe("current_mode_update")
    expect(params.update.currentModeId).toBe("plan")
    expect(params._meta.planMode.active).toBe(true)
    expect(params._meta.planMode.reason).toBe("enter")
  })

  test("emits exit reason on plan -> build", async () => {
    const { connection, updates } = fakeConnection()
    await PlanMode.announceTransition(connection, {
      sessionId: "ses_2",
      from: "plan",
      to: "build",
      automatic: true,
    })
    const params = updates[0] as any
    expect(params._meta.planMode.active).toBe(false)
    expect(params._meta.planMode.reason).toBe("exit")
  })

  test("swallows connection errors without throwing", async () => {
    const connection: Pick<AgentSideConnection, "sessionUpdate"> = {
      async sessionUpdate() {
        throw new Error("io failure")
      },
    }
    // Should not throw
    await PlanMode.announceTransition(connection, { sessionId: "s", to: "plan", automatic: false })
  })
})

describe("PlanMode.publishSnapshot", () => {
  test("emits 'plan' update with entries and planMode meta", async () => {
    const { connection, updates } = fakeConnection()
    const entries: PlanEntry[] = [
      { content: "Step 1", priority: "high", status: "in_progress" },
      { content: "Step 2", priority: "medium", status: "pending" },
    ]
    await PlanMode.publishSnapshot(connection, {
      sessionId: "ses_1",
      active: true,
      title: "Migrate DB",
      entries,
    })
    expect(updates).toHaveLength(1)
    const params = updates[0] as any
    expect(params.update.sessionUpdate).toBe("plan")
    expect(params.update.entries).toEqual(entries)
    expect(params._meta.planMode.active).toBe(true)
    expect(params._meta.planMode.title).toBe("Migrate DB")
    expect(params._meta.planMode.entriesCount).toBe(2)
    expect(params._meta.planMode.reason).toBe("update")
  })
})

describe("PlanMode.Tracker", () => {
  test("reports changed=true on first observation", () => {
    const tracker = new PlanMode.Tracker()
    const res = tracker.observe("s", "plan")
    expect(res.changed).toBe(true)
    expect(res.previous).toBeUndefined()
  })

  test("reports changed=false when mode re-set to same value", () => {
    const tracker = new PlanMode.Tracker()
    tracker.observe("s", "plan")
    const res = tracker.observe("s", "plan")
    expect(res.changed).toBe(false)
    expect(res.previous).toBe("plan")
  })

  test("reports changed=true with previous mode on switch", () => {
    const tracker = new PlanMode.Tracker()
    tracker.observe("s", "build")
    const res = tracker.observe("s", "plan")
    expect(res).toEqual({ changed: true, previous: "build" })
  })

  test("clear() forgets a session", () => {
    const tracker = new PlanMode.Tracker()
    tracker.observe("s", "plan")
    tracker.clear("s")
    expect(tracker.get("s")).toBeUndefined()
  })

  test("sessions are isolated", () => {
    const tracker = new PlanMode.Tracker()
    tracker.observe("a", "plan")
    tracker.observe("b", "build")
    expect(tracker.get("a")).toBe("plan")
    expect(tracker.get("b")).toBe("build")
  })
})
