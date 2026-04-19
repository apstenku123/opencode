import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Auth } from "@/auth"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect, Layer } from "effect"
import {
  BUNDLE_VERSION,
  MIN_SUPPORTED_BUNDLE_VERSION,
  applyBundle,
  buildBundle,
  exportBundle,
  importBundle,
  parseBundle,
  type Bundle,
} from "@/plugin/github-copilot/transfer"
import { Store as ConnectionsStore, empty as emptyConnections } from "@/plugin/github-copilot/connections"

const provide = <A, E>(effect: Effect.Effect<A, E, Auth.Service | AppFileSystem.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(Auth.defaultLayer, AppFileSystem.defaultLayer))),
  )

/** Wipe only our Copilot-flavoured auth keys so tests are isolated. */
async function resetCopilotAuth() {
  await provide(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const all = yield* auth.all()
      for (const key of Object.keys(all)) {
        if (key.startsWith("github-copilot")) yield* auth.remove(key)
      }
      // Also reset connections state to empty.
      const fs = yield* AppFileSystem.Service
      const store = new ConnectionsStore(fs)
      yield* store.write(emptyConnections())
    }),
  )
}

describe("github-copilot transfer bundle", () => {
  beforeEach(resetCopilotAuth)
  afterEach(resetCopilotAuth)

  test("buildBundle includes refresh tokens by default and strips them when redacted", () => {
    const bundle = buildBundle({
      auths: [
        { key: "github-copilot", label: "Primary", refresh: "r1", access: "a1", expires: 0 },
        {
          key: "github-copilot#enterprise",
          label: "Enterprise",
          refresh: "r2",
          access: "a2",
          expires: 0,
          enterpriseUrl: "https://ghe.example.com",
        },
      ],
      state: {
        version: 1,
        preferred: "github-copilot#enterprise",
        connections: {
          "github-copilot": { plan: "pro", proxyUrl: "https://proxy", proxyToken: "tok" },
          "github-copilot#enterprise": { login: "ent-bot" },
        },
      },
      options: { now: 1700000000000, exportedBy: "hostA" },
    })
    expect(bundle.version).toBe(BUNDLE_VERSION)
    expect(bundle.accounts[0].refresh).toBe("r1")
    expect(bundle.accounts[1].enterpriseUrl).toBe("https://ghe.example.com")
    expect(bundle.connections["github-copilot"].proxyUrl).toBe("https://proxy")
    expect(bundle.preferred).toBe("github-copilot#enterprise")
    expect(bundle.exportedBy).toBe("hostA")
    expect(bundle.exportedAt).toBe(1700000000000)

    const redacted = buildBundle({
      auths: [{ key: "github-copilot", label: "Primary", refresh: "r1", access: "a1", expires: 0 }],
      state: {
        version: 1,
        connections: { "github-copilot": { proxyUrl: "https://proxy", proxyToken: "tok" } },
      },
      options: { redactTokens: true, now: 1 },
    })
    expect(redacted.redacted).toBe(true)
    expect(redacted.accounts[0].refresh).toBeUndefined()
    expect(redacted.accounts[0].proxyToken).toBeUndefined()
    expect(redacted.connections["github-copilot"].proxyToken).toBeUndefined()
    // proxyUrl is fine to share.
    expect(redacted.connections["github-copilot"].proxyUrl).toBe("https://proxy")
  })

  test("parseBundle rejects version mismatch and schema violations", () => {
    expect(() => parseBundle({ version: 99, accounts: [], connections: {}, exportedAt: 0 })).toThrow(
      /unsupported Copilot transfer bundle version/,
    )
    expect(() => parseBundle({ version: 0, accounts: [], connections: {}, exportedAt: 0 })).toThrow(
      /unsupported Copilot transfer bundle version/,
    )
    expect(() => parseBundle("not-an-object")).toThrow(/schema mismatch/)
    expect(() => parseBundle({ version: 1 })).toThrow(/schema mismatch/)
  })

  test("parseBundle accepts v1 bundles (forward-compat for pre-v2 exports)", () => {
    // A plain v1 payload — no new v2 fields. Must round-trip cleanly so
    // bundles produced before the schema bump still import.
    const v1 = {
      version: MIN_SUPPORTED_BUNDLE_VERSION,
      accounts: [{ key: "github-copilot", label: "Primary", refresh: "r" }],
      connections: { "github-copilot": { plan: "pro" } },
      exportedAt: 0,
    }
    const parsed = parseBundle(v1)
    expect(parsed.version).toBe(MIN_SUPPORTED_BUNDLE_VERSION)
    expect(parsed.connections["github-copilot"].machineId).toBeUndefined()
    expect(parsed.connections["github-copilot"].discovery).toBeUndefined()
  })

  test("applyBundle merges into existing auth and keeps non-copilot entries", () => {
    const bundle: Bundle = {
      version: 1,
      accounts: [
        { key: "github-copilot", label: "Primary", refresh: "new-r" },
        { key: "github-copilot#edu", label: "Edu", refresh: "edu-r" },
      ],
      connections: { "github-copilot#edu": { plan: "edu" } },
      exportedAt: 0,
    }
    const { nextAuth, nextState, result } = applyBundle({
      bundle,
      existingAuth: {
        "github-copilot": { type: "oauth", refresh: "old-r", access: "old-a", expires: 0 },
        anthropic: { type: "api", key: "secret" },
      },
      existingState: emptyConnections(),
      mode: "merge",
    })
    expect(result.updated).toEqual(["github-copilot"])
    expect(result.added).toEqual(["github-copilot#edu"])
    expect(result.removed).toEqual([])
    expect(nextAuth["anthropic"]).toEqual({ type: "api", key: "secret" } as any)
    expect((nextAuth["github-copilot"] as any).refresh).toBe("new-r")
    expect(nextState.connections["github-copilot#edu"].plan).toBe("edu")
  })

  test("applyBundle replace mode wipes prior copilot entries", () => {
    const bundle: Bundle = {
      version: 1,
      accounts: [{ key: "github-copilot", label: "Primary", refresh: "new-r" }],
      connections: {},
      exportedAt: 0,
    }
    const { nextAuth, nextState, result } = applyBundle({
      bundle,
      existingAuth: {
        "github-copilot": { type: "oauth", refresh: "old-r", access: "old-a", expires: 0 },
        "github-copilot#edu": { type: "oauth", refresh: "edu-r", access: "edu-a", expires: 0 },
        anthropic: { type: "api", key: "secret" },
      },
      existingState: {
        version: 1,
        preferred: "github-copilot#edu",
        connections: { "github-copilot#edu": { plan: "edu" }, other: { plan: "x" } as any },
      },
      mode: "replace",
    })
    expect(result.removed.sort()).toEqual(["github-copilot", "github-copilot#edu"])
    expect(result.added).toEqual(["github-copilot"])
    expect(nextAuth["github-copilot#edu"]).toBeUndefined()
    expect(nextAuth["anthropic"]).toBeDefined()
    expect(nextState.preferred).toBeUndefined()
    // Non-copilot connections survive replace.
    expect(nextState.connections["other"]).toBeDefined()
    expect(nextState.connections["github-copilot#edu"]).toBeUndefined()
  })

  test("applyBundle skips accounts without refresh tokens (redacted bundle)", () => {
    const bundle: Bundle = {
      version: 1,
      redacted: true,
      accounts: [{ key: "github-copilot", label: "Primary" }],
      connections: { "github-copilot": { plan: "pro" } },
      exportedAt: 0,
    }
    const { nextAuth, nextState, result } = applyBundle({
      bundle,
      existingAuth: {},
      existingState: emptyConnections(),
      mode: "merge",
    })
    expect(result.added).toEqual([])
    expect(result.skipped).toEqual(["github-copilot"])
    expect(nextAuth["github-copilot"]).toBeUndefined()
    // Connection metadata is still applied — useful for sharing proxy setups
    // without leaking secrets.
    expect(nextState.connections["github-copilot"].plan).toBe("pro")
  })

  test("end-to-end roundtrip: export -> import merges accounts back", async () => {
    // Seed the Auth store via the real Service so the export path exercises it.
    await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("github-copilot", {
          type: "oauth",
          refresh: "rt-primary",
          access: "at-primary",
          expires: 0,
        })
        yield* auth.set("github-copilot#edu", {
          type: "oauth",
          refresh: "rt-edu",
          access: "at-edu",
          expires: 0,
          enterpriseUrl: "https://ghe.example.com",
        })
      }),
    )

    const bundle = await provide(exportBundle({ exportedBy: "roundtrip", now: 42 }))
    expect(bundle.accounts.map((a) => a.key).sort()).toEqual(["github-copilot", "github-copilot#edu"])
    expect(bundle.exportedBy).toBe("roundtrip")

    // Wipe and import back.
    await resetCopilotAuth()
    const result = await provide(importBundle(bundle, { mode: "merge" }))
    expect(result.added.sort()).toEqual(["github-copilot", "github-copilot#edu"])
    expect(result.dryRun).toBe(false)

    // Confirm the Auth store was written.
    const restored = await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return yield* auth.all()
      }),
    )
    expect((restored["github-copilot"] as any).refresh).toBe("rt-primary")
    expect((restored["github-copilot#edu"] as any).enterpriseUrl).toBe("https://ghe.example.com")
  })

  test("dry-run reports planned changes without touching the Auth store", async () => {
    const bundle: Bundle = {
      version: 1,
      accounts: [{ key: "github-copilot", label: "Primary", refresh: "planned" }],
      connections: {},
      exportedAt: 0,
    }
    const result = await provide(importBundle(bundle, { mode: "merge", dryRun: true }))
    expect(result.dryRun).toBe(true)
    expect(result.added).toEqual(["github-copilot"])

    const all = await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return yield* auth.all()
      }),
    )
    expect(all["github-copilot"]).toBeUndefined()
  })

  test("buildBundle emits every v2 per-account field (envelope, machineId, unsupportedModels, discovery)", () => {
    // Single source of truth for the fields we expect to survive the
    // round-trip. Mirrors the per-account state added on this branch.
    const bundle = buildBundle({
      auths: [
        { key: "github-copilot", label: "Primary", refresh: "rt", access: "at", expires: 0 },
      ],
      state: {
        version: 1,
        connections: {
          "github-copilot": {
            label: "Primary",
            plan: "pro",
            proxyUrl: "https://proxy.example",
            proxyToken: "ptok",
            envelope: true,
            machineId: "11111111-2222-3333-4444-555555555555",
            deactivated: true,
            unsupportedModels: ["gpt-5-pro", "claude-opus-4-7"],
            discovery: {
              at: 1700000000000,
              models: ["claude-opus-4-7", "gpt-5"],
              api: "https://api.individual.githubcopilot.com",
              plan: "pro",
              login: "ent-user",
              ok: true,
            },
          },
        },
      },
      options: { now: 2 },
    })
    expect(bundle.version).toBe(BUNDLE_VERSION)
    const conn = bundle.connections["github-copilot"]
    expect(conn.envelope).toBe(true)
    expect(conn.machineId).toBe("11111111-2222-3333-4444-555555555555")
    expect(conn.deactivated).toBe(true)
    expect(conn.unsupportedModels).toEqual(["gpt-5-pro", "claude-opus-4-7"])
    expect(conn.discovery?.at).toBe(1700000000000)
    expect(conn.discovery?.models).toEqual(["claude-opus-4-7", "gpt-5"])
    expect(conn.discovery?.api).toBe("https://api.individual.githubcopilot.com")
    expect(conn.discovery?.plan).toBe("pro")
    expect(conn.discovery?.login).toBe("ent-user")
    expect(conn.discovery?.ok).toBe(true)
    expect(conn.discovery?.err).toBeUndefined()
    // Account-level proxy fields still ride along.
    expect(bundle.accounts[0].proxyUrl).toBe("https://proxy.example")
    expect(bundle.accounts[0].proxyToken).toBe("ptok")

    // Re-parse through the schema so the test also exercises the
    // decode path — catches accidental drift between the in-memory
    // shape and the on-wire JSON.
    const json = JSON.parse(JSON.stringify(bundle))
    const reparsed = parseBundle(json)
    expect(reparsed.connections["github-copilot"].envelope).toBe(true)
    expect(reparsed.connections["github-copilot"].machineId).toBe("11111111-2222-3333-4444-555555555555")
    expect(reparsed.connections["github-copilot"].unsupportedModels).toEqual(["gpt-5-pro", "claude-opus-4-7"])
    expect(reparsed.connections["github-copilot"].discovery?.models).toEqual(["claude-opus-4-7", "gpt-5"])
  })

  test("applyBundle restores every v2 field on an empty state", () => {
    // Import target has no Copilot creds, no connection state. After
    // apply, every v2 field must be visible on `nextState.connections`.
    const bundle: Bundle = {
      version: BUNDLE_VERSION,
      accounts: [{ key: "github-copilot", label: "Primary", refresh: "rt" }],
      connections: {
        "github-copilot": {
          label: "Primary",
          plan: "pro",
          proxyUrl: "https://proxy.example",
          proxyToken: "ptok",
          envelope: true,
          machineId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          deactivated: true,
          unsupportedModels: ["gpt-5-pro"],
          discovery: {
            at: 1700000000000,
            models: ["gpt-5", "claude-opus-4-7"],
            api: "https://api.githubcopilot.com",
            plan: "pro",
            login: "user42",
            ok: true,
          },
        },
      },
      exportedAt: 0,
    }
    const { nextAuth, nextState } = applyBundle({
      bundle,
      existingAuth: {},
      existingState: emptyConnections(),
      mode: "merge",
    })
    expect((nextAuth["github-copilot"] as any).refresh).toBe("rt")
    const conn = nextState.connections["github-copilot"]
    expect(conn).toBeDefined()
    expect(conn.label).toBe("Primary")
    expect(conn.plan).toBe("pro")
    expect(conn.proxyUrl).toBe("https://proxy.example")
    expect(conn.proxyToken).toBe("ptok")
    expect(conn.envelope).toBe(true)
    expect(conn.machineId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    expect(conn.deactivated).toBe(true)
    expect(conn.unsupportedModels).toEqual(["gpt-5-pro"])
    expect(conn.discovery?.at).toBe(1700000000000)
    expect(conn.discovery?.models).toEqual(["gpt-5", "claude-opus-4-7"])
    expect(conn.discovery?.api).toBe("https://api.githubcopilot.com")
    expect(conn.discovery?.plan).toBe("pro")
    expect(conn.discovery?.login).toBe("user42")
    expect(conn.discovery?.ok).toBe(true)
  })

  test("deactivated flag survives export -> import round-trip across machines", async () => {
    // Seed machine A: one account, flagged as deactivated (e.g. server
    // returned 401/403 and the runtime suspended it).
    await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("github-copilot", {
          type: "oauth",
          refresh: "rt-a",
          access: "at-a",
          expires: 0,
        })
        const fs = yield* AppFileSystem.Service
        const store = new ConnectionsStore(fs)
        yield* store.write({
          version: 1,
          connections: {
            "github-copilot": {
              plan: "pro",
              deactivated: true,
              machineId: "00000000-1111-2222-3333-444444444444",
              envelope: true,
              unsupportedModels: ["gpt-5-pro"],
              discovery: {
                at: 1700000000000,
                models: ["gpt-5"],
                ok: false,
                err: "token_expired",
              },
            },
          },
        })
      }),
    )

    // Export on machine A.
    const bundle = await provide(exportBundle({ exportedBy: "machine-A" }))
    expect(bundle.connections["github-copilot"].deactivated).toBe(true)

    // Move to machine B: wipe and import the bundle.
    await resetCopilotAuth()
    await provide(importBundle(bundle, { mode: "merge" }))

    // Read back the restored connections state on machine B.
    const restored = await provide(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const store = new ConnectionsStore(fs)
        return yield* store.read()
      }),
    )
    const conn = restored.connections["github-copilot"]
    expect(conn).toBeDefined()
    // The whole point of this test: a suspension flagged on one machine
    // stays visible when sharing the bundle to a peer.
    expect(conn.deactivated).toBe(true)
    expect(conn.machineId).toBe("00000000-1111-2222-3333-444444444444")
    expect(conn.envelope).toBe(true)
    expect(conn.unsupportedModels).toEqual(["gpt-5-pro"])
    expect(conn.discovery?.at).toBe(1700000000000)
    expect(conn.discovery?.models).toEqual(["gpt-5"])
    expect(conn.discovery?.ok).toBe(false)
    expect(conn.discovery?.err).toBe("token_expired")
  })

  test("redacted bundle roundtrip retains connection metadata but no refresh tokens", async () => {
    await provide(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("github-copilot", {
          type: "oauth",
          refresh: "rt",
          access: "at",
          expires: 0,
        })
        const fs = yield* AppFileSystem.Service
        const store = new ConnectionsStore(fs)
        yield* store.write({
          version: 1,
          connections: { "github-copilot": { proxyUrl: "https://p", proxyToken: "tk", plan: "pro" } },
        })
      }),
    )
    const bundle = await provide(exportBundle({ redactTokens: true }))
    expect(bundle.accounts[0].refresh).toBeUndefined()
    expect(bundle.accounts[0].proxyToken).toBeUndefined()
    // Re-parse through the schema and ensure round-trip is clean.
    const reparsed = parseBundle(JSON.parse(JSON.stringify(bundle)))
    expect(reparsed.redacted).toBe(true)
    expect(reparsed.connections["github-copilot"].proxyUrl).toBe("https://p")
    expect(reparsed.connections["github-copilot"].proxyToken).toBeUndefined()
  })
})
