import { beforeEach, describe, expect, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Auth } from "../../src/auth"
import * as Keyring from "../../src/auth/keyring"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Force the file-based fallback for deterministic, keytar-free tests. The
// keyring module will skip dynamic-importing keytar when this env is set.
const prevDisable = process.env.OPENCODE_KEYRING_DISABLE
process.env.OPENCODE_KEYRING_DISABLE = "1"

const node = CrossSpawnSpawner.defaultLayer
const fsys = AppFileSystem.defaultLayer
const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node, fsys))

describe("Keyring (file backend)", () => {
  beforeEach(() => {
    Keyring._resetKeytarCache()
  })

  afterEach(() => {
    Keyring._resetKeytarCache()
  })

  it.live("reports file backend when keytar is disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        const backend = yield* kr.backend()
        expect(backend).toBe("file")
      }),
    ),
  )

  it.live("set -> get round trips a secret", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        yield* kr.set("opencode-test", "alpha", "s3cret-value")
        const v = yield* kr.get("opencode-test", "alpha")
        expect(v).toBe("s3cret-value")
      }),
    ),
  )

  it.live("get on missing account returns undefined", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        const v = yield* kr.get("opencode-test", "missing")
        expect(v).toBeUndefined()
      }),
    ),
  )

  it.live("remove deletes the entry, idempotent after", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        yield* kr.set("opencode-test", "beta", "v")
        const hit = yield* kr.remove("opencode-test", "beta")
        expect(hit).toBe(true)
        const v = yield* kr.get("opencode-test", "beta")
        expect(v).toBeUndefined()
        const again = yield* kr.remove("opencode-test", "beta")
        expect(again).toBe(false)
      }),
    ),
  )

  it.live("list returns accounts for a service", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        yield* kr.set("svc-a", "one", "x")
        yield* kr.set("svc-a", "two", "y")
        yield* kr.set("svc-b", "three", "z")
        const listed = yield* kr.list("svc-a")
        const names = listed.map((i) => i.account).sort()
        expect(names).toEqual(["one", "two"])
      }),
    ),
  )

  it.live("replaces an existing secret", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        yield* kr.set("svc", "acct", "v1")
        yield* kr.set("svc", "acct", "v2")
        const v = yield* kr.get("svc", "acct")
        expect(v).toBe("v2")
      }),
    ),
  )

  it.live("encryption changes between writes (nonce varies)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const kr = yield* Keyring.make()
        yield* kr.set("svc", "a", "same-value")
        const fsSvc = yield* AppFileSystem.Service
        // Read the raw file and check entries map exists.
        const raw1 = JSON.stringify(yield* fsSvc.readJson(require("path").join(require("../../src/global").Global.Path.data, "keyring.enc.json")))
        yield* kr.set("svc", "a", "same-value")
        const raw2 = JSON.stringify(yield* fsSvc.readJson(require("path").join(require("../../src/global").Global.Path.data, "keyring.enc.json")))
        // Same plaintext but different IVs => different ciphertexts.
        expect(raw1).not.toEqual(raw2)
      }),
    ),
  )
})

describe("Auth integration with keyring enabled", () => {
  beforeEach(() => {
    process.env.OPENCODE_USE_KEYRING = "1"
    Keyring._resetKeytarCache()
  })
  afterEach(() => {
    delete process.env.OPENCODE_USE_KEYRING
    Keyring._resetKeytarCache()
  })

  it.live("api key secret is routed through keyring; file retains type only", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", { type: "api", key: "sk-super-secret" })
        const data = yield* auth.all()
        const entry = data["anthropic"]
        expect(entry?.type).toBe("api")
        if (entry?.type === "api") expect(entry.key).toBe("sk-super-secret")

        // File on disk should have the secret stripped.
        const fsSvc = yield* AppFileSystem.Service
        const path = require("path")
        const { Global } = require("../../src/global")
        const raw = (yield* fsSvc.readJson(path.join(Global.Path.data, "auth.json"))) as Record<string, any>
        expect(raw["anthropic"]?.type).toBe("api")
        expect(raw["anthropic"]?.key).toBe("")
      }),
    ),
  )

  it.live("oauth refresh + access are stripped from file and re-stitched on read", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("github", {
          type: "oauth",
          refresh: "refresh-XYZ",
          access: "access-XYZ",
          expires: 1_700_000_000,
        })
        const data = yield* auth.all()
        const entry = data["github"]
        expect(entry?.type).toBe("oauth")
        if (entry?.type === "oauth") {
          expect(entry.refresh).toBe("refresh-XYZ")
          expect(entry.access).toBe("access-XYZ")
          expect(entry.expires).toBe(1_700_000_000)
        }

        const fsSvc = yield* AppFileSystem.Service
        const path = require("path")
        const { Global } = require("../../src/global")
        const raw = (yield* fsSvc.readJson(path.join(Global.Path.data, "auth.json"))) as Record<string, any>
        expect(raw["github"]?.refresh).toBe("")
        expect(raw["github"]?.access).toBe("")
        expect(raw["github"]?.expires).toBe(1_700_000_000)
      }),
    ),
  )

  it.live("remove cleans both file entry and keyring secrets", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", { type: "api", key: "sk-1" })
        yield* auth.remove("anthropic")
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeUndefined()
      }),
    ),
  )
})

// restore env flag at module teardown so later suites see the original value
process.on("beforeExit", () => {
  if (prevDisable === undefined) delete process.env.OPENCODE_KEYRING_DISABLE
  else process.env.OPENCODE_KEYRING_DISABLE = prevDisable
})
