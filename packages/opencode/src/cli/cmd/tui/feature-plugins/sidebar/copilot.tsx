import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { CopilotRuntimeState } from "@/plugin/github-copilot/copilot"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

const id = "internal:sidebar-copilot"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [tick, setTick] = createSignal(0)
  const [open, setOpen] = createSignal(false)
  onMount(() => {
    const id = setInterval(() => setTick((x) => x + 1), 500)
    onCleanup(() => clearInterval(id))
  })
  const usage = createMemo(() => {
    tick()
    return CopilotRuntimeState.usage().filter((item) => item.key.startsWith("github-copilot"))
  })
  const feed = createMemo(() => {
    tick()
    return CopilotRuntimeState.feed().filter((item) => item.key.startsWith("github-copilot"))
  })
  const rows = createMemo(() => (open() ? feed().slice(0, 8) : feed().slice(0, 3)))
  const show = createMemo(() => usage().length > 0 || feed().length > 0)
  const label = (key: string) => key.replace("github-copilot#", "").replace("github-copilot", "primary")
  const icon = (type: string) => (type === "reserve" ? "+" : type === "release" ? "-" : "•")
  const tone = (type: string) => (type === "reserve" ? theme().warning : type === "release" ? theme().success : theme().textMuted)
  const rank = (n?: number) => (n === undefined ? "-" : String(n))
  const age = (at: number | null) => {
    if (!at) return "-"
    const ms = Date.now() - at
    if (ms < 1000) return "now"
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    return `${Math.floor(h / 24)}d`
  }
  const migration = createMemo(() => {
    tick()
    return CopilotRuntimeState.migrationSummary()
  })
  const grouped = createMemo(() =>
    usage().map((item) => {
      const meta = CopilotRuntimeState.info[item.key] ?? {}
      const events = rows().filter((row) => row.key === item.key)
      return { ...item, ...meta, events }
    }),
  )
  const tags = (item: {
    selected?: boolean
    selectedReason?: string[]
    rejectedReason?: string[]
    cooldown?: boolean
  }) => {
    const out: { text: string; fg: any }[] = []
    const selected = item.selectedReason ?? []
    const rejected = item.rejectedReason ?? []
    if (item.selected || selected.length > 0) out.push({ text: "selected", fg: theme().success })
    if (selected.some((x) => x.startsWith("discovery:")) || rejected.some((x) => x.toLowerCase().includes("discovery"))) {
      out.push({ text: "disc", fg: theme().info })
    }
    if (selected.some((x) => x.startsWith("lane:")) || rejected.some((x) => x.toLowerCase().includes("lane"))) {
      out.push({ text: "lane", fg: theme().warning })
    }
    if (item.cooldown) out.push({ text: "runtime", fg: theme().warning })
    if (rejected.some((x) => x.toLowerCase().includes("penalty"))) out.push({ text: "penalty", fg: theme().error })
    if (out.length === 0) out.push({ text: "live", fg: theme().textMuted })
    return out.slice(0, 4)
  }
  const summary = createMemo(() => {
    const items = grouped()
    const selected = items.find((item) => item.selected)
    const hot = [...items].sort((a, b) => b.load - a.load || ((b.last ?? 0) - (a.last ?? 0)))[0]
    const reject = feed().reduce(
      (acc, item) => {
        const bad = CopilotRuntimeState.info[item.key]?.rejectedReason ?? []
        if (bad.some((x) => x.includes("lane"))) acc.lane += 1
        if (bad.some((x) => x.toLowerCase().includes("discovery"))) acc.disc += 1
        if (bad.some((x) => x.toLowerCase().includes("penalty"))) acc.penalty += 1
        if (CopilotRuntimeState.info[item.key]?.cooldown) acc.runtime += 1
        return acc
      },
      { lane: 0, disc: 0, penalty: 0, runtime: 0 },
    )
    return {
      selected: selected ? label(selected.key) : "-",
      active: items.filter((item) => item.load > 0).length,
      hot: hot ? label(hot.key) : "-",
      reject,
    }
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => (feed().length > 3 || usage().length > 2) && setOpen((x) => !x)}>
          <Show when={feed().length > 3 || usage().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Copilot</b>
            <span style={{ fg: theme().textMuted }}> ({usage().length} acct{usage().length === 1 ? "" : "s"})</span>
          </text>
        </box>
        <text fg={theme().textMuted}>selected={summary().selected} active={summary().active} hot={summary().hot}</text>
        <text fg={theme().textMuted}>{migration().text}</text>
        <Show when={migration().source}>
          <text fg={theme().textMuted}>source={migration().source}</text>
        </Show>
        <Show when={migration().migratedAt}>
          <text fg={theme().textMuted}>migratedAt={age(migration().migratedAt ?? null)}</text>
        </Show>
        <text fg={theme().textMuted}>
          reject lane={summary().reject.lane} disc={summary().reject.disc} penalty={summary().reject.penalty} runtime={summary().reject.runtime}
        </text>
        <For each={grouped()}>
          {(item) => (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme().text}>
                {label(item.key)}{" "}
                <For each={tags(item)}>{(tag) => <span style={{ fg: tag.fg }}>[{tag.text}]</span>}</For>
              </text>
              <text fg={theme().textMuted}>
                load={item.load} last={age(item.last)} lane={item.lane ?? "-"} disc={rank(item.discovery)} pen={item.penalty ?? 0}
                {item.cooldown ? " cool" : ""}
              </text>
              <Show when={item.events.length > 0 && open()}>
                <For each={item.events}>
                  {(evt) => (
                    <text fg={theme().textMuted}>
                      <span style={{ fg: tone(evt.type) }}>{icon(evt.type)}</span>{" "}
                      {evt.type} {age(evt.at)}
                    </text>
                  )}
                </For>
              </Show>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
