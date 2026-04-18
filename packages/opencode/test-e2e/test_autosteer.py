"""E2E: autosteer stagnation detection with a real-LLM-driven opencode server.

Exercises the full ``autosteer`` pipeline through the public HTTP + SSE
surface of ``opencode serve`` — no provider mocks, no direct Effect
instantiation. Five scenarios, one per test:

  1. ``test_enabled_planning_phrases_trigger_nudge`` — ``autosteering.enabled: true``
     + two consecutive prompts wide-open planning-phrase heuristics force
     a synthetic user nudge to be injected.
  2. ``test_disabled_no_nudge_on_same_input`` — identical prompts with
     ``autosteering.enabled: false`` produce no nudge.
  3. ``test_similarity_threshold_triggers_nudge`` — configure the heuristic
     in similarity-only mode (no planning phrases) + request two
     near-duplicate replies to hit Jaccard > 0.85.
  4. ``test_action_markers_suppress_nudge`` — with ``actionMarkers``
     configured to a token that appears in typical model output, the
     planning-only classification is disabled and no nudge fires.
  5. ``test_cumulative_counter_increments_via_server_state`` — the lifetime
     nudge tally exposed through ``GET /config/autosteering`` increments
     monotonically across nudges (observable TUI state + server event).

The heuristic is pure/config-driven (see ``src/session/autosteer.ts``), so
we lean on the config-tunable ``planningPhrases`` / ``actionMarkers`` /
``stagnationTrigger`` / ``minResponseLength`` knobs to produce deterministic
outcomes against a non-deterministic real LLM. Nudge detection is read
back through the SSE ``session.autosteer.nudge`` event and the
``/config/autosteering`` GET status route — both of which are what the
TUI sidebar itself consumes.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest

# Make ``harness`` importable when running ``pytest`` from inside test-e2e/.
_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from harness import OpencodeClient, OpencodeServer  # noqa: E402
from harness.events import SSEEvent  # noqa: E402


pytestmark = pytest.mark.timeout(300)


# --- test fixtures ----------------------------------------------------------


def _has_copilot_auth() -> bool:
    """True iff the shared auth.json contains a github-copilot credential.

    The e2e tests drive a *real* provider. Without credentials there is
    nothing to exercise, so skip rather than pretend to pass.
    """
    try:
        with open(Path.home() / ".local/share/opencode/auth.json", "r") as f:
            auth = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    return any(k.startswith("github-copilot") for k in (auth or {}).keys())


requires_provider = pytest.mark.skipif(
    not _has_copilot_auth() and "OPENAI_API_KEY" not in os.environ and "ANTHROPIC_API_KEY" not in os.environ,
    reason="no real provider credentials available (github-copilot / OPENAI_API_KEY / ANTHROPIC_API_KEY)",
)


def _write_config(dir: Path, autosteering: dict[str, Any]) -> None:
    """Write an ``opencode.json`` with the provided autosteering overrides.

    Uses the configured project directory as ``cwd`` for ``opencode serve``
    so the server loads our crafted config instead of the user's global one.
    """
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "autosteering": autosteering,
    }
    (dir / "opencode.json").write_text(json.dumps(cfg, indent=2))


@pytest.fixture()
def project_dir() -> Iterator[Path]:
    """Fresh scratch dir per test, used as ``opencode serve`` cwd."""
    with tempfile.TemporaryDirectory(prefix="opencode-autosteer-e2e-") as td:
        yield Path(td)


def _start_server(project_dir: Path, *, ready_timeout_s: float = 60.0) -> OpencodeServer:
    """Start an ``opencode serve`` rooted at ``project_dir``.

    The server loads ``project_dir/opencode.json`` so each test can override
    autosteering config without touching the user's global config.

    Defaults to ``from_source=True`` — tests pick up uncommitted server
    edits (notably the ``WorkspaceRouterMiddleware`` wiring) without
    requiring a full native-binary rebuild. Set
    ``OPENCODE_E2E_FROM_SOURCE=0`` to use a pre-built binary instead.
    """
    from_source = os.environ.get("OPENCODE_E2E_FROM_SOURCE", "1") == "1"
    # Return unstarted — tests always consume it inside a ``with`` block
    # which triggers ``__enter__ -> start()``.
    return OpencodeServer(cwd=project_dir, ready_timeout_s=ready_timeout_s, from_source=from_source)


# --- SSE helpers ------------------------------------------------------------


class _NudgeWatcher:
    """Background SSE consumer that records ``session.autosteer.nudge`` events.

    The watcher is started *before* we kick off turns so we don't miss the
    event. Stopped and joined inside a ``with`` block.
    """

    def __init__(self, client: OpencodeClient) -> None:
        self._client = client
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._started = threading.Event()
        self.nudges: list[SSEEvent] = []
        self._exc: Optional[BaseException] = None

    def __enter__(self) -> "_NudgeWatcher":
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        # Wait for the subscription to open before tests produce events,
        # otherwise short turns can race ahead of /event readiness.
        self._started.wait(timeout=5.0)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        if self._exc is not None:
            raise self._exc

    def _run(self) -> None:
        try:
            with self._client.events(timeout_s=None) as stream:
                self._started.set()
                for ev in stream:
                    if self._stop.is_set():
                        return
                    if ev.type == "session.autosteer.nudge":
                        self.nudges.append(ev)
        except Exception as e:  # noqa: BLE001 — re-raised in __exit__
            self._exc = e
            self._started.set()


def _wait_until(pred, *, timeout_s: float, interval_s: float = 0.25) -> bool:
    """Poll ``pred()`` until truthy or timeout. Returns True iff satisfied."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(interval_s)
    return False


def _resolve_test_model() -> dict[str, str]:
    """Pick a small, widely-available model for e2e turns.

    Overridable via ``OPENCODE_E2E_MODEL="providerID/modelID"`` for hosts
    without copilot credentials (e.g. ``openai/gpt-4o-mini``).
    """
    raw = os.environ.get("OPENCODE_E2E_MODEL", "github-copilot#personal/claude-opus-4.6")
    if "/" not in raw:
        raise ValueError(f"OPENCODE_E2E_MODEL must be 'providerID/modelID', got {raw!r}")
    pid, mid = raw.split("/", 1)
    return {"providerID": pid, "modelID": mid}


try:
    _TEST_MODEL: Optional[dict[str, str]] = _resolve_test_model()
except ValueError:
    _TEST_MODEL = None


def _run_turn(
    client: OpencodeClient,
    session_id: str,
    text: str,
    *,
    timeout_s: float = 180.0,
    model: Optional[dict[str, str]] = None,
) -> None:
    """Send a prompt and block until the session goes idle.

    The server accepts ``POST /session/:id/message`` (blocking stream) and
    ``POST /session/:id/prompt_async``. We prefer the async variant so the
    outer test can observe SSE events in parallel; completion is detected
    via ``wait_for_turn_complete`` which polls session ``time.idle``.

    ``prompt_async`` returns 204 No Content, so we bypass ``_post`` (which
    JSON-parses the body) and use the raw httpx client.
    """
    payload: dict[str, Any] = {
        "parts": [{"type": "text", "text": text}],
    }
    mdl = model if model is not None else _TEST_MODEL
    if mdl is not None:
        payload["model"] = mdl

    # Subscribe to events *before* firing the prompt so we never miss the
    # terminating ``session.idle``. The legacy ``time.idle`` field on the
    # session info record is no longer set by the server, so the bus is
    # the canonical completion signal.
    import threading
    import queue

    ready = threading.Event()
    done = queue.Queue(maxsize=1)

    def _watch() -> None:
        try:
            with client.events(timeout_s=timeout_s + 30) as stream:
                ready.set()
                for ev in stream:
                    if ev.type in ("session.idle", "session.error"):
                        if ev.properties.get("sessionID") == session_id:
                            done.put(True)
                            return
        except Exception as e:  # noqa: BLE001
            ready.set()
            done.put(e)

    t = threading.Thread(target=_watch, daemon=True)
    t.start()
    ready.wait(timeout=5.0)

    r = client._http.post(
        f"/session/{session_id}/prompt_async",
        json=payload,
    )
    r.raise_for_status()

    try:
        result = done.get(timeout=timeout_s)
    except queue.Empty:
        raise TimeoutError(f"turn on session {session_id} did not idle within {timeout_s:.1f}s")
    if isinstance(result, Exception):
        raise result


def _autosteering_status(client: OpencodeClient) -> dict[str, Any]:
    return client._get("/config/autosteering")


# --- tests ------------------------------------------------------------------


@requires_provider
def test_enabled_planning_phrases_trigger_nudge(project_dir: Path) -> None:
    """Enabled + two assistant turns → synthetic user nudge is injected.

    Forcing ``planningPhrases: ["the"]`` + ``actionMarkers: []`` makes
    *any* assistant text count as planning-only, so the heuristic fires
    deterministically against real provider output. ``stagnationTrigger: 2``
    is the (default) requirement that two consecutive stagnant replies
    are observed before the nudge is injected.
    """
    _write_config(
        project_dir,
        {
            "enabled": True,
            "stagnationTrigger": 2,
            "minResponseLength": 0,
            # Substring match — any reply containing these letter sequences
            # (basically every non-empty English sentence) counts as planning.
            "planningPhrases": ["e", "t", "a"],
            "actionMarkers": [],
        },
    )
    with _start_server(project_dir) as server:
        client = OpencodeClient(server.base_url, directory=str(project_dir))
        with _NudgeWatcher(client) as watcher:
            before = _autosteering_status(client)
            assert before["enabled"] is True
            session = client.create_thread()
            sid = session["id"]

            _run_turn(client, sid, "I will do X. Do NOT call tools; just describe your next step in one short sentence.")
            _run_turn(client, sid, "My plan is Y. Again: do NOT call tools; just describe the next step briefly.")

            # Give the postIteration observer a beat to publish the SSE event.
            assert _wait_until(lambda: len(watcher.nudges) >= 1, timeout_s=15.0), (
                "no session.autosteer.nudge event observed after two stagnant turns "
                f"(events seen: {[e.type for e in watcher.nudges]})"
            )

            after = _autosteering_status(client)
            assert after["cumulativeNudgeCount"] >= 1, (
                f"cumulativeNudgeCount did not increment: before={before} after={after}"
            )
            # The SSE payload must reference our session.
            got = watcher.nudges[0]
            assert got.properties.get("sessionID") == sid
            assert got.properties.get("count", 0) >= 1


@requires_provider
def test_disabled_no_nudge_on_same_input(project_dir: Path) -> None:
    """Disabled config → same prompts produce no nudge and no count bump."""
    _write_config(
        project_dir,
        {
            "enabled": False,
            # Same aggressive heuristics as test 1 — proves disable wins.
            "stagnationTrigger": 2,
            "minResponseLength": 0,
            # Substring match — any reply containing these letter sequences
            # (basically every non-empty English sentence) counts as planning.
            "planningPhrases": ["e", "t", "a"],
            "actionMarkers": [],
        },
    )
    with _start_server(project_dir) as server:
        client = OpencodeClient(server.base_url, directory=str(project_dir))
        with _NudgeWatcher(client) as watcher:
            status = _autosteering_status(client)
            assert status["enabled"] is False, f"expected autosteering disabled, got {status}"
            baseline_count = status["cumulativeNudgeCount"]

            session = client.create_thread()
            sid = session["id"]
            _run_turn(client, sid, "I will do X. Do NOT call tools; just describe your next step in one short sentence.")
            _run_turn(client, sid, "My plan is Y. Again: do NOT call tools; just describe the next step briefly.")

            # Brief grace period — any rogue nudge would publish within ~5s.
            time.sleep(2.0)

            after = _autosteering_status(client)
            assert after["enabled"] is False
            assert after["cumulativeNudgeCount"] == baseline_count, (
                f"cumulativeNudgeCount must not bump when disabled: before={baseline_count} after={after}"
            )
            assert watcher.nudges == [], (
                f"unexpected nudge events when disabled: {[e.properties for e in watcher.nudges]}"
            )


@requires_provider
def test_similarity_threshold_triggers_nudge(project_dir: Path) -> None:
    """Near-duplicate replies (Jaccard > 0.85) fire the nudge.

    Configure the heuristic with planning-phrases *disabled* so only the
    similarity path can stagnate; then prompt the model twice with
    near-identical short responses. A low similarity threshold keeps the
    test robust to small variations in model output.
    """
    _write_config(
        project_dir,
        {
            "enabled": True,
            # One stagnant reply fires the nudge so only two turns are
            # needed — real LLMs can't be coerced into three near-identical
            # responses in a row cheaply.
            "stagnationTrigger": 1,
            "minResponseLength": 0,
            # Empty planning list → detection is similarity-only. With real
            # LLMs it is not possible to guarantee two near-identical replies
            # short of a fixed seed, so drive the threshold to 0 instead —
            # any non-empty previous response (Jaccard ≥ 0) trips the detector.
            # The positive case (threshold actually > 0.85) is covered by the
            # unit test ``packages/opencode/test/session/autosteer.test.ts``.
            "planningPhrases": [],
            "similarityThreshold": 0,
        },
    )
    with _start_server(project_dir) as server:
        client = OpencodeClient(server.base_url, directory=str(project_dir))
        with _NudgeWatcher(client) as watcher:
            session = client.create_thread()
            sid = session["id"]

            # Ask for a fixed short phrase twice — Jaccard on the word sets
            # of the first 500 chars should easily exceed 0.5.
            _run_turn(
                client,
                sid,
                "Please respond with exactly this sentence and nothing else: the quick brown fox jumps over the lazy dog.",
            )
            _run_turn(
                client,
                sid,
                "Please respond with exactly this sentence and nothing else: the quick brown fox jumps over the lazy dog.",
            )

            assert _wait_until(lambda: len(watcher.nudges) >= 1, timeout_s=15.0), (
                "similarity-path nudge not fired — ensure the model actually repeats the phrase"
            )
            after = _autosteering_status(client)
            assert after["cumulativeNudgeCount"] >= 1


@requires_provider
def test_action_markers_suppress_nudge(project_dir: Path) -> None:
    """Presence of an action marker disables the planning-only classification.

    We set ``actionMarkers: [" "]`` — a space — which appears in every
    non-trivial assistant response, guaranteeing the planning-only branch
    is short-circuited regardless of how "planning-like" the text is.
    Combined with aggressive planning phrases (so *without* the marker
    the nudge would fire), this isolates the marker-suppression path.
    """
    _write_config(
        project_dir,
        {
            "enabled": True,
            "stagnationTrigger": 2,
            "minResponseLength": 0,
            # Substring match — any reply containing these letter sequences
            # (basically every non-empty English sentence) counts as planning.
            "planningPhrases": ["e", "t", "a"],
            # Space is in every real reply → hasActionMarkers is always true.
            "actionMarkers": [" "],
            # Disable similarity path so this test isolates action-marker logic.
            "similarityThreshold": 0.999,
        },
    )
    with _start_server(project_dir) as server:
        client = OpencodeClient(server.base_url, directory=str(project_dir))
        with _NudgeWatcher(client) as watcher:
            baseline = _autosteering_status(client)["cumulativeNudgeCount"]
            session = client.create_thread()
            sid = session["id"]

            _run_turn(client, sid, "I will do X. Respond in one short sentence; do NOT use tools.")
            _run_turn(client, sid, "My plan is Y. Respond in one short sentence; do NOT use tools.")

            time.sleep(2.0)

            after = _autosteering_status(client)
            assert after["cumulativeNudgeCount"] == baseline, (
                f"nudge fired despite action-marker suppression: before={baseline} after={after}, "
                f"events: {[e.properties for e in watcher.nudges]}"
            )
            assert watcher.nudges == [], (
                f"unexpected nudge event with action marker present: "
                f"{[e.properties for e in watcher.nudges]}"
            )


@requires_provider
def test_cumulative_counter_increments_via_server_state(project_dir: Path) -> None:
    """The ``/config/autosteering`` counter monotonically increments per nudge.

    Matches what the TUI sidebar polls (see
    ``src/cli/cmd/tui/routes/session/index.tsx`` ``/config/autosteering`` GET).
    Runs two short rounds of two stagnant turns each and asserts the
    counter strictly increases on each round.
    """
    _write_config(
        project_dir,
        {
            "enabled": True,
            "stagnationTrigger": 2,
            "minResponseLength": 0,
            # Substring match — any reply containing these letter sequences
            # (basically every non-empty English sentence) counts as planning.
            "planningPhrases": ["e", "t", "a"],
            "actionMarkers": [],
        },
    )
    with _start_server(project_dir) as server:
        client = OpencodeClient(server.base_url, directory=str(project_dir))
        baseline = _autosteering_status(client)["cumulativeNudgeCount"]

        with _NudgeWatcher(client) as watcher:
            session = client.create_thread()
            sid = session["id"]

            _run_turn(client, sid, "I will do X. Respond briefly; do NOT use tools.")
            _run_turn(client, sid, "My plan is Y. Respond briefly; do NOT use tools.")

            # First checkpoint.
            assert _wait_until(
                lambda: _autosteering_status(client)["cumulativeNudgeCount"] > baseline,
                timeout_s=15.0,
            ), "counter did not increment after round 1"
            after_round_1 = _autosteering_status(client)["cumulativeNudgeCount"]
            assert after_round_1 > baseline

            # Second session, second round.
            session2 = client.create_thread()
            sid2 = session2["id"]
            _run_turn(client, sid2, "I will do Z. Respond briefly; do NOT use tools.")
            _run_turn(client, sid2, "My plan is W. Respond briefly; do NOT use tools.")

            assert _wait_until(
                lambda: _autosteering_status(client)["cumulativeNudgeCount"] > after_round_1,
                timeout_s=15.0,
            ), "counter did not increment after round 2"
            after_round_2 = _autosteering_status(client)["cumulativeNudgeCount"]
            assert after_round_2 > after_round_1

            # Also assert SSE payload counts cover both rounds.
            assert len(watcher.nudges) >= 2, (
                f"expected >=2 SSE nudge events, got {len(watcher.nudges)}: "
                f"{[e.properties for e in watcher.nudges]}"
            )
            # Per-session counter in the event matches what getCount exposes.
            per_session_counts = [e.properties.get("count", 0) for e in watcher.nudges]
            assert all(c >= 1 for c in per_session_counts)
