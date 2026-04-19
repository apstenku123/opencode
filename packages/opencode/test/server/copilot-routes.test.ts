/**
 * HTTP coverage for the `/copilot/*` server routes (mirrors the
 * `opencode providers` Copilot-account CLI subcommands).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Auth } from "@/auth"
import * as providersCmd from "@/cli/cmd/providers"
import { connectionFile } from "@/plugin/github-copilot/paths"
import { Instance } from "@/project/instance"
import { Server } from "@/server/server"
import { Log } from "@/util"
import { rm } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// Disable the live `/models` discovery probe — every `loadAccountStatuses()`
// call would otherwise try to reach `api.githubcopilot.com/models`.
process.env.OPENCODE_PROBE_DISCOVERY = "0"

async function seedState(connections: Record<string, object>) {
  await Bun.write(connectionFile, JSON.stringify({ version: 1, connections }))
}

function mockFetchOk(login: string, sku: string) {
  return ((url: string) => {
    if (String(url).includes("copilot_internal/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user_login: login, access_type_sku: sku }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  }) as unknown as typeof fetch
}

let authSpy: ReturnType<typeof spyOn<typeof providersCmd, "allAuth">> | undefined
let prevFetch: typeof fetch

beforeEach(() => {
  prevFetch = globalThis.fetch
  globalThis.fetch = mockFetchOk("alice", "copilot_free")
  authSpy = spyOn(providersCmd, "allAuth").mockResolvedValue({
    "github-copilot#edu": new Auth.Oauth({ type: "oauth", refresh: "tok", access: "", expires: 0 }),
  })
})

afterEach(async () => {
  authSpy?.mockRestore()
  authSpy = undefined
  globalThis.fetch = prevFetch
  await rm(connectionFile, { force: true }).catch(() => undefined)
  await Instance.disposeAll()
})

describe("copilot routes", () => {
  test("GET /copilot/accounts returns envelope with items + migration + bestPerVendor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": {} })
        const app = Server.Default().app
        const res = await app.request("/copilot/accounts")
        expect(res.status).toBe(200)
        const data = (await res.json()) as any
        expect(data.schemaVersion).toBe(1)
        expect(data.migration).toBeTruthy()
        expect(Array.isArray(data.items)).toBe(true)
        expect(data.items.length).toBe(1)
        expect(data.items[0].status.key).toBe("github-copilot#edu")
        expect(Array.isArray(data.health)).toBe(true)
        expect(typeof data.bestPerVendor).toBe("object")
      },
    })
  })

  test("GET /copilot/accounts/:key returns a single status (404 for unknown)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": {} })
        const app = Server.Default().app

        const hit = await app.request("/copilot/accounts/github-copilot%23edu")
        expect(hit.status).toBe(200)
        const body = (await hit.json()) as any
        expect(body.status.key).toBe("github-copilot#edu")
        expect(body.status.pool).toBe("edu")

        const miss = await app.request("/copilot/accounts/github-copilot%23nope")
        expect(miss.status).toBe(404)
      },
    })
  })

  test("POST /copilot/accounts/:key/deactivate + /activate flip the flag in storage", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": {} })
        const app = Server.Default().app

        const off = await app.request("/copilot/accounts/github-copilot%23edu/deactivate", { method: "POST" })
        expect(off.status).toBe(200)
        expect(await off.json()).toEqual({ key: "github-copilot#edu", deactivated: true })
        let persisted = JSON.parse(await Bun.file(connectionFile).text())
        expect(persisted.connections["github-copilot#edu"].deactivated).toBe(true)

        const on = await app.request("/copilot/accounts/github-copilot%23edu/activate", { method: "POST" })
        expect(on.status).toBe(200)
        expect(await on.json()).toEqual({ key: "github-copilot#edu", deactivated: false })
        persisted = JSON.parse(await Bun.file(connectionFile).text())
        expect(persisted.connections["github-copilot#edu"].deactivated).toBeUndefined()

        const miss = await app.request("/copilot/accounts/github-copilot%23nope/deactivate", { method: "POST" })
        expect(miss.status).toBe(404)
      },
    })
  })

  test("POST /copilot/accounts/:key/machine-id/rotate clears the stored id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": { machineId: "abc-123" } })
        const app = Server.Default().app
        const res = await app.request("/copilot/accounts/github-copilot%23edu/machine-id/rotate", { method: "POST" })
        expect(res.status).toBe(200)
        const data = (await res.json()) as any
        expect(data.key).toBe("github-copilot#edu")
        expect(data.previousMachineId).toBe("abc-123")
        expect(data.cleared).toBe(true)
        const persisted = JSON.parse(await Bun.file(connectionFile).text())
        expect(persisted.connections["github-copilot#edu"].machineId).toBeUndefined()
      },
    })
  })

  test("POST /copilot/accounts/:key/proxy updates proxy settings", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": {} })
        const app = Server.Default().app

        const set = await app.request("/copilot/accounts/github-copilot%23edu/proxy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ proxyUrl: "https://gcp.example", proxyToken: "ptok", envelope: true }),
        })
        expect(set.status).toBe(200)
        expect(await set.json()).toEqual({
          key: "github-copilot#edu",
          proxyUrl: "https://gcp.example",
          proxyToken: "ptok",
          envelope: true,
        })

        const clear = await app.request("/copilot/accounts/github-copilot%23edu/proxy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ proxyUrl: "", envelope: false }),
        })
        expect(clear.status).toBe(200)
        expect(await clear.json()).toEqual({
          key: "github-copilot#edu",
          proxyUrl: null,
          proxyToken: null,
          envelope: false,
        })
      },
    })
  })

  test("GET /copilot/pools buckets accounts by plan", async () => {
    authSpy?.mockRestore()
    authSpy = spyOn(providersCmd, "allAuth").mockResolvedValue({
      "github-copilot#edu-slot1": new Auth.Oauth({ type: "oauth", refresh: "a", access: "", expires: 0 }),
      "github-copilot#enterprise": new Auth.Oauth({ type: "oauth", refresh: "b", access: "", expires: 0 }),
      "github-copilot#nowhere": new Auth.Oauth({ type: "oauth", refresh: "c", access: "", expires: 0 }),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({
          "github-copilot#enterprise": { plan: "enterprise" },
          "github-copilot#nowhere": {},
        })
        const app = Server.Default().app
        const res = await app.request("/copilot/pools")
        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        // `github-copilot#edu-*` keys route to the edu pool by convention.
        expect(body.edu).toContain("github-copilot#edu-slot1")
        expect(body.prod).toContain("github-copilot#enterprise")
        expect(body.unpooled).toContain("github-copilot#nowhere")
      },
    })
  })

  test("GET /copilot/pools/:pool/allowed returns prod + testOnly model lists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const edu = await app.request("/copilot/pools/edu/allowed")
        expect(edu.status).toBe(200)
        expect(await edu.json()).toEqual({
          prod: ["codex-5.3-xhigh"],
          testOnly: ["gpt-4.1", "gpt-5-mini-xhigh"],
        })

        const prod = await app.request("/copilot/pools/prod/allowed")
        expect(prod.status).toBe(200)
        const prodBody = (await prod.json()) as any
        expect(prodBody.prod).toEqual(["gpt-5.4-xhigh", "claude-4.7-opus-high"])
        expect(prodBody.testOnly).toEqual(["gpt-4.1", "gpt-5-mini-xhigh"])
      },
    })
  })

  test("GET /copilot/quota returns schema-versioned items envelope", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": {} })
        const app = Server.Default().app
        const res = await app.request("/copilot/quota")
        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.schemaVersion).toBe(1)
        expect(body.items).toHaveLength(1)
        expect(body.items[0].status.key).toBe("github-copilot#edu")
        expect(body.migration).toBeTruthy()
      },
    })
  })

  test("POST /copilot/route-debug returns candidate list", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seedState({ "github-copilot#edu": {} })
        const app = Server.Default().app
        const res = await app.request("/copilot/route-debug", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: "gpt-5-mini" }),
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.schemaVersion).toBe(1)
        expect(body.model).toBe("gpt-5-mini")
        expect(Array.isArray(body.candidates)).toBe(true)
      },
    })
  })
})
