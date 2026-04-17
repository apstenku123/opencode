import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  lockPathFor,
  tryAcquireWriterLock,
  type WriterGate,
} from "../../../src/memory/foreign-ingest/writer-lock"

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "occ-fl-"))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe("foreign-ingest/writer-lock", () => {
  test("lockPathFor is deterministic and distinct per git root", () => {
    const a1 = lockPathFor("/data", "/repo/a")
    const a2 = lockPathFor("/data", "/repo/a")
    const b = lockPathFor("/data", "/repo/b")
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1.endsWith(".lock")).toBe(true)
    expect(a1).toContain("foreign_ingest")
  })

  test("first acquire succeeds and creates the lockfile", () => {
    const gate = tryAcquireWriterLock(dataDir, "/some/repo")
    expect(gate._tag).toBe("Acquired")
    if (gate._tag !== "Acquired") return
    const lp = gate.guard.path
    expect(statSync(lp).isFile()).toBe(true)
    gate.guard.release()
  })

  test("second acquire while first is held returns AlreadyHeld", () => {
    const first = tryAcquireWriterLock(dataDir, "/some/repo")
    expect(first._tag).toBe("Acquired")
    const second = tryAcquireWriterLock(dataDir, "/some/repo")
    expect(second._tag).toBe("AlreadyHeld")
    if (first._tag === "Acquired") first.guard.release()
  })

  test("release lets a subsequent acquire succeed", () => {
    const a = tryAcquireWriterLock(dataDir, "/r")
    expect(a._tag).toBe("Acquired")
    if (a._tag === "Acquired") a.guard.release()
    const b = tryAcquireWriterLock(dataDir, "/r")
    expect(b._tag).toBe("Acquired")
    if (b._tag === "Acquired") b.guard.release()
  })

  test("reclaims lock written by a stale (non-existent) pid on the same host", () => {
    // Write a lockfile with a PID that cannot exist on this host. Pid
    // 0x7fffffff is well above any reasonable system max.
    const lockPath = lockPathFor(dataDir, "/stale/repo")
    const { mkdirSync } = require("node:fs") as typeof import("node:fs")
    mkdirSync(path.dirname(lockPath), { recursive: true })
    const { hostname } = require("node:os") as typeof import("node:os")
    writeFileSync(lockPath, `${hostname()}:2147483647`)

    const gate = tryAcquireWriterLock(dataDir, "/stale/repo")
    expect(gate._tag).toBe("Acquired")
    if (gate._tag === "Acquired") gate.guard.release()
  })

  test("does NOT reclaim a lock owned by a different host", () => {
    const lockPath = lockPathFor(dataDir, "/cross/repo")
    const { mkdirSync } = require("node:fs") as typeof import("node:fs")
    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, "some-other-host:1")

    const gate: WriterGate = tryAcquireWriterLock(dataDir, "/cross/repo")
    expect(gate._tag).toBe("AlreadyHeld")
    if (gate._tag === "AlreadyHeld") {
      expect(gate.heldBy).toBe("some-other-host:1")
    }
  })
})
