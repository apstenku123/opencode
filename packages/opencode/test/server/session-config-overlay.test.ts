import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import * as ConfigOverlay from "../../src/session/config-overlay"
import * as Hook from "../../src/hook"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

type SessionSkillOverlay = {
  skills?: {
    paths?: string[]
  }
}

void Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  ConfigOverlay.reset()
  await Instance.disposeAll()
})

describe("session config overlay", () => {
  test("POST /session with configOverlay merges into GET /session/:id/config", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app

        const created = await app.request("/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            configOverlay: { memories: { enabled: true } },
          }),
        })
        expect(created.status).toBe(200)
        const session = (await created.json()) as { id: string }
        expect(session.id).toBeTruthy()

        const cfgRes = await app.request(`/session/${session.id}/config`)
        expect(cfgRes.status).toBe(200)
        const cfg = (await cfgRes.json()) as {
          memories?: { enabled?: boolean }
        }
        expect(cfg.memories?.enabled).toBe(true)
      },
    })
  })

  test("two sessions with distinct overlays produce isolated hook config views", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app

        const sessionA = (await (
          await app.request("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              configOverlay: {
                experimental: {
                  hooks: {
                    SessionStart: [
                      {
                        name: "overlay-a",
                        command: "echo a",
                      },
                    ],
                  },
                },
              },
            }),
          })
        ).json()) as { id: string }

        const sessionB = (await (
          await app.request("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              configOverlay: {
                experimental: {
                  hooks: {
                    SessionStart: [
                      {
                        name: "overlay-b",
                        command: "echo b",
                      },
                    ],
                  },
                },
              },
            }),
          })
        ).json()) as { id: string }

        // Each session's config view exposes its own hook entries.
        const cfgA = (await (await app.request(`/session/${sessionA.id}/config`)).json()) as {
          experimental?: {
            hooks?: { SessionStart?: Array<{ name: string }> }
          }
        }
        const cfgB = (await (await app.request(`/session/${sessionB.id}/config`)).json()) as {
          experimental?: {
            hooks?: { SessionStart?: Array<{ name: string }> }
          }
        }

        expect(cfgA.experimental?.hooks?.SessionStart?.map((h) => h.name)).toEqual(["overlay-a"])
        expect(cfgB.experimental?.hooks?.SessionStart?.map((h) => h.name)).toEqual(["overlay-b"])

        // Hook.Service.getCommandHooksFor is driven by the overlayed cfg, so
        // dispatching with sessionID=A must NOT see session B's hooks and
        // vice versa. We assert via the overlay helper directly — dispatch
        // would require subprocess side-effects (spawning `sh -c echo a`)
        // that we intentionally avoid in unit tests.
        const emptyCfg = { experimental: { hooks: {} } } as unknown as Parameters<
          typeof Hook.getCommandHooksFor
        >[0]
        const overlaid = (sid: string) =>
          ConfigOverlay.applyOverlay(emptyCfg, sid) as unknown as Parameters<
            typeof Hook.getCommandHooksFor
          >[0]
        expect(Hook.getCommandHooksFor(overlaid(sessionA.id), "SessionStart").map((h) => h.name)).toEqual([
          "overlay-a",
        ])
        expect(Hook.getCommandHooksFor(overlaid(sessionB.id), "SessionStart").map((h) => h.name)).toEqual([
          "overlay-b",
        ])

        // Cleanup path: DELETE clears the overlay.
        const delRes = await app.request(`/session/${sessionA.id}`, {
          method: "DELETE",
        })
        expect(delRes.status).toBe(200)
        expect(ConfigOverlay.get(sessionA.id)).toBeUndefined()
        expect(ConfigOverlay.get(sessionB.id)).toBeDefined()
      },
    })
  })

  test("no overlay → GET /session/:id/config matches /config", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = (await (
          await app.request("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).json()) as { id: string }

        const globalRes = await app.request("/config")
        const scopedRes = await app.request(`/session/${session.id}/config`)
        expect(await scopedRes.json()).toEqual(await globalRes.json())
      },
    })
  })

  test("session skill injection/ejection is isolated and visible in config readback", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app

        const sessionA = (await (
          await app.request("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).json()) as { id: string }

        const sessionB = (await (
          await app.request("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).json()) as { id: string }

        const injectA = await app.request(`/session/${sessionA.id}/skill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: ["./skills/a", "./skills/shared"] }),
        })
        expect(injectA.status).toBe(200)
        expect(await injectA.json()).toEqual({ items: ["./skills/a", "./skills/shared"] })

        const injectB = await app.request(`/session/${sessionB.id}/skill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: ["./skills/b"] }),
        })
        expect(injectB.status).toBe(200)
        expect(await injectB.json()).toEqual({ items: ["./skills/b"] })

        const listA = await app.request(`/session/${sessionA.id}/skill`)
        const listB = await app.request(`/session/${sessionB.id}/skill`)
        expect(await listA.json()).toEqual({ items: ["./skills/a", "./skills/shared"] })
        expect(await listB.json()).toEqual({ items: ["./skills/b"] })

        const cfgA = (await (await app.request(`/session/${sessionA.id}/config`)).json()) as {
          skills?: { paths?: string[] }
        }
        const cfgB = (await (await app.request(`/session/${sessionB.id}/config`)).json()) as {
          skills?: { paths?: string[] }
        }
        expect(cfgA.skills?.paths).toEqual(["./skills/a", "./skills/shared"])
        expect(cfgB.skills?.paths).toEqual(["./skills/b"])

        const ejectA = await app.request(`/session/${sessionA.id}/skill`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: ["./skills/a"] }),
        })
        expect(ejectA.status).toBe(200)
        expect(await ejectA.json()).toEqual({ items: ["./skills/shared"] })

        const cfgAAfter = (await (await app.request(`/session/${sessionA.id}/config`)).json()) as {
          skills?: { paths?: string[] }
        }
        expect(cfgAAfter.skills?.paths).toEqual(["./skills/shared"])
        expect((ConfigOverlay.get(sessionA.id) as SessionSkillOverlay | undefined)?.skills?.paths).toEqual([
          "./skills/shared",
        ])
        expect((ConfigOverlay.get(sessionB.id) as SessionSkillOverlay | undefined)?.skills?.paths).toEqual([
          "./skills/b",
        ])
      },
    })
  })

  test("deleting a session clears injected skill paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const session = (await (
          await app.request("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).json()) as { id: string }

        const inject = await app.request(`/session/${session.id}/skill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: ["./skills/temp"] }),
        })
        expect(inject.status).toBe(200)
        expect((ConfigOverlay.get(session.id) as SessionSkillOverlay | undefined)?.skills?.paths).toEqual([
          "./skills/temp",
        ])

        const delRes = await app.request(`/session/${session.id}`, {
          method: "DELETE",
        })
        expect(delRes.status).toBe(200)
        expect(ConfigOverlay.get(session.id)).toBeUndefined()
      },
    })
  })
})

// Keep the unused Effect import — Bun test sometimes tree-shakes Effect
// layers and we want the module side-effects loaded deterministically.
void Effect.void
