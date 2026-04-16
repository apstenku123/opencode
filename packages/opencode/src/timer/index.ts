export namespace Timer {
  export type ID = string

  export type Info = {
    id: ID
    delay: number
    repeat: boolean
    active: boolean
    next: number | null
  }

  export type Fired = {
    id: ID
    at: number
  }

  export type Clock = {
    now(): number
    setTimeout(fn: () => void, ms: number): unknown
    clearTimeout(id: unknown): void
  }

  type State = {
    info: Info
    handle: unknown | undefined
  }

  function makeClock(): Clock {
    return {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    }
  }

  export function create(clock: Clock = makeClock()) {
    const items = new Map<ID, State>()
    const fired: Fired[] = []

    function arm(state: State) {
      if (!state.info.active) return
      state.info.next = clock.now() + state.info.delay
      state.handle = clock.setTimeout(() => {
        fired.push({ id: state.info.id, at: clock.now() })
        if (!state.info.repeat) {
          state.info.active = false
          state.info.next = null
          state.handle = undefined
          return
        }
        arm(state)
      }, state.info.delay)
    }

    function disarm(state: State) {
      if (state.handle !== undefined) {
        clock.clearTimeout(state.handle)
        state.handle = undefined
      }
      state.info.next = null
    }

    return {
      create(id: ID, delay: number, repeat = false) {
        const prev = items.get(id)
        if (prev) disarm(prev)
        const state = {
          info: {
            id,
            delay,
            repeat,
            active: true,
            next: null,
          },
          handle: undefined,
        } satisfies State
        items.set(id, state)
        arm(state)
        return { ...state.info }
      },
      pause(id: ID) {
        const state = items.get(id)
        if (!state || !state.info.active) return undefined
        disarm(state)
        state.info.active = false
        return { ...state.info }
      },
      resume(id: ID) {
        const state = items.get(id)
        if (!state || state.info.active) return state ? { ...state.info } : undefined
        state.info.active = true
        arm(state)
        return { ...state.info }
      },
      delete(id: ID) {
        const state = items.get(id)
        if (!state) return false
        disarm(state)
        return items.delete(id)
      },
      get(id: ID) {
        const state = items.get(id)
        return state ? { ...state.info } : undefined
      },
      list() {
        return [...items.values()].map((state) => ({ ...state.info }))
      },
      drain() {
        return fired.splice(0, fired.length)
      },
      clear() {
        for (const state of items.values()) disarm(state)
        items.clear()
        fired.splice(0, fired.length)
      },
    }
  }
}
