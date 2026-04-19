import { expect, test, describe } from "bun:test"

/**
 * Pure-helper coverage for the Copilot accounts TUI panel. Full JSX render
 * isn't feasible in the unit-test harness so we exercise the deterministic
 * summarization + row-derivation helpers used to drive the UI.
 */
const { summarizeConnections, toRows } = await import(
  "../../../src/cli/cmd/tui/component/dialog-copilot-accounts"
)

describe("summarizeConnections", () => {
  test("returns zero totals for null state", () => {
    const s = summarizeConnections(null)
    expect(s.total).toBe(0)
    expect(s.byPool).toEqual({})
  })

  test("skips empty connection slots", () => {
    const s = summarizeConnections({
      connections: {
        "github-copilot#edu": {},
        "github-copilot": { plan: "enterprise", login: "dev" },
      },
    })
    expect(s.total).toBe(1)
    expect(s.byPool).toEqual({ prod: 1 })
  })

  test("buckets accounts into prod / edu pools from key + plan", () => {
    const s = summarizeConnections({
      connections: {
        a: { plan: "enterprise", login: "x" },
        "github-copilot#edu-foo": { plan: "enterprise", login: "y" },
        b: { plan: "free", login: "z" },
        c: { plan: "business", login: "q" },
      },
    })
    expect(s.total).toBe(4)
    expect(s.byPool.prod).toBe(2)
    expect(s.byPool.edu).toBe(1)
    expect(s.byPool.free).toBe(1)
  })
})

describe("toRows", () => {
  test("produces a row per non-empty connection", () => {
    const rows = toRows({
      connections: {
        "github-copilot": {
          label: "Primary",
          login: "dev",
          plan: "enterprise",
          machineId: "abc-123",
          proxyUrl: "https://proxy.example",
          envelope: true,
          discovery: { at: 1, ok: true, models: ["gpt-4"] },
        },
        "github-copilot#empty": {},
      },
    })
    expect(rows.length).toBe(1)
    expect(rows[0]!.label).toBe("Primary")
    expect(rows[0]!.health).toBe("ok")
    expect(rows[0]!.pool).toBe("prod")
    expect(rows[0]!.envelope).toBe(true)
    expect(rows[0]!.machineId).toBe("abc-123")
    expect(rows[0]!.models).toBe(1)
  })

  test("marks stale when discovery.ok = false", () => {
    const [row] = toRows({
      connections: {
        "github-copilot": {
          label: "Primary",
          login: "dev",
          plan: "enterprise",
          discovery: { at: 1, ok: false, err: "boom" },
        },
      },
    })
    expect(row!.health).toBe("stale")
    expect(row!.error).toBe("boom")
  })

  test("marks deactivated accounts", () => {
    const [row] = toRows({
      connections: {
        "github-copilot": {
          label: "X",
          plan: "enterprise",
          deactivated: true,
        },
      },
    })
    expect(row!.health).toBe("deactivated")
  })

  test("sorts preferred first, then by pool then label", () => {
    const rows = toRows({
      connections: {
        "github-copilot#b": { label: "Beta", plan: "enterprise" },
        "github-copilot#a": { label: "Alpha", plan: "enterprise" },
        "github-copilot#z": { label: "Starred", plan: "enterprise", preferred: true },
      },
    })
    expect(rows.map((r) => r.label)).toEqual(["Starred", "Alpha", "Beta"])
  })
})
