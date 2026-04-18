import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { useEvent } from "@tui/context/event"
import { InstallationVersion } from "@/installation/version"
import { TuiPluginRuntime } from "../../plugin"

import { getScrollAcceleration } from "../../util/scroll"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const event = useEvent()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  // Per-session cumulative autosteer-nudge counter — opencode's analog of
  // the Rust right_panel.rs:804-807 `autosteering_count` per-agent display.
  // Increments off the bus event published by `SessionAutosteerObserver`.
  const [autosteerCount, setAutosteerCount] = createSignal(0)
  onMount(() => {
    const off = event.subscribe(
      (evt: { type: string; properties?: Record<string, unknown> }) => {
        if (evt.type !== "session.autosteer.nudge") return
        if (evt.properties?.sessionID !== props.sessionID) return
        const count = typeof evt.properties?.count === "number" ? evt.properties.count : autosteerCount() + 1
        setAutosteerCount(count)
      },
    )
    onCleanup(off)
  })

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <Show when={autosteerCount() > 0}>
          <box flexShrink={0} paddingTop={1}>
            <text fg={theme.textMuted}>
              ⚠ Autosteer: <span style={{ fg: theme.text }}>{autosteerCount()}</span>
            </text>
          </box>
        </Show>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
