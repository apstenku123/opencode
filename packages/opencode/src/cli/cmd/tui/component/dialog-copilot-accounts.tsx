import path from "path"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"

/**
 * Shape mirrored loosely from `packages/opencode/src/plugin/github-copilot/connections.ts`.
 * Re-declared locally to keep the TUI layer from importing runtime plugin code
 * (per the task scope: no modifications to plugin/auth/connection sources).
 * Any unknown fields are tolerated via Partial<…> below.
 */
type DiscoveryLite = {
  at?: number
  models?: ReadonlyArray<string>
  api?: string
  plan?: string
  login?: string
  ok?: boolean
  err?: string
}

type ConnLite = {
  label?: string
  login?: string
  plan?: string
  machineId?: string
  proxyUrl?: string
  proxyToken?: string
  envelope?: boolean
  preferred?: boolean
  deactivated?: boolean
  exhaustedUntil?: number
  lastTestedAt?: number
  lastRoutedAt?: number
  lastDiscoveryErrorAt?: number
  discovery?: DiscoveryLite
  unsupportedModels?: ReadonlyArray<string>
}

type StateLite = {
  version?: number
  preferred?: string
  connections?: Record<string, ConnLite>
}

export type CopilotAccountsSummary = {
  total: number
  byPool: Record<string, number>
}

/**
 * Compute a compact one-line summary suitable for status bars. Deliberately
 * pure so callers (status-line widgets, tests) don't need to know how the
 * underlying JSON is laid out.
 */
export function summarizeConnections(state: StateLite | null | undefined): CopilotAccountsSummary {
  const connections = state?.connections ?? {}
  const byPool: Record<string, number> = {}
  let total = 0
  for (const [key, conn] of Object.entries(connections)) {
    if (!conn || Object.keys(conn).length === 0) continue
    total++
    const pool = derivePool(key, conn.plan)
    byPool[pool] = (byPool[pool] ?? 0) + 1
  }
  return { total, byPool }
}

/**
 * Lightweight pool heuristic — matches the default plan-→pool mapping used by
 * `poolForAccount` / `accountPoolLabel` without pulling in the full plugin
 * runtime. If the key carries an explicit `#edu…` / `#test…` suffix we bucket
 * it as `edu`; `enterprise` plans land in `prod`; anything else falls into
 * `other`.
 */
function derivePool(key: string, plan: string | undefined | null): string {
  if (/#edu/i.test(key) || /#test/i.test(key)) return "edu"
  if (plan && /enterprise|business|pro/i.test(plan)) return "prod"
  if (plan && /free|indiv/i.test(plan)) return "free"
  return plan || "other"
}

function formatAgeSec(ms: number | undefined): string {
  if (!ms || ms <= 0) return "—"
  const secs = Math.max(1, Math.floor((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function deriveHealth(conn: ConnLite): "ok" | "stale" | "deactivated" | "exhausted" | "unknown" {
  if (conn.deactivated) return "deactivated"
  if (conn.exhaustedUntil && conn.exhaustedUntil > Date.now()) return "exhausted"
  if (conn.discovery?.ok === true) return "ok"
  if (conn.discovery?.ok === false) return "stale"
  return "unknown"
}

export type CopilotAccountRow = {
  key: string
  label: string
  login: string
  plan: string
  pool: string
  health: ReturnType<typeof deriveHealth>
  proxyUrl: string
  machineId: string
  envelope: boolean
  preferred: boolean
  models: number
  premium: string
  lastRouted: number | undefined
  error: string | undefined
}

export function toRows(state: StateLite | null | undefined): CopilotAccountRow[] {
  const connections = state?.connections ?? {}
  const rows: CopilotAccountRow[] = []
  for (const [key, conn] of Object.entries(connections)) {
    if (!conn || Object.keys(conn).length === 0) continue
    rows.push({
      key,
      label: conn.label ?? key,
      login: conn.login ?? "—",
      plan: conn.plan ?? "—",
      pool: derivePool(key, conn.plan),
      health: deriveHealth(conn),
      proxyUrl: conn.proxyUrl ?? "",
      machineId: conn.machineId ?? "",
      envelope: conn.envelope === true,
      preferred: conn.preferred === true,
      models: conn.discovery?.models?.length ?? 0,
      // Schema doesn't carry premium numbers in the JSON file; rendered as a
      // hint unless the sibling HTTP route is wired in. Mirrors the CLI
      // `providers accounts` column which shows a bar when quota data is
      // available from `checkAccountStatuses`.
      premium: "—",
      lastRouted: conn.lastRoutedAt ?? conn.lastTestedAt,
      error: conn.discovery?.err,
    })
  }
  rows.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    if (a.pool !== b.pool) return a.pool.localeCompare(b.pool)
    return a.label.localeCompare(b.label)
  })
  return rows
}

const POLL_INTERVAL_MS = 3000

export function DialogCopilotAccounts() {
  const dialog = useDialog()
  const { theme } = useTheme()
  dialog.setSize("xlarge")

  const [state, setState] = createSignal<StateLite | null>(null)
  const [loadedOnce, setLoadedOnce] = createSignal(false)
  const [selected, setSelected] = createSignal(0)

  const filePath = path.join(Global.Path.data, "copilot-connections.json")

  async function load() {
    const text = await Filesystem.readText(filePath).catch(() => "")
    if (!text) {
      setState(null)
      setLoadedOnce(true)
      return
    }
    try {
      const parsed = JSON.parse(text) as StateLite
      setState(parsed)
    } catch {
      setState(null)
    } finally {
      setLoadedOnce(true)
    }
  }

  onMount(() => {
    void load()
    const handle = setInterval(() => {
      void load()
    }, POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(handle))
  })

  const rows = createMemo(() => toRows(state()))
  const summary = createMemo(() => summarizeConnections(state()))

  useKeyboard((evt) => {
    if (evt.name === "escape" || (evt.ctrl && evt.name === "c")) {
      dialog.clear()
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      const max = rows().length - 1
      setSelected((i) => Math.min(max, i + 1))
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      setSelected((i) => Math.max(0, i - 1))
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "r") {
      void load()
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  const selectedRow = createMemo(() => rows()[selected()])

  const healthColor = (h: CopilotAccountRow["health"]) => {
    switch (h) {
      case "ok":
        return theme.success
      case "stale":
        return theme.warning
      case "deactivated":
        return theme.error
      case "exhausted":
        return theme.warning
      default:
        return theme.textMuted
    }
  }

  const healthGlyph = (h: CopilotAccountRow["health"]) => {
    switch (h) {
      case "ok":
        return "●"
      case "stale":
        return "◐"
      case "deactivated":
        return "○"
      case "exhausted":
        return "◔"
      default:
        return "·"
    }
  }

  const poolsLine = createMemo(() => {
    const entries = Object.entries(summary().byPool)
    if (entries.length === 0) return "no accounts"
    return entries
      .toSorted((a, b) => a[0].localeCompare(b[0]))
      .map(([pool, n]) => `${pool}=${n}`)
      .join(" · ")
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Copilot accounts
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc · r=reload · ↑↓
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>
          <text fg={theme.text}>{summary().total}</text> total · {poolsLine()}
        </text>
        <Show when={!loadedOnce()}>
          <text fg={theme.textMuted}>loading {filePath}…</text>
        </Show>
      </box>
      <Show
        when={rows().length > 0}
        fallback={
          <box paddingTop={1} paddingBottom={1}>
            <text fg={theme.textMuted}>
              <Switch>
                <Match when={!loadedOnce()}>Reading copilot-connections.json…</Match>
                <Match when={state() === null}>
                  No copilot-connections.json found. Run `opencode providers login` to register an account.
                </Match>
                <Match when={true}>No accounts configured yet.</Match>
              </Switch>
            </text>
          </box>
        }
      >
        <box flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              {headerLine()}
            </text>
          </box>
          <For each={rows()}>
            {(row, i) => (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => setSelected(i())}
                backgroundColor={i() === selected() ? theme.backgroundPanel : undefined}
              >
                <text fg={healthColor(row.health)} flexShrink={0}>
                  {healthGlyph(row.health)}
                </text>
                <text fg={theme.text}>{formatRowLine(row)}</text>
              </box>
            )}
          </For>
        </box>
        <Show when={selectedRow()}>
          {(row) => (
            <box
              flexDirection="column"
              gap={0}
              paddingTop={1}
              paddingLeft={1}
              paddingRight={1}
              paddingBottom={1}
              backgroundColor={theme.backgroundPanel}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {row().label}{" "}
                <span style={{ fg: theme.textMuted }}>({row().key})</span>
              </text>
              <text fg={theme.textMuted}>
                login: <span style={{ fg: theme.text }}>{row().login}</span> · plan:{" "}
                <span style={{ fg: theme.text }}>{row().plan}</span> · pool:{" "}
                <span style={{ fg: theme.text }}>{row().pool}</span> · health:{" "}
                <span style={{ fg: healthColor(row().health) }}>{row().health}</span>
              </text>
              <text fg={theme.textMuted}>
                proxy: <span style={{ fg: theme.text }}>{row().proxyUrl || "—"}</span>
              </text>
              <text fg={theme.textMuted}>
                machineId: <span style={{ fg: theme.text }}>{row().machineId || "—"}</span>
              </text>
              <text fg={theme.textMuted}>
                envelope: <span style={{ fg: theme.text }}>{row().envelope ? "yes" : "no"}</span> · preferred:{" "}
                <span style={{ fg: theme.text }}>{row().preferred ? "yes" : "no"}</span> · models:{" "}
                <span style={{ fg: theme.text }}>{row().models}</span> · last routed:{" "}
                <span style={{ fg: theme.text }}>{formatAgeSec(row().lastRouted)}</span>
              </text>
              <Show when={row().error}>
                <text fg={theme.error}>error: {row().error}</text>
              </Show>
            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}

function headerLine(): string {
  // Fixed widths keep the column edges aligned without introducing a
  // dependency on a table component. If you tweak these, update
  // `formatRowLine` to match.
  return (
    pad("LABEL", 18) +
    " " +
    pad("LOGIN", 16) +
    " " +
    pad("PLAN", 12) +
    " " +
    pad("POOL", 8) +
    " " +
    pad("MODELS", 7) +
    " " +
    pad("HEALTH", 12)
  )
}

function formatRowLine(row: CopilotAccountRow): string {
  return (
    pad(truncate(row.label, 18), 18) +
    " " +
    pad(truncate(row.login, 16), 16) +
    " " +
    pad(truncate(row.plan, 12), 12) +
    " " +
    pad(truncate(row.pool, 8), 8) +
    " " +
    pad(String(row.models), 7) +
    " " +
    pad(row.health, 12)
  )
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value
  return value + " ".repeat(width - value.length)
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  return value.slice(0, Math.max(1, width - 1)) + "…"
}
