import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Global } from "../global"
import { Log } from "../util"

const log = Log.create({ service: "auth.keyring" })

/**
 * Port of `codex-rs/keyring-store/src/lib.rs` (225 LOC). Thin wrapper around
 * the `keytar` npm package for native OS keyring access:
 *
 *   - macOS: Keychain Services
 *   - Windows: Credential Vault
 *   - Linux: libsecret / gnome-keyring (optional; may be absent on headless)
 *
 * `keytar` is an **optional** runtime dep (native addon; unavailable on CI
 * and many Linux-headless hosts). When it fails to load, we transparently
 * fall back to an encrypted JSON file at
 * `~/.local/share/opencode/keyring.enc.json`, keyed by a machine-derived
 * scrypt-stretched passphrase (hostname + $USER + platform).
 *
 * Every call returns an `Effect` — callers integrate via `AppFileSystem`
 * layer just like the rest of `auth/`.
 */

// ---- schema -------------------------------------------------------------

export class KeyringError extends Schema.TaggedErrorClass<KeyringError>()("KeyringError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Identifies which backend satisfied the call. Observable in tests. */
export type Backend = "keytar" | "file"

export interface Interface {
  /** Backend currently in use. Stable for the process lifetime. */
  readonly backend: () => Effect.Effect<Backend>
  /** Retrieve a password (refresh token, API key, ...). Returns undefined if missing. */
  readonly get: (service: string, account: string) => Effect.Effect<string | undefined, KeyringError>
  /** Store or replace a password under (service, account). */
  readonly set: (service: string, account: string, password: string) => Effect.Effect<void, KeyringError>
  /** Delete a password. Returns true when something was removed. */
  readonly remove: (service: string, account: string) => Effect.Effect<boolean, KeyringError>
  /** List all (service, account) pairs for a given service. */
  readonly list: (service: string) => Effect.Effect<ReadonlyArray<{ account: string }>, KeyringError>
}

// ---- keytar dynamic loader ----------------------------------------------

interface KeytarModule {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (service: string, account: string, password: string) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
  findCredentials: (service: string) => Promise<Array<{ account: string; password: string }>>
}

let keytarCache: KeytarModule | null | undefined
async function loadKeytar(): Promise<KeytarModule | null> {
  if (keytarCache !== undefined) return keytarCache
  // Allow forcing the file backend in tests + CI where native addons are
  // unreliable. Also flip on when the native load itself blows up.
  if (process.env.OPENCODE_KEYRING_DISABLE === "1") {
    keytarCache = null
    return null
  }
  try {
    // Dynamic import keeps keytar an optional runtime dep.
    const mod = (await import(/* @vite-ignore */ "keytar" as string)) as KeytarModule | { default: KeytarModule }
    keytarCache = (mod as { default?: KeytarModule }).default ?? (mod as KeytarModule)
    return keytarCache
  } catch (cause) {
    log.info("keytar.unavailable", { reason: cause instanceof Error ? cause.message : String(cause) })
    keytarCache = null
    return null
  }
}

// Exported for tests.
export function _resetKeytarCache() {
  keytarCache = undefined
}

// ---- encrypted-file backend ---------------------------------------------

const FILE_VERSION = 1
const FILE_NAME = "keyring.enc.json"
/** AES-256-GCM: 96-bit IV, 128-bit tag. */
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SALT_BYTES = 16
const SCRYPT_COST = 1 << 14

interface FileDoc {
  version: number
  entries: Record<string, { iv: string; tag: string; ciphertext: string; salt: string }>
}

function machinePassphrase(): string {
  // Not a secret: we want a per-machine default that survives reboots.
  // Users who need stronger protection should install keytar.
  return [os.hostname(), process.env.USER ?? process.env.USERNAME ?? "anon", process.platform, process.arch].join("\0")
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_COST, r: 8, p: 1 })
}

function encryptValue(plaintext: string): FileDoc["entries"][string] {
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const key = deriveKey(machinePassphrase(), salt)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== TAG_BYTES) throw new Error(`unexpected gcm tag length: ${tag.length}`)
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
    salt: salt.toString("base64"),
  }
}

function decryptValue(entry: FileDoc["entries"][string]): string {
  const salt = Buffer.from(entry.salt, "base64")
  const iv = Buffer.from(entry.iv, "base64")
  const tag = Buffer.from(entry.tag, "base64")
  const ct = Buffer.from(entry.ciphertext, "base64")
  const key = deriveKey(machinePassphrase(), salt)
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(ct), decipher.final()])
  return dec.toString("utf8")
}

function entryKey(service: string, account: string): string {
  return `${encodeURIComponent(service)}::${encodeURIComponent(account)}`
}

function decodeEntryKey(key: string): { service: string; account: string } | null {
  const idx = key.indexOf("::")
  if (idx < 0) return null
  return {
    service: decodeURIComponent(key.slice(0, idx)),
    account: decodeURIComponent(key.slice(idx + 2)),
  }
}

// ---- implementation: make a backend-backed Interface -------------------

function makeKeytar(kt: KeytarModule): Interface {
  const fail = (op: string) => (cause: unknown) =>
    new KeyringError({ message: `keytar.${op} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
  return {
    backend: () => Effect.succeed("keytar" as const),
    get: (service, account) =>
      Effect.tryPromise({ try: () => kt.getPassword(service, account), catch: fail("getPassword") }).pipe(
        Effect.map((v) => v ?? undefined),
      ),
    set: (service, account, password) =>
      Effect.tryPromise({ try: () => kt.setPassword(service, account, password), catch: fail("setPassword") }),
    remove: (service, account) =>
      Effect.tryPromise({ try: () => kt.deletePassword(service, account), catch: fail("deletePassword") }),
    list: (service) =>
      Effect.tryPromise({ try: () => kt.findCredentials(service), catch: fail("findCredentials") }).pipe(
        Effect.map((items) => items.map((i) => ({ account: i.account }))),
      ),
  }
}

function makeFile(): Effect.Effect<Interface, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const file = path.join(Global.Path.data, FILE_NAME)

    const read = Effect.fn("Keyring.file.read")(function* () {
      const data = (yield* fsys
        .readJson(file)
        .pipe(Effect.orElseSucceed(() => ({ version: FILE_VERSION, entries: {} } satisfies FileDoc)))) as FileDoc
      if (!data || typeof data !== "object" || data.version !== FILE_VERSION || !data.entries) {
        return { version: FILE_VERSION, entries: {} } satisfies FileDoc
      }
      return data
    })

    const write = Effect.fn("Keyring.file.write")(function* (doc: FileDoc) {
      yield* fsys
        .writeJson(file, doc, 0o600)
        .pipe(Effect.mapError((cause) => new KeyringError({ message: "failed to persist keyring file", cause })))
    })

    return {
      backend: () => Effect.succeed("file" as const),
      get: (service, account) =>
        Effect.gen(function* () {
          const doc = yield* read()
          const entry = doc.entries[entryKey(service, account)]
          if (!entry) return undefined
          try {
            return decryptValue(entry)
          } catch (cause) {
            return yield* Effect.fail(new KeyringError({ message: "failed to decrypt keyring entry", cause }))
          }
        }),
      set: (service, account, password) =>
        Effect.gen(function* () {
          const doc = yield* read()
          doc.entries[entryKey(service, account)] = encryptValue(password)
          yield* write(doc)
        }),
      remove: (service, account) =>
        Effect.gen(function* () {
          const doc = yield* read()
          const key = entryKey(service, account)
          if (!(key in doc.entries)) return false
          delete doc.entries[key]
          yield* write(doc)
          return true
        }),
      list: (service) =>
        Effect.gen(function* () {
          const doc = yield* read()
          const out: { account: string }[] = []
          for (const key of Object.keys(doc.entries)) {
            const decoded = decodeEntryKey(key)
            if (!decoded) continue
            if (decoded.service !== service) continue
            out.push({ account: decoded.account })
          }
          return out
        }),
    } satisfies Interface
  })
}

/** Build a keyring interface, preferring keytar when available. */
export function make(): Effect.Effect<Interface, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const kt = yield* Effect.promise(() => loadKeytar())
    if (kt) return makeKeytar(kt)
    return yield* makeFile()
  })
}
