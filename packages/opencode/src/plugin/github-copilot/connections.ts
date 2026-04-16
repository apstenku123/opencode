import { connectionFile } from "./paths"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect, Schema } from "effect"
import { zod } from "@/util/effect-zod"
import type { CopilotAuth } from "./auth"

const Discovery = Schema.Struct({
  at: Schema.Number,
  models: Schema.Array(Schema.String),
  api: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  ok: Schema.optional(Schema.Boolean),
  err: Schema.optional(Schema.String),
})

const Conn = Schema.Struct({
  exhaustedUntil: Schema.optional(Schema.Number),
  lastTestedAt: Schema.optional(Schema.Number),
  lastRoutedAt: Schema.optional(Schema.Number),
  lastDiscoveryErrorAt: Schema.optional(Schema.Number),
  label: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  preferred: Schema.optional(Schema.Boolean),
  machineId: Schema.optional(Schema.String),
  proxyUrl: Schema.optional(Schema.String),
  proxyToken: Schema.optional(Schema.String),
  discovery: Schema.optional(Discovery),
})

const State = Schema.Struct({
  version: Schema.Number,
  preferred: Schema.optional(Schema.String),
  connections: Schema.Record(Schema.String, Conn),
})

export type Conn = typeof Conn.Type
export type State = typeof State.Type

export const StateSchema = Object.assign(State, { zod: zod(State) })

export function empty(): State {
  return { version: 1, connections: {} }
}

export function sort(auths: CopilotAuth[], state: State) {
  return [...auths].sort((a, b) => {
    if (state.preferred === a.key) return -1
    if (state.preferred === b.key) return 1
    if (a.key === "github-copilot") return -1
    if (b.key === "github-copilot") return 1
    return a.key.localeCompare(b.key)
  })
}

export function next(auths: CopilotAuth[], state: State, now = Date.now()) {
  const items = sort(auths, state)
  const live = items.filter((item) => {
    const until = state.connections[item.key]?.exhaustedUntil
    return !until || until <= now
  })
  if (live.length > 0) return live[0]
  return items[0]
}

export function rotate(state: State, auths: CopilotAuth[]) {
  return [...auths].sort((a, b) => {
    const av = state.connections[a.key]?.lastRoutedAt ?? 0
    const bv = state.connections[b.key]?.lastRoutedAt ?? 0
    if (av !== bv) return av - bv
    return sort([a, b], state)[0]?.key === a.key ? -1 : 1
  })
}

export function routed(state: State, key: string, at = Date.now()) {
  return upsert(state, key, { lastRoutedAt: at })
}

export function upsert(state: State, key: string, input: Partial<Conn>): State {
  return {
    ...state,
    connections: {
      ...state.connections,
      [key]: {
        ...state.connections[key],
        ...input,
      },
    },
  }
}

export function mark(state: State, key: string, until: number) {
  return upsert(state, key, { exhaustedUntil: until })
}

export function clear(state: State, key: string) {
  const item = state.connections[key]
  if (!item) return state
  return upsert(state, key, { exhaustedUntil: undefined })
}

export function machine(state: State, key: string) {
  const item = state.connections[key]
  if (item?.machineId) return [state, item.machineId] as const
  const machineId = crypto.randomUUID().toLowerCase()
  return [upsert(state, key, { machineId }), machineId] as const
}

export function discovered(state: State, key: string) {
  return state.connections[key]?.discovery
}

export function discover(
  state: State,
  key: string,
  input: {
    at?: number
    models: string[]
    api?: string
    plan?: string
    login?: string
    ok?: boolean
    err?: string
  },
) {
  const at = input.at ?? Date.now()
  return upsert(state, key, {
    discovery: {
      at,
      models: [...new Set(input.models)].sort(),
      api: input.api,
      plan: input.plan,
      login: input.login,
      ok: input.ok,
      err: input.err,
    },
    lastDiscoveryErrorAt: input.ok === false || input.err ? at : undefined,
  })
}

export function clearDiscovery(state: State, key: string) {
  return upsert(state, key, { discovery: undefined })
}

export function hasModel(state: State, key: string, model: string) {
  return !!state.connections[key]?.discovery?.models.includes(model)
}

export function staleDiscovery(state: State, key: string, now = Date.now(), max = 30 * 60 * 1000) {
  const item = state.connections[key]?.discovery
  if (!item) return true
  return now - item.at > max
}

export class Store {
  constructor(private fs: AppFileSystem.Interface) {}

  read = Effect.fn("CopilotConnections.read")(
    function* (this: Store) {
      const raw = (yield* this.fs.readJson(connectionFile).pipe(Effect.orElseSucceed(() => empty()))) as unknown
      const parsed = Schema.decodeUnknownOption(State)(raw)
      return parsed._tag === "Some" ? parsed.value : empty()
    }.bind(this),
  )

  write = Effect.fn("CopilotConnections.write")(
    function* (this: Store, state: State) {
      yield* this.fs.writeJson(connectionFile, state, 0o600)
    }.bind(this),
  )
}

export function byPlan(state: State, key: string) {
  return state.connections[key]?.plan
}

export function proxy(state: State, key: string) {
  return {
    url: state.connections[key]?.proxyUrl,
    token: state.connections[key]?.proxyToken,
  }
}
