import type { CopilotAuth } from "./auth"

export type Reserve = {
  key: string
  held: boolean
  release: () => void
}

export type Pool = Record<string, number>

export type Event = {
  at: number
  key: string
  type: "reserve" | "release" | "touch"
  load: number
  lane?: string
  discovery?: number
  penalty?: number
  cooldown?: boolean
}

export type Runtime = {
  pool: Pool
  limit: number
  minIntervalMs: number
  last: Record<string, number>
  feed: Event[]
}

export function emptyPool(): Pool {
  return {}
}

export function owner(limit = 1, minIntervalMs = 0): Runtime {
  return { pool: emptyPool(), limit, minIntervalMs, last: {}, feed: [] }
}

export function event(state: Runtime, type: Event["type"], key: string, at = Date.now(), meta?: Partial<Omit<Event, "at" | "key" | "type" | "load">>) {
  state.feed = [
    { at, key, type, load: load(state, key), ...meta },
    ...state.feed,
  ].slice(0, 24)
  return state
}

export function runtime(pool: Pool | undefined, key: string) {
  return pool?.[key] ?? 0
}

export function acquire(pool: Pool | undefined, key: string) {
  return {
    ...pool,
    [key]: runtime(pool, key) + 1,
  }
}

export function release(pool: Pool | undefined, key: string) {
  const count = runtime(pool, key)
  if (count <= 1) {
    const next = { ...pool }
    delete next[key]
    return next
  }
  return {
    ...pool,
    [key]: count - 1,
  }
}

export function available(state: Runtime | undefined, key: string) {
  const limit = state?.limit ?? 1
  return runtime(state?.pool, key) < limit
}

export function eligible(state: Runtime | undefined, auths: CopilotAuth[]) {
  const idle = auths.filter((item) => available(state, item.key))
  return idle.length > 0 ? idle : auths
}

export function cooldown(state: Runtime | undefined, key: string, now = Date.now()) {
  if (!state?.minIntervalMs) return false
  const at = state.last[key]
  if (!at) return false
  return now - at < state.minIntervalMs
}

export function load(state: Runtime | undefined, key: string) {
  return runtime(state?.pool, key)
}

export function touch(state: Runtime, key: string, at = Date.now()) {
  state.last[key] = at
  event(state, "touch", key, at)
  return state
}

export type Usage = {
  key: string
  load: number
  last: number | null
}

export function reserve(state: Runtime, key: string): Reserve {
  state.pool = acquire(state.pool, key)
  event(state, "reserve", key)
  return {
    key,
    held: true,
    release() {
      if (!this.held) return
      this.held = false
      state.pool = release(state.pool, key)
      event(state, "release", key)
    },
  }
}

export function reserveBatch(state: Runtime, keys: string[]) {
  const held = keys.map((key) => reserve(state, key))
  return {
    held,
    release(key: string) {
      const slot = held.find((item) => item.key === key)
      slot?.release()
    },
    releaseAll() {
      held.forEach((item) => item.release())
    },
  }
}

export function usage(state: Runtime | undefined) {
  const keys = new Set([...Object.keys(state?.pool ?? {}), ...Object.keys(state?.last ?? {})])
  return [...keys]
    .map((key) => ({ key, load: load(state, key), last: state?.last[key] ?? null }))
    .sort((a, b) => b.load - a.load || a.key.localeCompare(b.key))
}

export function feed(state: Runtime | undefined) {
  return state?.feed ?? []
}
