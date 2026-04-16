import { describe, expect, test } from "bun:test"

async function src() {
  return Bun.file(new URL("../../src/server/instance/tui.ts", import.meta.url)).text()
}

describe("tui timer fired route", () => {
  test("wires timer fired endpoint with validator and publish", async () => {
    const text = await src()
    expect(text).toContain('"/timer-fired"')
    expect(text).toContain('operationId: "tui.timerFired"')
    expect(text).toContain('validator("json", TuiEvent.TimerFired.properties)')
    expect(text).toContain('Bus.publish(TuiEvent.TimerFired, c.req.valid("json"))')
  })

  test("event catalog defines timer fired payload", async () => {
    const text = await Bun.file(new URL("../../src/cli/cmd/tui/event.ts", import.meta.url)).text()
    expect(text).toContain('TimerFired: BusEvent.define(')
    expect(text).toContain('"tui.timer.fired"')
    expect(text).toContain('sessionID: SessionID.zod')
    expect(text).toContain('repeat: z.boolean()')
    expect(text).toContain('fired_at: z.number().int().nonnegative()')
  })
})
