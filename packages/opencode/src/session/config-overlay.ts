/**
 * Session-scoped config overlay registry.
 *
 * Stores a per-session config overlay (a partial `Config.Info` tree) that is
 * deep-merged over the instance-wide config whenever config-dependent code
 * paths resolve effective settings for a given `sessionID`.
 *
 * This lets tests (and, in the future, per-session runtime tweaks) mutate
 * hooks / memories / skills config for one session without respawning
 * `opencode serve` or mutating the global config file.
 *
 * Usage:
 *
 *   - Set once at session create time (`POST /session` with `configOverlay`).
 *   - Read lazily via `applyOverlay(cfg, sessionID)` wherever a code path
 *     needs the effective config for that session.
 *   - Cleared automatically on session delete — or manually via `clear`.
 *
 * The registry is a process-local `Map`. Safe across concurrent sessions in
 * one server process; NOT shared across processes (tests that need cross-
 * process overlay must fall through to the on-disk config).
 */
import { mergeDeep } from "remeda"
import type { Config } from "@/config"

const registry = new Map<string, Record<string, unknown>>()

function appendUnique(list: string[], values: string[]) {
  const seen = new Set(list)
  return [...list, ...values.filter((value) => !seen.has(value))]
}

/** Assign an overlay for `sessionID`. Replaces any previous entry. */
export function set(sessionID: string, overlay: Record<string, unknown> | undefined): void {
  if (!overlay || Object.keys(overlay).length === 0) {
    registry.delete(sessionID)
    return
  }
  registry.set(sessionID, overlay)
}

/** Get the raw overlay for `sessionID`, or `undefined` if none. */
export function get(sessionID: string | undefined): Record<string, unknown> | undefined {
  if (!sessionID) return undefined
  return registry.get(sessionID)
}

/** Remove any overlay associated with `sessionID`. */
export function clear(sessionID: string): void {
  registry.delete(sessionID)
}

/** For tests: purge all overlays. */
export function reset(): void {
  registry.clear()
}

/**
 * Deep-merge the current overlay (if any) for `sessionID` on top of `cfg`.
 * Returns `cfg` unchanged when no overlay is registered so hot paths avoid
 * unnecessary object churn.
 */
export function applyOverlay<T extends Config.Info>(cfg: T, sessionID: string | undefined): T {
  const overlay = get(sessionID)
  if (!overlay) return cfg
  return mergeDeep(cfg as unknown as Record<string, unknown>, overlay) as unknown as T
}

export function appendSessionSkillPaths(sessionID: string, paths: string[]): Record<string, unknown> {
  const next = paths.map((path) => path.trim()).filter(Boolean)
  const current = get(sessionID) ?? {}
  const currentSkills = current.skills as { paths?: string[] } | undefined
  const merged = appendUnique(currentSkills?.paths ?? [], next)
  const overlay = mergeDeep(current, {
    skills: {
      ...(currentSkills ?? {}),
      paths: merged,
    },
  })
  set(sessionID, overlay)
  return overlay
}

export function removeSessionSkillPaths(sessionID: string, paths: string[]): Record<string, unknown> | undefined {
  const current = get(sessionID)
  if (!current) return undefined
  const skillPaths = new Set(paths.map((path) => path.trim()).filter(Boolean))
  if (skillPaths.size === 0) return current

  const currentSkills = current.skills as { paths?: string[] } | undefined
  const remaining = (currentSkills?.paths ?? []).filter((path) => !skillPaths.has(path))
  const nextSkills = {
    ...(currentSkills ?? {}),
    ...(remaining.length > 0 ? { paths: remaining } : {}),
  }
  if (remaining.length === 0) delete nextSkills.paths

  const nextOverlay = {
    ...current,
    ...(Object.keys(nextSkills).length > 0 ? { skills: nextSkills } : {}),
  }
  if (Object.keys(nextSkills).length === 0) delete nextOverlay.skills
  set(sessionID, nextOverlay)
  return get(sessionID)
}
