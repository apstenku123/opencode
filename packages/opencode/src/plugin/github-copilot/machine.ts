import type { State } from "./connections"
import { machine } from "./connections"

export function get(state: State, key: string) {
  return machine(state, key)
}
