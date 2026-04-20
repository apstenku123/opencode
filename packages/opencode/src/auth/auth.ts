import path from "path"
import { Effect, Layer, Record, Result, Schema, Context, Ref } from "effect"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Log } from "../util"
import * as Keyring from "./keyring"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

/**
 * Keyring service name. Refresh tokens + API keys are keyed under this
 * service in the OS keyring when available, with the provider id as the
 * account. Enabled by setting OPENCODE_USE_KEYRING=1 (or via config in the
 * future). When disabled — or when the keyring backend fails — auth falls
 * back to the existing plaintext `auth.json` behaviour.
 */
const KEYRING_SERVICE = "opencode"

const log = Log.create({ service: "auth" })

function keyringEnabled(): boolean {
  return process.env.OPENCODE_USE_KEYRING === "1"
}

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

/**
 * Secret fields per Info variant. When the keyring is enabled these fields
 * are stripped from `auth.json` and persisted to the OS keyring instead.
 * On read they are stitched back together. If the keyring call fails we
 * transparently fall through to the values stored inline in the file (so
 * existing deployments keep working during migration).
 */
const SECRET_FIELDS = {
  oauth: ["refresh", "access"] as const,
  api: ["key"] as const,
  wellknown: ["token"] as const,
}

function secretAccount(provider: string, field: string): string {
  return `${provider}::${field}`
}

function splitSecrets(info: Info): { stripped: Info; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {}
  const clone = { ...info } as any
  if (info.type === "oauth") {
    for (const f of SECRET_FIELDS.oauth) {
      secrets[f] = (info as any)[f]
      clone[f] = ""
    }
  } else if (info.type === "api") {
    for (const f of SECRET_FIELDS.api) {
      secrets[f] = (info as any)[f]
      clone[f] = ""
    }
  } else if (info.type === "wellknown") {
    for (const f of SECRET_FIELDS.wellknown) {
      secrets[f] = (info as any)[f]
      clone[f] = ""
    }
  }
  return { stripped: clone as Info, secrets }
}

function mergeSecrets(info: Info, secrets: Record<string, string>): Info {
  const clone = { ...info } as any
  for (const [k, v] of Object.entries(secrets)) {
    if (v && !clone[k]) clone[k] = v
  }
  return clone as Info
}

function secretFieldsFor(info: Info): ReadonlyArray<string> {
  if (info.type === "oauth") return SECRET_FIELDS.oauth as unknown as string[]
  if (info.type === "api") return SECRET_FIELDS.api as unknown as string[]
  return SECRET_FIELDS.wellknown as unknown as string[]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    const keyringRef = yield* Ref.make<Keyring.Interface | undefined>(undefined)

    const getKeyring = Effect.fn("Auth.getKeyring")(function* () {
      if (!keyringEnabled()) return undefined
      const cached = yield* Ref.get(keyringRef)
      if (cached) return cached
      const created = yield* Keyring.make().pipe(Effect.provideService(AppFileSystem.Service, fsys))
      const backend = yield* created.backend()
      log.info("keyring.enabled", { backend })
      yield* Ref.set(keyringRef, created)
      return created
    })

    const envSnapshot = yield* Ref.make<Record<string, Info> | undefined>(undefined)

    const keyringGet = (provider: string, field: string): Effect.Effect<string | undefined, never> => {
      return Effect.gen(function* () {
        const keyring = yield* getKeyring()
        if (!keyring) return undefined as string | undefined
        return yield* keyring.get(KEYRING_SERVICE, secretAccount(provider, field)).pipe(
        Effect.catch((err: Keyring.KeyringError) => {
          log.info("keyring.get.fallback", { provider, field, error: err.message })
          return Effect.succeed(undefined as string | undefined)
        }),
        )
      })
    }

    const keyringSet = (provider: string, field: string, value: string): Effect.Effect<boolean, never> => {
      return Effect.gen(function* () {
        const keyring = yield* getKeyring()
        if (!keyring) return true
        return yield* keyring.set(KEYRING_SERVICE, secretAccount(provider, field), value).pipe(
          Effect.as(true),
          Effect.catch((err: Keyring.KeyringError) => {
            log.info("keyring.set.fallback", { provider, field, error: err.message })
            return Effect.succeed(false)
          }),
        )
      })
    }

    const keyringRemove = (provider: string, fields: ReadonlyArray<string>): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const keyring = yield* getKeyring()
        if (!keyring) return
        for (const f of fields) {
          yield* keyring.remove(KEYRING_SERVICE, secretAccount(provider, f)).pipe(
            Effect.catch((err: Keyring.KeyringError) => {
              log.info("keyring.remove.fallback", { provider, field: f, error: err.message })
              return Effect.succeed(false)
            }),
          )
        }
      })

    const takeEnvSnapshot = Effect.fn("Auth.takeEnvSnapshot")(function* () {
      const cached = yield* Ref.get(envSnapshot)
      if (cached !== undefined) return cached
      const raw = process.env.OPENCODE_AUTH_CONTENT
      if (!raw) {
        yield* Ref.set(envSnapshot, {})
        return undefined
      }
      const parsed = yield* Effect.sync(() => JSON.parse(raw) as Record<string, unknown>).pipe(Effect.option)
      if (parsed._tag === "None") {
        yield* Ref.set(envSnapshot, {})
        return undefined
      }
      const decoded = Record.filterMap(parsed.value, (value) => Result.fromOption(decode(value), () => undefined))
      yield* Ref.set(envSnapshot, decoded)
      return decoded
    })

    const readPersisted = Effect.fn("Auth.readPersisted")(function* () {
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const all = Effect.fn("Auth.all")(function* () {
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      const bootstrapped = yield* takeEnvSnapshot()
      const decoded = Object.keys(data).length
        ? Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
        : (bootstrapped ?? {})

      if (!(yield* getKeyring())) return decoded

      // Stitch secrets back from the keyring. Any missing values stay as
      // whatever was in the file (pre-migration compatibility).
      const result: Record<string, Info> = {}
      for (const [key, info] of Object.entries(decoded)) {
        const fields = secretFieldsFor(info)
        const secrets: Record<string, string> = {}
        for (const f of fields) {
          const v = yield* keyringGet(key, f)
          if (v !== undefined) secrets[f] = v
        }
        result[key] = mergeSecrets(info, secrets)
      }
      return result
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* readPersisted()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      delete data[norm]

      let toPersist: Info = info
      if (yield* getKeyring()) {
        const { stripped, secrets } = splitSecrets(info)
        const writes = yield* Effect.forEach(
          Object.entries(secrets),
          ([field, value]) => keyringSet(norm, field, value).pipe(Effect.map((ok) => ({ field, ok }))),
        )
        const failed = writes.filter((item) => !item.ok).map((item) => item.field)
        if (failed.length) {
          return yield* new AuthError({
            message: `Failed to persist auth secrets to keyring: ${failed.join(", ")}`,
          })
        }
        toPersist = stripped
      }

      yield* fsys
        .writeJson(file, { ...data, [norm]: toPersist }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
      if (process.env.OPENCODE_AUTH_CONTENT) {
        yield* Ref.set(envSnapshot, { ...data, [norm]: info })
      }
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const existing = yield* get(norm)
      const data = yield* readPersisted()
      if (norm !== key) delete data[key]
      delete data[key]
      delete data[norm]

      if ((yield* getKeyring()) && existing) {
        yield* keyringRemove(norm, secretFieldsFor(existing))
      }

      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      if (process.env.OPENCODE_AUTH_CONTENT) {
        yield* Ref.set(envSnapshot, data)
      }
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))
