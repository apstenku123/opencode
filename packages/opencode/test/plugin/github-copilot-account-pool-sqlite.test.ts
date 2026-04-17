import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { Database } from "bun:sqlite"
import { openRateStore, makeRateStoreFromDb } from "@/plugin/github-copilot/account-pool-sqlite"
import { AccountPool } from "@/plugin/github-copilot/account-pool"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-rate-store-"))
}

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()!
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe("openRateStore", () => {
  test("creates schema and round-trips a row via debounced write", async () => {
    const dir = tmpDir()
    cleanup.push(dir)
    const file = path.join(dir, "rate.sqlite")
    const store = await openRateStore(file, 5)
    expect(store.loadAll()).toEqual([])
    store.upsert({
      key: "github-copilot",
      exhaustedUntil: 1_700_000_000_000,
      headerless429Count: 2,
      last429At: 1_699_999_999_000,
    })
    store.flush()
    const rows = store.loadAll()
    expect(rows).toEqual([
      {
        key: "github-copilot",
        exhaustedUntil: 1_700_000_000_000,
        headerless429Count: 2,
        last429At: 1_699_999_999_000,
      },
    ])
    store.close()
  })

  test("upsert merges multiple writes for the same key (debounce coalesces)", async () => {
    const dir = tmpDir()
    cleanup.push(dir)
    const file = path.join(dir, "rate.sqlite")
    const store = await openRateStore(file, 50)
    store.upsert({ key: "k", exhaustedUntil: 100, headerless429Count: 1 })
    store.upsert({ key: "k", exhaustedUntil: 200, headerless429Count: 2 })
    store.flush()
    expect(store.loadAll()).toEqual([
      { key: "k", exhaustedUntil: 200, headerless429Count: 2, last429At: undefined },
    ])
    store.close()
  })

  test("remove deletes a row", async () => {
    const dir = tmpDir()
    cleanup.push(dir)
    const file = path.join(dir, "rate.sqlite")
    const store = await openRateStore(file, 1)
    store.upsert({ key: "k", exhaustedUntil: 100, headerless429Count: 1 })
    store.flush()
    expect(store.loadAll().length).toBe(1)
    store.remove("k")
    store.flush()
    expect(store.loadAll()).toEqual([])
    store.close()
  })

  test("survives a process-restart by reopening the same file", async () => {
    const dir = tmpDir()
    cleanup.push(dir)
    const file = path.join(dir, "rate.sqlite")
    const a = await openRateStore(file, 1)
    a.upsert({ key: "persisted", exhaustedUntil: 42, headerless429Count: 3, last429At: 7 })
    a.flush()
    a.close()
    const b = await openRateStore(file, 1)
    expect(b.loadAll()).toEqual([
      { key: "persisted", exhaustedUntil: 42, headerless429Count: 3, last429At: 7 },
    ])
    b.close()
  })

  test("AccountPool boots from snapshot via attached store", () => {
    const db = new Database(":memory:")
    const store = makeRateStoreFromDb(db, 1)
    store.upsert({ key: "k", exhaustedUntil: Date.now() + 60_000, headerless429Count: 2, last429At: Date.now() })
    store.flush()
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7, store })
    // The hydrated cooldown should clamp slots to 0.
    expect(pool.availableSlots("k")).toBe(0)
    store.close()
  })

  test("AccountPool writes through to the store on recordExhaustion + recordSuccess", () => {
    const db = new Database(":memory:")
    const store = makeRateStoreFromDb(db, 1)
    const pool = new AccountPool({ accounts: [{ key: "k" }], limit: 7, store })
    // headerless 429 (no retry-after) advances the escalator counter — that
    // counter is what we want to see survive a quick recordSuccess.
    pool.recordExhaustion("k", { now: 1_000_000 })
    store.flush()
    let rows = store.loadAll()
    expect(rows.length).toBe(1)
    expect(rows[0]!.exhaustedUntil).toBeGreaterThan(1_000_000)
    expect(rows[0]!.headerless429Count).toBe(1)
    pool.recordSuccess("k", 1_000_001)
    store.flush()
    rows = store.loadAll()
    // recordSuccess clears exhaustedUntil but preserves the escalator
    // counter + last429At until the 24h reset window — Rust parity.
    expect(rows.length).toBe(1)
    expect(rows[0]!.exhaustedUntil).toBeUndefined()
    expect(rows[0]!.headerless429Count).toBe(1)
    // After the 24h reset window the escalator clears + the row goes away.
    pool.recordSuccess("k", 1_000_000 + 25 * 60 * 60 * 1000)
    store.flush()
    rows = store.loadAll()
    expect(rows.length).toBe(0)
    store.close()
  })
})
