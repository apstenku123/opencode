"""End-to-end tests for the Autosteer stagnation-detection pipeline.

Exercises the ``SessionAutosteerObserver`` post-iteration hook against a real
GitHub Copilot-backed opencode server (``live_copilot_server`` fixture from
``conftest.py``). Every test writes a short, tightly-engineered prompt
designed to coax planning-only or near-duplicate assistant replies, then
asserts on the presence / absence of a synthetic user-turn carrying the
canned nudge text.

Test matrix (mirrors ``src/session/autosteer.ts`` + ``autosteer-observer.ts``):

    1. ``test_autosteering_disabled_no_inject``
       With the runtime override flipped to disabled, two planning-only
       replies must NOT trigger a nudge.

    2. ``test_two_stagnant_replies_trigger_nudge``
       With autosteering enabled (default), two consecutive planning-only
       replies inject a synthetic user turn containing NUDGE_TEXT.

    3. ``test_jaccard_similarity_above_threshold_triggers``
       Two near-identical consecutive replies (Jaccard > 0.85) also trigger
       the nudge, even without planning phrases.

    4. ``test_action_markers_skip_nudge``
       A reply containing a fenced code block / ``Edited `` / ``Created ``
       marker disables the planning-only classification — no nudge fires
       even when the prose looks planning-ish.

    5. ``test_nudge_counter_increments``
       Cumulative-nudge counter reported by ``GET /config/autosteering``
       monotonically increases after the first nudge fires. Cross-checked
       against ``session.autosteer.nudge`` bus events received over SSE.

Skip / opt-out:

    - All tests skip when ``OPENCODE_SKIP_LIVE_TESTS=1`` (CI gate).
    - All tests skip automatically when no Copilot OAuth token is on disk
      (``live_copilot_server`` fixture → ``isolated_copilot_home``).

Token usage: prompts are capped at ~30 input tokens per turn, two turns per
test → ~40 input tokens worst-case. Assistant-side length is clamped by
asking for one-sentence or "repeat verbatim" replies.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Optional

import pytest

from harness import OpencodeClient, OpencodeServer


# ---------------------------------------------------------------------------
# Module-level gates + markers
# ---------------------------------------------------------------------------

pytestmark = [pytest.mark.live, pytest.mark.timeout(600)]


if os.environ.get("OPENCODE_SKIP_LIVE_TESTS") == "1":
    pytest.skip(
        "OPENCODE_SKIP_LIVE_TESTS=1 — skipping autosteer live tests.",
        allow_module_level=True,
    )


# The canned nudge text lives at ``SessionAutosteer.NUDGE_TEXT`` in
# ``src/session/autosteer.ts``. We don't import it (TS → Python would
# require a build step); instead we match on the two load-bearing verbs
# that appear verbatim in that string.
_NUDGE_MARKERS: tuple[str, ...] = ("planning", "execute")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _new_thread(client: OpencodeClient) -> str:
    thread = client.create_thread()
    tid = thread.get("id")
    assert isinstance(tid, str) and tid, f"create_thread returned no id: {thread!r}"
    return tid


def _set_autosteering(client: OpencodeClient, enabled: Optional[bool]) -> dict[str, Any]:
    """POST /config/autosteering — runtime override (no server restart).

    Passing ``None`` clears the override (falls back to opencode.json value,
    default ``true``). Returns the response body ``{enabled, cumulativeNudgeCount}``.
    """
    body: dict[str, Any] = {"enabled": enabled}
    r = client._http.post("/config/autosteering", json=body)
    r.raise_for_status()
    return r.json()


def _get_autosteering(client: OpencodeClient) -> dict[str, Any]:
    r = client._http.get("/config/autosteering")
    r.raise_for_status()
    return r.json()


def _wait_turn_complete(
    client: OpencodeClient,
    thread_id: str,
    *,
    expected_assistant_count: int,
    timeout_s: float = 240.0,
    poll_s: float = 0.5,
) -> list[dict[str, Any]]:
    """Poll until an assistant message at index ``expected_assistant_count - 1``
    has either ``time.completed`` set OR carries an ``error`` payload.

    We can't rely on ``session.time.idle`` alone — opencode doesn't populate
    it when the provider returns an upstream error (the observed behaviour
    with an unsupported Copilot model on /responses). Every turn produces
    exactly one new assistant message, so once ``len(assistants)`` reaches
    ``expected_assistant_count`` and its terminal flag is set, we're done.

    Returns the full message list so the caller doesn't have to re-fetch.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        messages = client.get_messages(thread_id)
        assistants = _assistant_messages(messages)
        if len(assistants) >= expected_assistant_count:
            target = assistants[expected_assistant_count - 1]
            info = target.get("info") or {}
            tinfo = info.get("time") or {}
            if tinfo.get("completed") is not None:
                return messages
            if info.get("error"):
                return messages
        # Fallback: also accept ``session.time.idle`` for completeness.
        session = client.get_session(thread_id)
        if (session.get("time") or {}).get("idle"):
            return messages
        time.sleep(poll_s)
    raise TimeoutError(
        f"turn on thread {thread_id} did not complete in {timeout_s:.0f}s"
    )


def _user_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [m for m in messages if (m.get("info") or {}).get("role") == "user"]


def _assistant_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [m for m in messages if (m.get("info") or {}).get("role") == "assistant"]


def _synthetic_user_text(msg: dict[str, Any]) -> str:
    """Concatenate text of all ``synthetic`` text parts in a user message.

    Returns an empty string when no synthetic text part is present.
    """
    chunks: list[str] = []
    for part in msg.get("parts") or []:
        if part.get("type") != "text":
            continue
        if not part.get("synthetic"):
            continue
        txt = part.get("text")
        if isinstance(txt, str):
            chunks.append(txt)
    return "\n".join(chunks)


def _has_nudge_text(text: str) -> bool:
    """Heuristic: nudge text contains all of ``_NUDGE_MARKERS`` (case-insensitive)."""
    if not text:
        return False
    lower = text.lower()
    return all(marker in lower for marker in _NUDGE_MARKERS)


def _send(
    client: OpencodeClient,
    thread_id: str,
    text: str,
    model: dict[str, str],
    *,
    timeout_s: float = 240.0,
) -> dict[str, Any]:
    """Fire a user turn and return the resulting assistant message.

    Uses ``POST /session/:id/message`` (``send_message``) which resolves
    synchronously once the assistant reply lands — matching the pattern
    already validated by ``test_autobest.py`` against the same fixture.

    Before sending, we count existing assistant messages so ``_wait_turn_complete``
    can target the NEW one (turns are additive — the nth turn produces the
    (n-1)th assistant message).

    ``timeout_s`` bounds BOTH the HTTP POST (the server returns only when
    the full turn completes) AND the ``_wait_turn_complete`` poll. A nudge
    injection causes the server to run additional iterations on top of
    the user-initiated turn — each extra iteration is another LLM call
    (~10-30s on Copilot) so we default to 240s to absorb up to one
    autosteer-triggered nudge + one follow-up iteration.
    """
    prior_messages = client.get_messages(thread_id)
    prior_count = len(_assistant_messages(prior_messages))
    result = client.send_message(
        thread_id,
        text,
        providerID=model["providerID"],
        modelID=model["modelID"],
        timeout=timeout_s,
    )
    _wait_turn_complete(
        client,
        thread_id,
        expected_assistant_count=prior_count + 1,
        timeout_s=timeout_s,
    )
    return result


def _skip_if_model_unsupported(
    client: OpencodeClient,
    thread_id: str,
    model: dict[str, str],
) -> None:
    """Detect upstream "model not supported" replies and skip cleanly.

    The autosteer observer cannot fire without real assistant text to
    evaluate. If the user's Copilot plan doesn't route their advertised
    model (empirically seen: ``gpt-4o`` returns ``APIError: The requested
    model is not supported`` on some enterprise plans) we skip rather
    than produce a vacuous failure.
    """
    messages = client.get_messages(thread_id)
    assistants = _assistant_messages(messages)
    if not assistants:
        return
    for m in assistants:
        err = (m.get("info") or {}).get("error")
        if not isinstance(err, dict):
            continue
        data = err.get("data") or {}
        msg = data.get("message") or err.get("message") or ""
        if isinstance(msg, str) and "model is not supported" in msg.lower():
            pytest.skip(
                f"Copilot plan does not support {model['modelID']!r} via the "
                "current provider endpoint — assistant never produced text, "
                "autosteer heuristics have nothing to evaluate. Configure a "
                "working ``OPENCODE_E2E_MODEL`` to run this suite."
            )
        # Any other 4xx from the upstream provider points at a different
        # issue (auth, quota, plan) — surface a skip that names the error.
        status = data.get("statusCode") or err.get("statusCode")
        if isinstance(status, int) and 400 <= status < 500 and msg:
            pytest.skip(
                f"Copilot upstream returned {status}: {msg!r} — autosteer "
                "cannot evaluate a turn that never produced an assistant reply."
            )


class _NudgeBusListener:
    """Background SSE collector for ``session.autosteer.nudge`` events.

    Opens a short-lived ``/event`` stream and records all nudge events
    observed during the context-manager scope. The collected events are
    available as ``.events`` — each item is the raw SSE properties dict,
    e.g. ``{"sessionID": "...", "count": 3}``.
    """

    def __init__(self, client: OpencodeClient) -> None:
        self._client = client
        self.events: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._err: Optional[BaseException] = None

    def __enter__(self) -> "_NudgeBusListener":
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        # Give the SSE stream a brief head-start before the caller fires
        # any turn — otherwise the very first event can race past us.
        time.sleep(0.3)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    def _run(self) -> None:
        try:
            with self._client.events(timeout_s=None) as stream:
                for ev in stream:
                    if self._stop.is_set():
                        return
                    if ev.type == "session.autosteer.nudge":
                        self.events.append(dict(ev.properties))
        except Exception as err:
            self._err = err


# ---------------------------------------------------------------------------
# Prompts — engineered for specific autosteer heuristic branches
# ---------------------------------------------------------------------------

# Planning-only prompt: explicitly forbids action markers. The nudge text
# fires after TWO consecutive replies hit the heuristic.
#
# The heuristic requires one of ``PLANNING_PHRASES`` AND no fenced code block.
# Turning the assistant into a repeat-planner is less deterministic than a
# verbatim echo, so we use a compound prompt that's cheap to emit (< 50
# tokens of assistant output) and reliably trips the phrase detector.
PLANNING_PROMPT_1 = (
    "Briefly describe how you would write a hello world in python. "
    "Do NOT write code. One sentence starting with \"My plan is\"."
)
PLANNING_PROMPT_2 = (
    "Now describe how you'd reverse a string in python. "
    "Do NOT write code. One sentence starting with \"I'll start by\"."
)

# Verbatim-echo prompt for jaccard similarity. Same content twice guarantees
# near-identical outputs → Jaccard ≈ 1.0 > 0.85 threshold.
ECHO_PROMPT = (
    "Repeat verbatim, nothing else: "
    "\"the quick brown fox jumps over the lazy dog\""
)

# Action-marker prompt — emit a fenced code block so ``ACTION_MARKERS``
# matches even if the prose is planning-ish.
ACTION_PROMPT = (
    "My plan is to show a code fence. "
    "Reply with ONLY a fenced python code block containing `print('ok')`."
)


# ---------------------------------------------------------------------------
# Test 1 — disabled override → no injection
# ---------------------------------------------------------------------------


def test_autosteering_disabled_no_inject(
    live_copilot_server: tuple[OpencodeServer, OpencodeClient],
    live_copilot_model: dict[str, str],
) -> None:
    """With ``autosteering.enabled = false``, two planning-only replies
    must NOT produce a synthetic user turn."""
    _server, client = live_copilot_server

    state = _set_autosteering(client, False)
    assert state.get("enabled") is False, (
        f"failed to flip autosteering off: {state!r}"
    )

    try:
        thread_id = _new_thread(client)
        _send(client, thread_id, PLANNING_PROMPT_1, live_copilot_model)
        _skip_if_model_unsupported(client, thread_id, live_copilot_model)
        _send(client, thread_id, PLANNING_PROMPT_2, live_copilot_model)

        messages = client.get_messages(thread_id)
        user_msgs = _user_messages(messages)
        synthetic = [m for m in user_msgs if _synthetic_user_text(m)]
        assert not synthetic, (
            "autosteering=false still injected a synthetic user turn. "
            f"synthetic texts: {[_synthetic_user_text(m) for m in synthetic]!r}"
        )
    finally:
        # Leave the server with the override cleared so the next test
        # starts from a clean state (default-enabled).
        _set_autosteering(client, None)


# ---------------------------------------------------------------------------
# Test 2 — two planning-only replies → nudge injected
# ---------------------------------------------------------------------------


def test_two_stagnant_replies_trigger_nudge(
    live_copilot_server: tuple[OpencodeServer, OpencodeClient],
    live_copilot_model: dict[str, str],
) -> None:
    """Two consecutive planning-only assistant replies produce one synthetic
    user turn whose text matches ``SessionAutosteer.NUDGE_TEXT``."""
    _server, client = live_copilot_server

    state = _set_autosteering(client, True)
    assert state.get("enabled") is True, f"failed to enable autosteering: {state!r}"

    try:
        thread_id = _new_thread(client)
        with _NudgeBusListener(client) as bus:
            _send(client, thread_id, PLANNING_PROMPT_1, live_copilot_model)
            _skip_if_model_unsupported(client, thread_id, live_copilot_model)
            _send(client, thread_id, PLANNING_PROMPT_2, live_copilot_model)
            # Give the adaptive post-iteration hook a beat to fire + publish.
            time.sleep(1.0)

        messages = client.get_messages(thread_id)
        user_msgs = _user_messages(messages)
        synthetic_texts = [t for t in (_synthetic_user_text(m) for m in user_msgs) if t]

        # Primary assertion: at least one synthetic user turn exists whose
        # text carries the nudge markers ("stop planning", "execute").
        nudged = [t for t in synthetic_texts if _has_nudge_text(t)]
        assert nudged or bus.events, (
            "no autosteer nudge injected across "
            f"{len(messages)} messages.\n"
            f"synthetic texts: {synthetic_texts!r}\n"
            f"bus events: {bus.events!r}"
        )

        # Cross-check: cumulative counter advanced.
        after = _get_autosteering(client)
        assert after.get("cumulativeNudgeCount", 0) >= 1, (
            f"cumulativeNudgeCount did not advance: {after!r}"
        )
    finally:
        _set_autosteering(client, None)


# ---------------------------------------------------------------------------
# Test 3 — Jaccard similarity > threshold → nudge injected
# ---------------------------------------------------------------------------


def test_jaccard_similarity_above_threshold_triggers(
    live_copilot_server: tuple[OpencodeServer, OpencodeClient],
    live_copilot_model: dict[str, str],
) -> None:
    """Two near-identical verbatim replies (Jaccard ≈ 1.0) trigger the nudge."""
    _server, client = live_copilot_server

    _set_autosteering(client, True)
    try:
        thread_id = _new_thread(client)
        with _NudgeBusListener(client) as bus:
            _send(client, thread_id, ECHO_PROMPT, live_copilot_model)
            _skip_if_model_unsupported(client, thread_id, live_copilot_model)
            _send(client, thread_id, ECHO_PROMPT, live_copilot_model)
            time.sleep(1.0)

        messages = client.get_messages(thread_id)
        user_msgs = _user_messages(messages)
        synthetic_texts = [t for t in (_synthetic_user_text(m) for m in user_msgs) if t]
        nudged = [t for t in synthetic_texts if _has_nudge_text(t)]
        assert nudged or bus.events, (
            "similarity path failed to inject a nudge. "
            f"assistant replies: {[_assistant_text(m) for m in _assistant_messages(messages)]!r}\n"
            f"synthetic: {synthetic_texts!r}\nbus: {bus.events!r}"
        )
    finally:
        _set_autosteering(client, None)


def _assistant_text(msg: dict[str, Any]) -> str:
    """Non-synthetic assistant text, joined — diagnostic helper."""
    out: list[str] = []
    for p in msg.get("parts") or []:
        if p.get("type") != "text":
            continue
        if p.get("synthetic"):
            continue
        txt = p.get("text")
        if isinstance(txt, str) and txt.strip():
            out.append(txt)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Test 4 — action markers skip nudge
# ---------------------------------------------------------------------------


def test_action_markers_skip_nudge(
    live_copilot_server: tuple[OpencodeServer, OpencodeClient],
    live_copilot_model: dict[str, str],
) -> None:
    """A reply containing a fenced code block disables planning-only
    classification → no nudge even with a planning phrase in the prose."""
    _server, client = live_copilot_server

    _set_autosteering(client, True)
    try:
        thread_id = _new_thread(client)
        before = _get_autosteering(client).get("cumulativeNudgeCount", 0)

        # Two turns: each asks for a fenced code block, so both replies
        # carry ``\x60\x60\x60`` → autosteer skips injection.
        _send(client, thread_id, ACTION_PROMPT, live_copilot_model)
        _skip_if_model_unsupported(client, thread_id, live_copilot_model)
        _send(client, thread_id, ACTION_PROMPT, live_copilot_model)
        time.sleep(1.0)

        messages = client.get_messages(thread_id)
        assistants = _assistant_messages(messages)
        # Defensive: if the model ignored us and returned no fence, the
        # heuristic falls through to planning-only → the test would be a
        # vacuous pass. Detect that and skip so CI signals correctly.
        has_any_fence = any("```" in _assistant_text(m) for m in assistants)
        if not has_any_fence:
            pytest.skip(
                "model did not emit a fenced code block — action-marker "
                "path cannot be exercised. Retry the suite, or broaden the "
                "prompt when flakiness increases."
            )

        user_msgs = _user_messages(messages)
        synthetic = [t for t in (_synthetic_user_text(m) for m in user_msgs) if t]
        nudged = [t for t in synthetic if _has_nudge_text(t)]
        assert not nudged, (
            f"nudge fired despite action marker. synthetic texts: {synthetic!r}"
        )

        after = _get_autosteering(client).get("cumulativeNudgeCount", 0)
        assert after == before, (
            f"cumulativeNudgeCount advanced {before} → {after} despite action-marker path"
        )
    finally:
        _set_autosteering(client, None)


# ---------------------------------------------------------------------------
# Test 5 — cumulative nudge counter increments across nudges
# ---------------------------------------------------------------------------


def test_nudge_counter_increments(
    live_copilot_server: tuple[OpencodeServer, OpencodeClient],
    live_copilot_model: dict[str, str],
) -> None:
    """After two independent nudges fire, ``cumulativeNudgeCount`` climbs
    by >= 2. Cross-checks via the SSE ``session.autosteer.nudge`` event —
    the bus event's ``count`` field monotonically increases per session.

    ``SessionAutosteerObserver.getCount`` itself is not exposed on the
    HTTP API (Effect-layer only); we use the cumulative-sum endpoint
    (``GET /config/autosteering``) which spans all sessions and is
    server-process-wide.
    """
    _server, client = live_copilot_server

    _set_autosteering(client, True)
    try:
        before = _get_autosteering(client).get("cumulativeNudgeCount", 0)

        all_events: list[dict[str, Any]] = []

        # --- first nudge ---
        thread1 = _new_thread(client)
        with _NudgeBusListener(client) as bus1:
            _send(client, thread1, PLANNING_PROMPT_1, live_copilot_model)
            _skip_if_model_unsupported(client, thread1, live_copilot_model)
            _send(client, thread1, PLANNING_PROMPT_2, live_copilot_model)
            time.sleep(1.0)
        all_events.extend(bus1.events)

        # --- second nudge (fresh thread → fresh counter streak) ---
        thread2 = _new_thread(client)
        with _NudgeBusListener(client) as bus2:
            _send(client, thread2, ECHO_PROMPT, live_copilot_model)
            _skip_if_model_unsupported(client, thread2, live_copilot_model)
            _send(client, thread2, ECHO_PROMPT, live_copilot_model)
            time.sleep(1.0)
        all_events.extend(bus2.events)

        after = _get_autosteering(client).get("cumulativeNudgeCount", 0)
        delta = after - before

        # Accept either the HTTP counter delta or the SSE bus events —
        # whichever surface caught the nudge. The counters should agree
        # unless an SSE race dropped one; we tolerate that slack.
        assert delta >= 2 or len(all_events) >= 2, (
            "expected at least 2 nudges across two sessions.\n"
            f"cumulative before={before}, after={after}, delta={delta}\n"
            f"bus events: {all_events!r}"
        )

        # Per-session ``count`` is monotonic within each session_id stream.
        per_session: dict[str, list[int]] = {}
        for ev in all_events:
            sid = str(ev.get("sessionID"))
            cnt = int(ev.get("count") or 0)
            per_session.setdefault(sid, []).append(cnt)
        for sid, counts in per_session.items():
            assert counts == sorted(counts), (
                f"session {sid}: nudge counts not monotonic: {counts}"
            )
    finally:
        _set_autosteering(client, None)
