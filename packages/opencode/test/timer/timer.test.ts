import { describe, expect, test } from "bun:test"
import { Timer } from "../../src/timer"

function fake() {
  let now = 0
  let seq = 0
  const items: {
    id: number
    at: number
    fn: () => void
    live: boolean
  }[] = []

  const clock: Timer.Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      items.push({ id, at: now + ms, fn, live: true })
      return id
    },
    clearTimeout: (id) => {
      const item = items.find((item) => item.id === id)
      if (item) item.live = false
    },
  }

  function tick(ms: number) {
    now += ms
    for (;;) {
      const next = items
        .filter((item) => item.live && item.at <= now)
        .sort((a, b) => a.at - b.at)[0]
      if (!next) return
      next.live = false
      next.fn()
    }
  }

  return { clock, tick }
}

describe("timer", () => {
  test("fires one-shot timers and deactivates them", () => {
    const env = fake()
    const timer = Timer.create(env.clock)

    const created = timer.create("once", 10)
    expect(created.id).toBe("once")
    expect(created.delay).toBe(10)
    expect(created.repeat).toBeFalse()
    expect(created.active).toBeTrue()
    expect(created.next === 10).toBeTrue()

    env.tick(9)
    expect(timer.drain()).toEqual([])
    expect(timer.get("once")?.active).toBe(true)

    env.tick(1)
    expect(timer.drain()).toEqual([{ id: "once", at: 10 }])
    const info = timer.get("once")!
    expect(info.id).toBe("once")
    expect(info.delay).toBe(10)
    expect(info.repeat).toBeFalse()
    expect(info.active).toBeFalse()
    expect(info.next).toBeNull()
  })

  test("repeating timers re-arm on fire", () => {
    const env = fake()
    const timer = Timer.create(env.clock)

    timer.create("loop", 5, true)
    env.tick(5)
    expect(timer.drain()).toEqual([{ id: "loop", at: 5 }])
    const info = timer.get("loop")!
    expect(info.id).toBe("loop")
    expect(info.delay).toBe(5)
    expect(info.repeat).toBeTrue()
    expect(info.active).toBeTrue()
    expect(info.next === 10).toBeTrue()

    env.tick(5)
    expect(timer.drain()).toEqual([{ id: "loop", at: 10 }])
  })

  test("pause and resume control firing", () => {
    const env = fake()
    const timer = Timer.create(env.clock)

    timer.create("job", 10, true)
    const paused = timer.pause("job")!
    expect(paused.id).toBe("job")
    expect(paused.delay).toBe(10)
    expect(paused.repeat).toBeTrue()
    expect(paused.active).toBeFalse()
    expect(paused.next).toBeNull()

    env.tick(20)
    expect(timer.drain()).toEqual([])

    const resumed = timer.resume("job")!
    expect(resumed.id).toBe("job")
    expect(resumed.delay).toBe(10)
    expect(resumed.repeat).toBeTrue()
    expect(resumed.active).toBeTrue()
    expect(resumed.next === 30).toBeTrue()

    env.tick(9)
    expect(timer.drain()).toEqual([])
    env.tick(1)
    expect(timer.drain()).toEqual([{ id: "job", at: 30 }])
  })

  test("delete removes timers and cancels future firing", () => {
    const env = fake()
    const timer = Timer.create(env.clock)

    timer.create("dead", 10, true)
    expect(timer.delete("dead")).toBe(true)
    expect(timer.get("dead")).toBeUndefined()
    expect(timer.list()).toEqual([])

    env.tick(20)
    expect(timer.drain()).toEqual([])
    expect(timer.delete("dead")).toBe(false)
  })
})
