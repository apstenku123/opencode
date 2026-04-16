import { describe, expect, test } from "bun:test"
import { list } from "@/plugin/github-copilot/auth"
import {
  acquire,
  available,
  cooldown,
  eligible,
  emptyPool,
  feed,
  load,
  owner,
  release,
  reserve,
  reserveBatch,
  runtime,
  touch,
} from "@/plugin/github-copilot/runtime"

describe("github-copilot runtime", () => {
  test("emptyPool starts empty", () => {
    expect(emptyPool()).toEqual({})
  })

  test("runtime defaults missing account usage to zero", () => {
    expect(runtime(emptyPool(), "github-copilot")).toBe(0)
  })

  test("owner defaults to limit=1 and empty pool", () => {
    expect(owner()).toEqual({ pool: {}, limit: 1, minIntervalMs: 0, last: {}, feed: [] })
  })

  test("available respects per-account limit", () => {
    const state = { pool: acquire(emptyPool(), "github-copilot"), limit: 2, minIntervalMs: 0, last: {}, feed: [] }
    expect(available(state, "github-copilot")).toBe(true)
    expect(available({ pool: acquire(state.pool, "github-copilot"), limit: 2, minIntervalMs: 0, last: {}, feed: [] }, "github-copilot")).toBe(false)
  })

  test("acquire increments usage per account", () => {
    const pool = acquire(acquire(emptyPool(), "github-copilot"), "github-copilot")
    expect(runtime(pool, "github-copilot")).toBe(2)
  })

  test("release decrements usage and removes zero entries", () => {
    const a = acquire(acquire(emptyPool(), "github-copilot"), "github-copilot")
    const b = release(a, "github-copilot")
    expect(runtime(b, "github-copilot")).toBe(1)
    const c = release(b, "github-copilot")
    expect(c).toEqual({})
    expect(runtime(c, "github-copilot")).toBe(0)
  })

  test("release on missing account is a no-op", () => {
    expect(release(emptyPool(), "github-copilot")).toEqual({})
  })

  test("eligible prefers idle accounts", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
    })
    const state = owner()
    state.pool = acquire(state.pool, "github-copilot")
    expect(eligible(state, auths).map((item) => item.key)).toEqual(["github-copilot#work"])
  })

  test("eligible falls back to full pool when all accounts are busy", () => {
    const auths = list({
      "github-copilot": { type: "oauth", refresh: "r1", access: "a1", expires: 0 },
      "github-copilot#work": { type: "oauth", refresh: "r2", access: "a2", expires: 0 },
    })
    const state = owner()
    state.pool = acquire(acquire(state.pool, "github-copilot"), "github-copilot#work")
    expect(eligible(state, auths).map((item) => item.key)).toEqual(["github-copilot", "github-copilot#work"])
  })
})

test("cooldown and touch respect min interval", () => {
  const state = owner(1, 500)
  touch(state, "github-copilot", 1000)
  expect(cooldown(state, "github-copilot", 1200)).toBe(true)
  expect(cooldown(state, "github-copilot", 1600)).toBe(false)
})

test("load reflects current pool usage", () => {
  const state = owner()
  state.pool = acquire(acquire(state.pool, "github-copilot"), "github-copilot")
  expect(load(state, "github-copilot")).toBe(2)
})


test("reserveBatch holds projected picks on shared runtime owner", () => {
  const state = owner(2, 0)
  const held = reserveBatch(state, ["a", "b", "a"])
  expect(state.pool).toEqual({ a: 2, b: 1 })
  held.release("b")
  expect(state.pool).toEqual({ a: 2 })
  held.releaseAll()
  expect(state.pool).toEqual({})
})

test("reserve acquires and releases a single slot", () => {
  const state = owner()
  const slot = reserve(state, "github-copilot")
  expect(state.pool).toEqual({ "github-copilot": 1 })
  slot.release()
  expect(state.pool).toEqual({})
})


test("runtime feed records reserve release and touch events", () => {
  const state = owner()
  const slot = reserve(state, "github-copilot")
  touch(state, "github-copilot", 123)
  slot.release()
  expect(feed(state).map((item) => [item.type, item.key, item.load])).toEqual([
    ["release", "github-copilot", 0],
    ["touch", "github-copilot", 1],
    ["reserve", "github-copilot", 1],
  ])
})
