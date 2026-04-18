import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import type { QuestionForwardedToParent } from "@opencode-ai/sdk/v2"
import { useKeybind } from "../../context/keybind"
import { selectedForeground, useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useDialog } from "../../ui/dialog"

type Stage = "choose" | "feedback"

/**
 * Inline prompt for a forwarded child-session question.
 *
 * Invoked from {@link Session} whenever the guardian publishes
 * `Question.Event.ForwardedToParent`. The parent user can:
 *
 *   - Approve (`y`)  — reply with the first option's label (the
 *     conventional "yes/allow" choice), matching the auto-approve
 *     heuristic in the guardian.
 *   - Deny (`n`)     — reject the request so the child's `Question.ask`
 *     deferred resolves with `QuestionRejectedError`.
 *   - Deny with feedback (`r`) — enter a textarea, send the typed
 *     string back as a single-label answer on the first question.
 *
 * Keyboard shortcuts mirror the permission prompt (y/n/r style) so
 * muscle memory carries between the two flows.
 */
export function QuestionForwardedPrompt(props: { entry: QuestionForwardedToParent }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const bindings = useTextareaKeybindings()
  const dialog = useDialog()

  const [stage, setStage] = createSignal<Stage>("choose")
  const [active, setActive] = createSignal<"approve" | "deny" | "feedback">("approve")

  const question = createMemo(() => props.entry.request.questions[0])
  const approveLabel = createMemo(() => question()?.options?.[0]?.label)

  let textarea: TextareaRenderable | undefined

  function approve() {
    const label = approveLabel()
    if (!label) {
      // No options to auto-approve with — fall back to reject.
      void sdk.client.question.reject({ requestID: props.entry.requestID })
      return
    }
    void sdk.client.question.reply({
      requestID: props.entry.requestID,
      answers: [[label]],
    })
  }

  function deny() {
    void sdk.client.question.reject({ requestID: props.entry.requestID })
  }

  function sendFeedback() {
    const text = textarea?.plainText?.trim() ?? ""
    if (!text) {
      // Empty feedback — just reject.
      void sdk.client.question.reject({ requestID: props.entry.requestID })
      return
    }
    void sdk.client.question.reply({
      requestID: props.entry.requestID,
      answers: [[text]],
    })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (stage() === "feedback") {
      if (evt.name === "escape") {
        evt.preventDefault()
        setStage("choose")
        return
      }
      if (evt.name === "return" && !evt.shift) {
        evt.preventDefault()
        sendFeedback()
        return
      }
      // textarea handles other keys
      return
    }

    if (evt.name === "y" || evt.name === "Y") {
      evt.preventDefault()
      approve()
      return
    }
    if (evt.name === "n" || evt.name === "N") {
      evt.preventDefault()
      deny()
      return
    }
    if (evt.name === "r" || evt.name === "R") {
      evt.preventDefault()
      setStage("feedback")
      return
    }

    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      setActive(active() === "approve" ? "feedback" : active() === "deny" ? "approve" : "deny")
    }
    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      setActive(active() === "approve" ? "deny" : active() === "deny" ? "feedback" : "approve")
    }

    if (evt.name === "return") {
      evt.preventDefault()
      const choice = active()
      if (choice === "approve") return approve()
      if (choice === "deny") return deny()
      setStage("feedback")
      return
    }

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      deny()
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text attributes={1} fg={theme.warning}>
            Sub-agent request
          </text>
          <text fg={theme.textMuted}>from {props.entry.childID}</text>
        </box>

        <box paddingLeft={1} gap={1}>
          <Show when={question()?.header}>
            <text fg={theme.text}>
              <span style={{ fg: theme.textMuted }}>pattern: </span>
              {question()?.header}
            </text>
          </Show>
          <Show when={question()?.question}>
            <text fg={theme.text}>{question()?.question}</text>
          </Show>
          <Show when={(question()?.options?.length ?? 0) > 0}>
            <box>
              <text fg={theme.textMuted}>options:</text>
              <For each={question()?.options ?? []}>
                {(opt) => (
                  <box paddingLeft={2}>
                    <text fg={theme.text}>
                      <span style={{ fg: theme.success }}>• </span>
                      {opt.label}
                      <Show when={opt.description}>
                        <span style={{ fg: theme.textMuted }}> — {opt.description}</span>
                      </Show>
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </box>

        <Show when={stage() === "feedback"}>
          <box paddingLeft={1} gap={1}>
            <text fg={theme.textMuted}>Reason / feedback (enter to send, esc to cancel):</text>
            <textarea
              ref={(val: TextareaRenderable) => {
                textarea = val
                val.traits = { status: "FEEDBACK" }
                queueMicrotask(() => {
                  val.focus()
                  val.gotoLineEnd()
                })
              }}
              placeholder="Deny reason..."
              placeholderColor={theme.textMuted}
              minHeight={1}
              maxHeight={4}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.primary}
              keyBindings={bindings()}
            />
          </box>
        </Show>

        <Show when={stage() === "choose"}>
          <box flexDirection="row" gap={2} paddingLeft={1}>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active() === "approve" ? theme.success : theme.backgroundElement}
              onMouseUp={() => approve()}
            >
              <text fg={active() === "approve" ? selectedForeground(theme, theme.success) : theme.text}>
                Approve (y)
              </text>
            </box>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active() === "deny" ? theme.error : theme.backgroundElement}
              onMouseUp={() => deny()}
            >
              <text fg={active() === "deny" ? selectedForeground(theme, theme.error) : theme.text}>Deny (n)</text>
            </box>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active() === "feedback" ? theme.accent : theme.backgroundElement}
              onMouseUp={() => setStage("feedback")}
            >
              <text fg={active() === "feedback" ? selectedForeground(theme, theme.accent) : theme.text}>
                Deny w/ feedback (r)
              </text>
            </box>
          </box>
        </Show>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={2}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2}>
          <Show when={stage() === "choose"}>
            <text fg={theme.text}>
              y <span style={{ fg: theme.textMuted }}>approve</span>
            </text>
            <text fg={theme.text}>
              n <span style={{ fg: theme.textMuted }}>deny</span>
            </text>
            <text fg={theme.text}>
              r <span style={{ fg: theme.textMuted }}>deny + feedback</span>
            </text>
            <text fg={theme.text}>
              esc <span style={{ fg: theme.textMuted }}>dismiss</span>
            </text>
          </Show>
          <Show when={stage() === "feedback"}>
            <text fg={theme.text}>
              enter <span style={{ fg: theme.textMuted }}>send</span>
            </text>
            <text fg={theme.text}>
              esc <span style={{ fg: theme.textMuted }}>back</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}
