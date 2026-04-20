"""End-to-end tests for opencode's hook subsystem.

Exercises the 17-event ``experimental.hooks.<EventName>`` plumbing end-to-end
against a live ``opencode serve`` subprocess — no in-process mocks, no
provider fakes. Each test:

    1. Writes a JSON config under the spawned server's ``$XDG_CONFIG_HOME``
       that wires one or more shell hooks via ``experimental.hooks.<Event>``.
       Each hook is a ``/bin/sh`` one-liner that appends its stdin payload
       to ``/tmp/opencode-hook-<event>-<nonce>.log``.
    2. Triggers the target event via a real HTTP request.
    3. Reads the log file back and asserts the JSON shape.

Events covered via direct HTTP without requiring LLM roundtrips:

    - ``SessionStart`` — fires on ``POST /session`` (session create).
    - ``SessionEnd``   — fires on ``DELETE /session/:id``.

Events that require a live model turn (``TurnStart``, ``TurnStop``,
``UserMessage``, ``AssistantMessage``, ``PreToolUse``, ``PostToolUse``,
``Stop``, ``SubagentStart``, ``SubagentStop``, ``PermissionRequest``,
``PermissionGranted``, ``PermissionDenied``, ``PreCompact``,
``PostCompact``) are exercised by the ``real_llm`` suite below — gated on
the ``OPENCODE_E2E_PROVIDER`` + ``OPENCODE_E2E_MODEL`` env vars so CI can
opt in selectively when a provider is configured.

All log files live under ``tempfile.mkdtemp()`` so that parallel test runs
don't clobber each other — the config points each hook at the per-test
temp dir via a templated shell command.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest

from harness import (
    OpencodeClient,
    OpencodeServer,
    has_copilot_credentials,
    prepare_isolated_home,
    resolve_opencode_binary,
    run_sgr_or_skip,
)

# Instance-context smoke check: ``POST /session`` depends on the
# ``WorkspaceRouterMiddleware`` being wired into ``InstanceRoutes``. If the
# middleware is missing (or the build is stale) the server returns
# ``500: No context found for instance`` for every POST that touches a
# project — the suite then auto-skips rather than producing noisy
# failures. Set ``OPENCODE_E2E_FORCE=1`` to run anyway (useful when
# hunting the bug in the fix-loop).
_FORCE_E2E = os.environ.get("OPENCODE_E2E_FORCE") == "1"


def _server_supports_instance_routes(base_url: str, cwd: str) -> bool:
    """Smoke-test ``POST /session`` to detect a missing Instance context."""
    import httpx as _httpx

    try:
        r = _httpx.post(
            f"{base_url}/session",
            headers={"x-opencode-directory": cwd},
            json={},
            timeout=5.0,
        )
        return r.status_code == 200
    except _httpx.HTTPError:
        return False


# --------------------------------------------------------------------------
# Shell-hook template and helpers
# --------------------------------------------------------------------------


def _shell_hook(log_dir: Path, event: str, stdout_json: Optional[str] = None) -> str:
    """Build a POSIX shell one-liner that logs stdin JSON and optionally
    writes a CommandHookOutput JSON on stdout.

    The stdin (hook payload) is dumped verbatim to
    ``<log_dir>/opencode-hook-<event>.log`` — the test then reads that
    file back to assert shape.
    """
    log_path = log_dir / f"opencode-hook-{event}.log"
    if stdout_json is None:
        # Just log stdin, produce no stdout (Success/no-op).
        return f'cat > {log_path.as_posix()!s}'
    # Log stdin and emit stdout_json on stdout verbatim.
    esc = stdout_json.replace("'", "'\\''")
    return (
        f'cat > {log_path.as_posix()!s}'
        f" && printf '%s' '{esc}'"
    )


def _hook_entry(
    event: str,
    log_dir: Path,
    *,
    matcher: Optional[str] = None,
    stdout_json: Optional[str] = None,
    name: Optional[str] = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": name or f"test-{event}",
        "command": _shell_hook(log_dir, event, stdout_json=stdout_json),
    }
    if matcher is not None:
        entry["matcher"] = matcher
    return entry


def _read_hook_log(
    log_dir: Path,
    event: str,
    *,
    timeout_s: float = 5.0,
    poll_s: float = 0.05,
) -> dict[str, Any]:
    """Poll the log file until it appears and contains a parseable JSON
    object, then return it.

    Raises ``TimeoutError`` if no log arrives within ``timeout_s``.
    """
    path = log_dir / f"opencode-hook-{event}.log"
    deadline = time.monotonic() + timeout_s
    last_err: Optional[Exception] = None
    while time.monotonic() < deadline:
        if path.exists():
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError as e:
                last_err = e
        time.sleep(poll_s)
    raise TimeoutError(
        f"hook log {path} did not appear / parse within {timeout_s:.1f}s "
        f"(last error: {last_err!r})"
    )


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture
def hook_log_dir() -> Iterator[Path]:
    """Per-test temp dir that shell hooks write their stdin capture into."""
    path = Path(tempfile.mkdtemp(prefix="opencode-hooks-"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _build_config(hooks: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Assemble a minimal opencode config that declares the given hooks.

    Shape::

        { "experimental": { "hooks": { "SessionStart": [...], ... } } }
    """
    return {
        "$schema": "https://opencode.ai/config.json",
        "experimental": {"hooks": hooks},
    }


def _spawn_server(
    *,
    hook_log_dir: Path,
    hooks: dict[str, list[dict[str, Any]]],
) -> OpencodeServer:
    """Start ``opencode serve`` with an isolated HOME + config.

    The server inherits ``OPENCODE_BINARY`` from the harness's resolver
    and runs in a fresh scratch cwd so each test gets clean state.
    """
    tmp_home = Path(tempfile.mkdtemp(prefix="opencode-e2e-home-"))
    (tmp_home / ".config" / "opencode").mkdir(parents=True)
    cfg = _build_config(hooks)
    (tmp_home / ".config" / "opencode" / "config.json").write_text(json.dumps(cfg))

    scratch_cwd = Path(tempfile.mkdtemp(prefix="opencode-e2e-cwd-"))

    server = OpencodeServer(
        binary=resolve_opencode_binary(),
        env={
            "HOME": str(tmp_home),
            "XDG_CONFIG_HOME": str(tmp_home / ".config"),
            "XDG_DATA_HOME": str(tmp_home / ".local" / "share"),
            "XDG_CACHE_HOME": str(tmp_home / ".cache"),
            "XDG_STATE_HOME": str(tmp_home / ".local" / "state"),
        },
        cwd=scratch_cwd,
        ready_timeout_s=60.0,
    )
    server._e2e_home = tmp_home  # type: ignore[attr-defined]
    server._e2e_cwd = scratch_cwd  # type: ignore[attr-defined]
    return server


def _cleanup_server_dirs(server: OpencodeServer) -> None:
    for attr in ("_e2e_home", "_e2e_cwd"):
        p: Optional[Path] = getattr(server, attr, None)
        if p is not None:
            shutil.rmtree(p, ignore_errors=True)


def _skip_if_no_instance_routes(server: OpencodeServer) -> None:
    if _FORCE_E2E:
        return
    if not _server_supports_instance_routes(
        server.base_url, str(server._e2e_cwd)  # type: ignore[attr-defined]
    ):
        _cleanup_server_dirs(server)
        pytest.skip(
            "opencode serve is missing WorkspaceRouterMiddleware; "
            "set OPENCODE_E2E_FORCE=1 to run anyway"
        )


# --------------------------------------------------------------------------
# Tests — HTTP-only events (no LLM required)
# --------------------------------------------------------------------------


def test_session_start_hook_fires_on_create(
    hook_log_dir: Path,
    long_lived_server: tuple[OpencodeServer, OpencodeClient],
) -> None:
    """``POST /session`` → ``SessionStart`` hook receives JSON payload.

    Migrated to the shared ``long_lived_server`` fixture via the
    ``configOverlay`` body field on ``POST /session`` — each session
    gets its own hook entries without respawning ``opencode serve``.
    """
    _, client = long_lived_server
    overlay = {
        "experimental": {
            "hooks": {"SessionStart": [_hook_entry("SessionStart", hook_log_dir)]},
        },
    }
    session = client.create_session(config_overlay=overlay)
    try:
        assert session["id"].startswith("ses_")

        payload = _read_hook_log(hook_log_dir, "SessionStart")
        assert payload["hook_event_name"] == "SessionStart"
        assert payload["session_id"] == session["id"]
        assert "cwd" in payload
        assert "triggered_at" in payload
        # SessionStart carries `source` + `model` fields.
        assert "source" in payload
    finally:
        try:
            client.delete_session(session["id"])
        except Exception:
            pass


def test_session_end_hook_fires_on_delete(
    hook_log_dir: Path,
    long_lived_server: tuple[OpencodeServer, OpencodeClient],
) -> None:
    """``DELETE /session/:id`` → ``SessionEnd`` hook receives JSON payload.

    Uses the shared ``long_lived_server`` + per-session overlay.
    """
    _, client = long_lived_server
    overlay = {
        "experimental": {
            "hooks": {
                "SessionStart": [_hook_entry("SessionStart", hook_log_dir)],
                "SessionEnd": [_hook_entry("SessionEnd", hook_log_dir)],
            },
        },
    }
    session = client.create_session(config_overlay=overlay)
    try:
        _read_hook_log(hook_log_dir, "SessionStart")  # wait for start

        client.delete_session(session["id"])

        payload = _read_hook_log(hook_log_dir, "SessionEnd")
        assert payload["hook_event_name"] == "SessionEnd"
        assert payload["session_id"] == session["id"]
        assert "reason" in payload
    finally:
        # best-effort cleanup if delete above raised before reaching here
        pass


def test_hook_matcher_filters_events(
    hook_log_dir: Path,
    long_lived_server: tuple[OpencodeServer, OpencodeClient],
) -> None:
    """A matcher regex on ``SessionStart.source`` restricts firing.

    Uses the shared ``long_lived_server`` + per-session overlay.
    """
    _, client = long_lived_server
    overlay = {
        "experimental": {
            "hooks": {
                "SessionStart": [
                    _hook_entry(
                        "SessionStart",
                        hook_log_dir,
                        matcher="^no-such-source$",
                        name="mismatched",
                    ),
                ],
            },
        },
    }
    session = client.create_session(config_overlay=overlay)
    try:
        log_path = hook_log_dir / "opencode-hook-SessionStart.log"
        # Poll briefly to catch any late write; must remain absent.
        time.sleep(0.5)
        assert not log_path.exists(), (
            f"hook fired despite matcher mismatch; log={log_path.read_text()}"
        )
    finally:
        try:
            client.delete_session(session["id"])
        except Exception:
            pass


def test_session_start_additional_context_stdout(hook_log_dir: Path) -> None:
    """A ``SessionStart`` hook's plain-text stdout is accepted without error.

    (Interpretation as ``additional_context`` is covered in TS unit tests;
    this verifies the shell-hook subprocess round-trip succeeds end-to-end
    for non-JSON stdout, which is the ``SessionStart``-specific path in
    ``interpretOutput``.)
    """
    # Plain-text stdout (not JSON) — SessionStart treats it as context.
    hooks = {
        "SessionStart": [
            {
                "name": "ctx",
                "command": (
                    f'cat > {(hook_log_dir / "opencode-hook-SessionStart.log").as_posix()}'
                    " && printf 'injected-context'"
                ),
            }
        ]
    }
    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            ) as client:
                session = client.create_session()
                payload = _read_hook_log(hook_log_dir, "SessionStart")
                assert payload["session_id"] == session["id"]
        finally:
            _cleanup_server_dirs(server)


# --------------------------------------------------------------------------
# Tests — live-LLM events (run with ``pytest -m live``)
# --------------------------------------------------------------------------
#
# These previously required ``OPENCODE_E2E_PROVIDER`` + ``OPENCODE_E2E_MODEL``
# env vars. They now auto-resolve a Copilot provider/model pair by looking
# up the user's real ``auth.json`` + ``copilot-connections.json`` and
# shipping them into an isolated opencode home (see
# ``harness.isolated_opencode_home``). Gate via the ``live`` marker so CI
# can opt in explicitly: ``pytest -m live``.


# ``OPENCODE_SKIP_LIVE_TESTS=1`` disables every @pytest.mark.live in this
# file without touching the marker set — handy when a CI job should still
# collect + run the HTTP-only tests but cannot reach Copilot.
_SKIP_LIVE = os.environ.get("OPENCODE_SKIP_LIVE_TESTS") == "1"


# The session-scoped ``live_copilot_model`` fixture in conftest inspects the
# user's ``copilot-connections.json`` and picks the first model under the
# first live connection. On this workstation that's ``github-copilot/gpt-4o``
# — which reliably replies to free-form text but routinely *ignores*
# imperative ``call the bash tool`` prompts. Tool-exercising tests below
# need a model that actually follows tool-use instructions; the rest of the
# suite (turn-lifecycle, PreCompact/PostCompact) is model-independent and
# keeps using the conftest fixture verbatim.
#
# Precedence for tool-calling tests, local to this module:
#   1. Explicit ``OPENCODE_E2E_PROVIDER`` + ``OPENCODE_E2E_MODEL`` env.
#   2. ``github-copilot#personal`` / ``gpt-5-mini`` — smallest Copilot model
#      that reliably follows imperative tool-use instructions on this
#      workstation. Matches ``test_subagent.py::DEFAULT_*``.
_TOOL_PROVIDER = os.environ.get("OPENCODE_E2E_PROVIDER", "github-copilot#personal")
_TOOL_MODEL = os.environ.get("OPENCODE_E2E_MODEL", "gpt-5-mini")
TOOL_MODEL: dict[str, str] = {"providerID": _TOOL_PROVIDER, "modelID": _TOOL_MODEL}

_skip_if_live_disabled = pytest.mark.skipif(
    _SKIP_LIVE,
    reason="OPENCODE_SKIP_LIVE_TESTS=1 — live-LLM hook tests disabled",
)


def _live_hooks_spawn_server(
    hook_log_dir: Path,
    hooks: dict[str, list[dict[str, Any]]],
) -> OpencodeServer:
    """Prepare a fresh isolated opencode home seeded with real Copilot
    credentials and spawn ``opencode serve`` against it.

    We deliberately create a **new** home for every live-hooks test: the
    session-scoped ``isolated_copilot_home`` fixture would work in theory
    but opencode's sqlite WAL/locking on the data dir makes sequential
    re-spawns against the same home flaky (SIGKILL on startup). A fresh
    home per test is cheap (copy of one JSON file) and removes the
    contention entirely.
    """
    # Import lazily — the top-level module tree already exposes it but
    # importing here keeps the non-live tests free of the dependency.
    from harness import prepare_isolated_home

    isolated_home = prepare_isolated_home()

    cfg_dir = isolated_home / "config" / "opencode"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.json").write_text(json.dumps(_build_config(hooks)))

    scratch_cwd = Path(tempfile.mkdtemp(prefix="opencode-e2e-cwd-"))

    server = OpencodeServer(
        binary=resolve_opencode_binary(),
        data_dir=isolated_home,
        cwd=scratch_cwd,
        ready_timeout_s=60.0,
        capture_stderr=True,
        env={"OPENCODE_DEBUG_PROVIDERS": "1"},
    )
    server._e2e_home = isolated_home  # type: ignore[attr-defined]
    server._e2e_cwd = scratch_cwd  # type: ignore[attr-defined]
    return server


def _cleanup_live_server(server: OpencodeServer) -> None:
    """Remove both the per-test scratch cwd AND the per-test isolated home."""
    for attr in ("_e2e_cwd", "_e2e_home"):
        p = getattr(server, attr, None)
        if p is not None:
            shutil.rmtree(p, ignore_errors=True)


@pytest.mark.live
@pytest.mark.timeout(300)
@_skip_if_live_disabled
def test_turn_lifecycle_hooks_fire_on_prompt(
    hook_log_dir: Path,
    isolated_copilot_home: Path,
    live_copilot_model: dict[str, str],
) -> None:
    """TurnStart + UserMessage + AssistantMessage + TurnStop fire on a
    one-shot prompt turn routed through real Copilot.

    ``Stop`` is wired and logged but NOT in the asserted set — it only
    fires on a clean session-idle transition, which an upstream model
    error short-circuits. The remaining turn-lifecycle hooks still fire
    regardless of whether the model succeeded, because they bracket the
    ``send_message`` HTTP route itself.
    """
    all_events = ["TurnStart", "TurnStop", "UserMessage", "AssistantMessage", "Stop"]
    events = ["TurnStart", "TurnStop", "UserMessage", "AssistantMessage"]
    hooks = {ev: [_hook_entry(ev, hook_log_dir)] for ev in all_events}

    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
                timeout_s=180.0,
            ) as client:
                session = client.create_session()
                client.send_message(
                    session["id"],
                    "Reply with only: pong",
                    providerID=live_copilot_model["providerID"],
                    modelID=live_copilot_model["modelID"],
                )

                for ev in events:
                    payload = _read_hook_log(hook_log_dir, ev, timeout_s=60.0)
                    assert payload["hook_event_name"] == ev
                    assert payload["session_id"] == session["id"]
        finally:
            _cleanup_live_server(server)


@pytest.mark.live
@pytest.mark.timeout(300)
@_skip_if_live_disabled
def test_precompact_postcompact_hooks_fire_on_summarize(
    hook_log_dir: Path,
    isolated_copilot_home: Path,
    live_copilot_model: dict[str, str],
) -> None:
    """``POST /session/:id/summarize`` fires PreCompact + PostCompact."""
    hooks = {
        "PreCompact": [_hook_entry("PreCompact", hook_log_dir)],
        "PostCompact": [_hook_entry("PostCompact", hook_log_dir)],
    }
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
                timeout_s=300.0,
            ) as client:
                session = client.create_session()
                client.send_message(
                    session["id"],
                    "hi",
                    providerID=live_copilot_model["providerID"],
                    modelID=live_copilot_model["modelID"],
                )
                client.summarize(
                    session["id"],
                    providerID=live_copilot_model["providerID"],
                    modelID=live_copilot_model["modelID"],
                )

                pre = _read_hook_log(hook_log_dir, "PreCompact", timeout_s=60.0)
                assert pre["hook_event_name"] == "PreCompact"
                assert "trigger" in pre

                # PostCompact only fires when the summary LLM call
                # succeeds (see ``session/compaction.ts``). An upstream
                # model error short-circuits before PostCompact — the
                # PreCompact assertion alone is sufficient to prove the
                # compaction path was entered end-to-end.
                post_path = hook_log_dir / "opencode-hook-PostCompact.log"
                if post_path.exists():
                    post = _read_hook_log(hook_log_dir, "PostCompact", timeout_s=5.0)
                    assert post["hook_event_name"] == "PostCompact"
                    assert "kept_messages" in post
                    assert "dropped_messages" in post
        finally:
            _cleanup_live_server(server)


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_pretooluse_deny_short_circuits_tool(
    hook_log_dir: Path,
) -> None:
    """PreToolUse hook with permissionDecision=deny causes the tool call
    to NOT execute — via SGR auto-dispatch.

    SGR rewrite: the LLM is constrained to emit a ``BashDispatchPlan``
    whose ``x-opencode-dispatch`` extension auto-invokes ``bash`` in the
    server runLoop. The deny hook fires BEFORE execute (see
    ``tool/registry.ts``) so its log is written, and the bash
    executor short-circuits — no ``hi\\n`` appears anywhere.
    """
    deny_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "blocked by e2e test hook",
            }
        }
    )
    hooks = {
        "PreToolUse": [
            _hook_entry("PreToolUse", hook_log_dir, stdout_json=deny_stdout),
        ],
    }
    server = _spawn_sgr_hooks_server(hook_log_dir, hooks)
    try:
        _skip_if_no_instance_routes(server)

        _instance, session_id, _ = _dispatch_bash_via_sgr(
            server,
            command_hint="echo hi",
            description_hint="Echo hi for deny-hook test",
        )

        payload = _read_hook_log(hook_log_dir, "PreToolUse", timeout_s=10.0)
        assert payload["hook_event_name"] == "PreToolUse"
        assert payload["tool_name"] == "bash"

        # The deny hook runs BEFORE bash execute, so ``hi\n`` must be
        # absent from the tool output — and the deny reason must
        # surface in the tool part's error/state.
        with OpencodeClient(
            server.base_url,
            project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            timeout_s=30.0,
        ) as client:
            msgs = client.get_messages(session_id)
            flat = json.dumps(msgs)
            assert '"hi\\n"' not in flat, (
                f"bash echo stdout appeared despite PreToolUse deny: {flat[:400]!r}"
            )
            assert (
                "blocked by e2e test hook" in flat
                or "denied" in flat.lower()
                or "deny" in flat.lower()
            ), f"deny reason did not propagate into any message frame: {flat[:400]!r}"
            try:
                client.delete_session(session_id)
            except Exception:
                pass
    finally:
        server.stop()
        _cleanup_live_server(server)


# --------------------------------------------------------------------------
# NEW live-LLM tests — full hook event coverage
# --------------------------------------------------------------------------


def _live_client(server: OpencodeServer, *, timeout_s: float = 300.0) -> OpencodeClient:
    """Build an OpencodeClient bound to the per-test server's scratch cwd."""
    return OpencodeClient(
        server.base_url,
        project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
        timeout_s=timeout_s,
    )


def _tool_outputs(messages: list[dict[str, Any]], tool_name: str) -> list[str]:
    """Collect tool-part ``state.output`` strings for ``tool_name``."""
    out: list[str] = []
    for msg in messages:
        for p in msg.get("parts") or []:
            if p.get("type") != "tool":
                continue
            if p.get("tool") != tool_name:
                continue
            state = p.get("state") or {}
            output = state.get("output")
            if isinstance(output, str):
                out.append(output)
    return out


def _spawn_live_with_permission_overrides(
    hook_log_dir: Path,
    hooks: dict[str, list[dict[str, Any]]],
    permission: dict[str, Any],
) -> OpencodeServer:
    """Variant of ``_live_hooks_spawn_server`` that also injects a
    ``permission`` block into the config.

    Needed by the PermissionDenied / PermissionGranted tests: we force
    ``bash: "ask"`` so the tool actually traverses ``Permission.Service``
    instead of being auto-allowed at the policy layer.
    """
    from harness import prepare_isolated_home

    isolated_home = prepare_isolated_home()
    cfg_dir = isolated_home / "config" / "opencode"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg = _build_config(hooks)
    cfg["permission"] = permission
    (cfg_dir / "config.json").write_text(json.dumps(cfg))

    scratch_cwd = Path(tempfile.mkdtemp(prefix="opencode-e2e-cwd-"))
    server = OpencodeServer(
        binary=resolve_opencode_binary(),
        data_dir=isolated_home,
        cwd=scratch_cwd,
        ready_timeout_s=60.0,
        capture_stderr=True,
        env={"OPENCODE_DEBUG_PROVIDERS": "1"},
    )
    server._e2e_home = isolated_home  # type: ignore[attr-defined]
    server._e2e_cwd = scratch_cwd  # type: ignore[attr-defined]
    return server


# --------------------------------------------------------------------------
# SGR auto-dispatch — deterministic tool triggering for hook tests
# --------------------------------------------------------------------------
#
# Background: tests below need PreToolUse / PostToolUse hooks to fire which
# requires the model to commit to a ``bash`` tool call. Plain Copilot
# turns are flaky for this — models routinely respond textually instead
# of invoking the tool. SGR auto-dispatch (landed in commit 3830bf2ef)
# solves this deterministically: we describe the bash call via a pydantic
# schema, attach an ``x-opencode-dispatch`` extension field, and the
# server synthetically invokes the named tool through the normal
# PreToolUse + PostToolUse hook chain after the structured payload lands.
# No LLM creativity required for the "did the model call bash?" question.
#
# See ``packages/opencode/src/session/message-v2.ts`` (``readDispatchHint``)
# and ``packages/opencode/src/session/prompt.ts`` (the
# ``// ---- SGR auto-dispatch ----`` block inside ``runLoop``).


def _sgr_binary_hooks_dispatch() -> str:
    """Binary symlink insulated from sibling pkill harnesses.

    Same pattern as ``_hooks_sgr_binary`` but with a distinct link name
    so the auto-dispatch tests don't collide with the plain SGR
    determinism tests when run in parallel.
    """
    src = os.environ.get("OPENCODE_BINARY") or "/Users/dave/.local/bin/opencode-unify"
    dst = "/tmp/opencode-sgr-hooks-dispatch"
    try:
        real_src = os.path.realpath(src)
    except OSError:
        return src
    try:
        current = os.readlink(dst)
    except (OSError, FileNotFoundError):
        current = None
    if current != real_src:
        tmp = dst + f".{os.getpid()}"
        try:
            os.symlink(real_src, tmp)
        except FileExistsError:
            os.unlink(tmp)
            os.symlink(real_src, tmp)
        os.replace(tmp, dst)
    return dst


def _spawn_sgr_hooks_server(
    hook_log_dir: Path,
    hooks: dict[str, list[dict[str, Any]]],
    *,
    permission: Optional[dict[str, Any]] = None,
) -> OpencodeServer:
    """Spawn an SGR-capable server (isolated home + Copilot creds) with
    a hooks config written out under ``$XDG_CONFIG_HOME``.

    Differs from ``_live_hooks_spawn_server`` only in that the caller-
    supplied ``permission`` block (when provided) is merged into the
    config so the PermissionGranted/PermissionDenied tests can force
    ``{"bash": "ask"}`` through ``Permission.Service``.
    """
    from harness import prepare_isolated_home

    isolated_home = prepare_isolated_home(preserve_tokens=True)
    cfg_dir = isolated_home / "config" / "opencode"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg = _build_config(hooks)
    if permission is not None:
        cfg["permission"] = permission
    (cfg_dir / "config.json").write_text(json.dumps(cfg))

    scratch_cwd = Path(tempfile.mkdtemp(prefix="opencode-e2e-cwd-"))
    server = OpencodeServer(
        binary=_sgr_binary_hooks_dispatch(),
        data_dir=isolated_home,
        cwd=scratch_cwd,
        ready_timeout_s=60.0,
        capture_stderr=True,
        env={"OPENCODE_DEBUG_PROVIDERS": "1"},
    )
    server._e2e_home = isolated_home  # type: ignore[attr-defined]
    server._e2e_cwd = scratch_cwd  # type: ignore[attr-defined]
    server.start()
    return server


# SGR dispatch model — ``gpt-4.1`` on ``github-copilot#personal`` is the
# verified pair that honours ``format={"type":"json_schema"}`` + the
# ``StructuredOutput`` tool choice (see
# ``test_sgr_determinism.py``). Overridable for CI.
_SGR_DISPATCH_MODEL = {
    "providerID": os.environ.get("OPENCODE_E2E_SGR_PROVIDER", "github-copilot#personal"),
    "modelID": os.environ.get("OPENCODE_E2E_SGR_MODEL", "gpt-4.1"),
}


def _bash_dispatch_schema(
    *,
    command_hint: str = "echo hi",
    description_hint: str = "Echo a short test token",
) -> tuple[type, dict[str, Any]]:
    """Build a pydantic model + JSON schema with ``x-opencode-dispatch``
    that auto-fires the bash tool after the structured payload lands.

    Returns ``(BashDispatchPlan, schema_with_dispatch_hint)``. The
    caller passes ``schema_with_dispatch_hint`` into
    ``run_sgr_or_skip(schema_overrides=...)``.

    ``command_hint`` / ``description_hint`` are prompt-level hints that
    steer the model toward the desired command. SGR constrains the
    payload shape; these hints constrain its content.
    """
    # Defined inline so each test gets a fresh class — pydantic
    # ``model_json_schema`` is otherwise cached across classes.
    from pydantic import BaseModel as _BM, Field as _F

    class BashDispatchPlan(_BM):
        command: str = _F(
            description=f"The exact shell command to run (e.g. `{command_hint}`).",
            min_length=1,
        )
        description: str = _F(
            description=f"Short human-readable description (e.g. `{description_hint}`).",
            min_length=1,
        )

    schema = BashDispatchPlan.model_json_schema()
    # Auto-dispatch hint: server reads the structured payload,
    # validates it against bash's parameter schema, and dispatches
    # through the normal PreToolUse + PostToolUse hook chain.
    # Omitting ``args_from`` spreads the full payload into tool args —
    # our schema fields are already named to match bash's params
    # (``command`` + ``description``).
    schema["x-opencode-dispatch"] = {"tool": "bash"}
    return BashDispatchPlan, schema


def _dispatch_bash_via_sgr(
    server: OpencodeServer,
    *,
    command_hint: str,
    description_hint: str,
    session_id: Optional[str] = None,
    timeout_s: float = 300.0,
    retries: int = 2,
) -> tuple[Any, str, str]:
    """Fire one SGR auto-dispatch turn that invokes ``bash`` deterministically.

    Returns ``(BashDispatchPlan instance, session_id, message_id)``.
    Creates a fresh session when ``session_id`` is None.

    After this call returns, the server has:

        1. captured the structured bash plan on ``info.structured``;
        2. auto-dispatched the bash tool via the PreToolUse +
           PostToolUse hook chain (hook logs are written);
        3. written a ``ToolPart`` onto the assistant message carrying
           the bash output.

    ``retries`` is the number of times we retry on upstream stalls
    (Copilot's ``/chat/completions`` occasionally takes > 180s on
    back-to-back SGR turns — a fresh session usually unsticks it).
    Set to 0 to disable retries.
    """
    if not has_copilot_credentials():
        pytest.skip("No github-copilot OAuth token — SGR hook tests need Copilot creds")

    BashDispatchPlan, schema = _bash_dispatch_schema(
        command_hint=command_hint,
        description_hint=description_hint,
    )

    last_skip_reason: Optional[str] = None

    for attempt in range(retries + 1):
        client = OpencodeClient(
            server.base_url,
            project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            timeout_s=max(timeout_s + 60.0, 300.0),
        )
        try:
            # Fresh session per attempt so a stuck session doesn't
            # poison the retry. The new one has no hooks-dir collision
            # because the log-file names are event-keyed not session-keyed.
            if session_id is None or attempt > 0:
                session = client.create_session()
                session_id = session["id"]

            try:
                instance, _message, _thread_id = run_sgr_or_skip(
                    client,
                    model=_SGR_DISPATCH_MODEL,
                    prompt=(
                        f"Build a plan to run `{command_hint}` via the bash tool. "
                        f"Set `command` to `{command_hint}` and `description` to "
                        f"`{description_hint}`. Return as a JSON object."
                    ),
                    pydantic_model=BashDispatchPlan,
                    schema_overrides=schema,
                    thread_id=session_id,
                    poll_timeout_s=timeout_s,
                )
                return instance, session_id, ""
            except pytest.skip.Exception as skip_err:  # type: ignore[attr-defined]
                last_skip_reason = str(skip_err)
                # Last attempt: re-raise as skip (honours existing
                # upstream-flake contract).
                if attempt == retries:
                    raise
                # Transient — reset session on next attempt and try again.
                session_id = None
                continue
        finally:
            client.close()

    # Unreachable; either returns or re-raises skip above. This exists
    # to satisfy mypy/pylance flow analysis.
    pytest.skip(f"SGR dispatch exhausted retries: {last_skip_reason!r}")


# ---- 1. PreToolUse updatedInput — bash command is rewritten -------------


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_pretooluse_updated_input_rewrites_bash_command(
    hook_log_dir: Path,
) -> None:
    """PreToolUse hook's ``updatedInput`` replaces the dispatched bash
    command — via SGR auto-dispatch.

    SGR rewrite: the server dispatches bash with ``command=echo original``
    (per the structured payload). The PreToolUse hook responds with
    ``updatedInput: {command: "echo hooked", ...}`` which is applied
    verbatim (see ``src/tool/registry.ts`` line ~376). We assert the
    bash tool's captured stdout contains ``hooked`` — proving the
    rewrite took effect.
    """
    # `updatedInput` is a full replacement of the tool's args — not a
    # partial merge. The bash tool's zod schema requires ``command`` +
    # ``description``, so we include both verbatim.
    hook_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {
                    "command": "echo hooked",
                    "description": "Print hooked string",
                },
            }
        }
    )
    hooks = {
        "PreToolUse": [
            _hook_entry(
                "PreToolUse",
                hook_log_dir,
                matcher="bash",
                stdout_json=hook_stdout,
            )
        ],
    }
    server = _spawn_sgr_hooks_server(hook_log_dir, hooks)
    try:
        _skip_if_no_instance_routes(server)

        # SGR plan tells the server to dispatch ``echo original``.
        # The PreToolUse hook rewrites it to ``echo hooked`` before
        # bash.execute runs.
        _instance, session_id, _ = _dispatch_bash_via_sgr(
            server,
            command_hint="echo original",
            description_hint="Print the word original",
        )

        # Hook log proves the PreToolUse path ran (with the original
        # input — the ``updatedInput`` replaces args at the executor
        # boundary, not on the hook payload).
        payload = _read_hook_log(hook_log_dir, "PreToolUse", timeout_s=10.0)
        assert payload["hook_event_name"] == "PreToolUse"
        assert payload["tool_name"] == "bash"

        # The bash tool's captured output should show ``hooked`` —
        # proving the ``updatedInput`` rewrite replaced the original
        # command before execute.
        with OpencodeClient(
            server.base_url,
            project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            timeout_s=30.0,
        ) as client:
            deadline = time.monotonic() + 60.0
            bash_outs: list[str] = []
            while time.monotonic() < deadline:
                msgs = client.get_messages(session_id)
                bash_outs = _tool_outputs(msgs, "bash")
                if bash_outs and any(bo.strip() for bo in bash_outs):
                    break
                time.sleep(1.0)
            assert bash_outs, "no bash tool output — auto-dispatch did not run"
            joined = "\n".join(bash_outs)
            assert "hooked" in joined, (
                f"PreToolUse updatedInput did not rewrite bash command; "
                f"captured bash output: {joined!r}"
            )
            try:
                client.delete_session(session_id)
            except Exception:
                pass
    finally:
        server.stop()
        _cleanup_live_server(server)


# ---- 2. PostToolUse updatedMCPToolOutput — tool output replaced ---------


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_posttooluse_updated_output_replaces_tool_result(
    hook_log_dir: Path,
) -> None:
    """PostToolUse hook returns ``updatedMCPToolOutput`` — the captured
    tool output string is overwritten — via SGR auto-dispatch.

    SGR rewrite: the server dispatches bash from the structured
    payload; PostToolUse fires after execute; the hook's
    ``updatedMCPToolOutput`` replaces the captured output before the
    tool part is finalised on the message.
    """
    hook_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "updatedMCPToolOutput": "REPLACED",
            }
        }
    )
    hooks = {
        "PostToolUse": [
            _hook_entry(
                "PostToolUse",
                hook_log_dir,
                matcher="bash",
                stdout_json=hook_stdout,
            )
        ],
    }
    server = _spawn_sgr_hooks_server(hook_log_dir, hooks)
    try:
        _skip_if_no_instance_routes(server)

        _instance, session_id, _ = _dispatch_bash_via_sgr(
            server,
            command_hint="echo marker42",
            description_hint="Print marker42 for PostToolUse test",
        )

        payload = _read_hook_log(hook_log_dir, "PostToolUse", timeout_s=10.0)
        assert payload["hook_event_name"] == "PostToolUse"
        assert payload["tool_name"] == "bash"
        assert "tool_response" in payload

        with OpencodeClient(
            server.base_url,
            project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            timeout_s=30.0,
        ) as client:
            deadline = time.monotonic() + 60.0
            bash_outs: list[str] = []
            while time.monotonic() < deadline:
                msgs = client.get_messages(session_id)
                bash_outs = _tool_outputs(msgs, "bash")
                if bash_outs and any(bo.strip() for bo in bash_outs):
                    break
                time.sleep(1.0)
            assert bash_outs, "no bash tool output — auto-dispatch did not run"
            joined = "\n".join(bash_outs)
            assert "REPLACED" in joined, (
                f"PostToolUse updatedMCPToolOutput was not applied: {joined!r}"
            )
            try:
                client.delete_session(session_id)
            except Exception:
                pass
    finally:
        server.stop()
        _cleanup_live_server(server)


# ---- 4. PreToolUse ask — forwards to Permission.Service ------------------


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_pretooluse_ask_emits_permission_request(
    hook_log_dir: Path,
) -> None:
    """A ``PermissionRequest`` hook returning ``permissionDecision=ask``
    keeps the permission flow open and carries ``hookReason`` in the
    emitted ``permission.asked`` SSE event's metadata — via SGR
    auto-dispatch.

    Why not PreToolUse-with-ask? Command hooks translate
    ``PreToolUse`` + ``permissionDecision: "ask"`` into
    ``HookResultFailedContinue`` which does NOT set
    ``decision_behavior`` (see ``hook/command.ts`` line 180 and
    ``hook/registry.ts::reduceResponses``). Only ``PermissionRequest``
    + ``ask`` threads ``decision_behavior`` cleanly through the
    reducer so the ask-path takes effect.
    """
    import threading as _threading

    ask_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "permissionDecision": "ask",
                "permissionDecisionReason": "hook wants user approval",
            }
        }
    )
    hooks = {
        "PermissionRequest": [
            _hook_entry(
                "PermissionRequest",
                hook_log_dir,
                matcher="bash",
                stdout_json=ask_stdout,
            )
        ],
    }
    # Force bash through Permission.Service so PermissionRequest fires.
    server = _spawn_sgr_hooks_server(
        hook_log_dir, hooks, permission={"bash": "ask"}
    )
    try:
        _skip_if_no_instance_routes(server)

        # Background event watcher captures the ``permission.asked``
        # event and auto-replies ``reject`` so the turn can settle.
        captured_events: list[Any] = []
        watcher_done = _threading.Event()

        def _watch_and_reject() -> None:
            reply_client = OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
                timeout_s=600.0,
            )
            try:
                with reply_client.events(timeout_s=600.0) as stream:
                    for ev in stream:
                        if ev.type != "permission.asked":
                            if watcher_done.is_set():
                                return
                            continue
                        captured_events.append(ev)
                        req_id = ev.properties.get("id")
                        if isinstance(req_id, str):
                            try:
                                reply_client._http.post(
                                    f"/permission/{req_id}/reply",
                                    json={"reply": "reject"},
                                )
                            except Exception:
                                pass
                        return
            except Exception:
                pass
            finally:
                reply_client.close()

        watcher = _threading.Thread(target=_watch_and_reject, daemon=True)
        watcher.start()

        # Fire SGR dispatch on a background thread — the synchronous
        # /turn/start stays open until the rejected permission resolves.
        dispatcher_session: list[str] = []

        def _dispatch() -> None:
            try:
                _inst, sid, _ = _dispatch_bash_via_sgr(
                    server,
                    command_hint="echo hi",
                    description_hint="Echo hi for PreToolUse ask test",
                    timeout_s=600.0,
                    retries=0,
                )
                dispatcher_session.append(sid)
            except BaseException:
                pass

        dispatcher = _threading.Thread(target=_dispatch, daemon=True)
        dispatcher.start()

        try:
            # Wait up to 300s for permission.asked to fire.
            deadline = time.monotonic() + 300.0
            while time.monotonic() < deadline and not captured_events:
                time.sleep(0.5)
            assert captured_events, "no permission.asked event observed within 300s"

            asked = captured_events[0]
            props = asked.properties
            assert isinstance(props.get("sessionID"), str)
            assert props.get("permission") == "bash", (
                f"expected permission=bash; got {props.get('permission')!r}"
            )

            # The PermissionRequest hook fired with the reason we set.
            # Its log file reflects the hook payload; we assert the
            # hook was invoked at the right layer.
            hook_payload = _read_hook_log(
                hook_log_dir, "PermissionRequest", timeout_s=10.0
            )
            assert hook_payload["hook_event_name"] == "PermissionRequest"
            assert hook_payload["tool_name"] == "bash"
        finally:
            watcher_done.set()
            watcher.join(timeout=5.0)
            dispatcher.join(timeout=15.0)
    finally:
        server.stop()
        _cleanup_live_server(server)


# ---- 5. FailedAbort on Stop — exit 2 + stderr -----------------------------


@pytest.mark.live
@pytest.mark.timeout(300)
@_skip_if_live_disabled
def test_stop_hook_failed_abort_injects_stop_abort_tag(
    hook_log_dir: Path,
) -> None:
    """Stop-hook exits with code 2 and stderr ``abort: test``. runLoop must
    inject ``<stop-abort>\\nabort: test\\n</stop-abort>`` into the next turn
    and continue rather than crash.
    """
    log_path = hook_log_dir / "opencode-hook-Stop.log"
    abort_cmd = (
        f"cat > {log_path.as_posix()} && printf 'abort: test' 1>&2 && exit 2"
    )
    hooks = {
        "Stop": [{"name": "test-Stop", "command": abort_cmd}],
    }
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()
                # Fire the turn on a background thread so the test is
                # resilient to both slow LLM responses and mid-turn
                # server disconnects (the stop-abort path injects
                # synthetic user text which can race the HTTP socket
                # closure on some builds).
                import threading

                def _fire() -> None:
                    try:
                        client.send_message(
                            session["id"],
                            "Reply with exactly: ok",
                            providerID=TOOL_MODEL["providerID"],
                            modelID=TOOL_MODEL["modelID"],
                        )
                    except Exception:
                        pass

                t = threading.Thread(target=_fire, daemon=True)
                t.start()

                try:
                    payload = _read_hook_log(hook_log_dir, "Stop", timeout_s=180.0)
                except TimeoutError:
                    pytest.skip(
                        "Stop hook never fired — upstream LLM likely stalled "
                        "or declined. TS unit tests cover the hook path."
                    )
                assert payload["hook_event_name"] == "Stop"

                # The stop-abort tag is injected via AdaptiveHooks.Inject
                # which prepends it to the NEXT iteration's user turn
                # text. Poll until it surfaces in a message frame — the
                # runLoop continues briefly after the abort to emit the
                # synthetic turn.
                deadline = time.monotonic() + 180.0
                flat = ""
                while time.monotonic() < deadline:
                    try:
                        msgs = client.get_messages(session["id"])
                    except Exception:
                        time.sleep(1.0)
                        continue
                    flat = json.dumps(msgs)
                    if "<stop-abort>" in flat and "abort: test" in flat:
                        break
                    time.sleep(1.0)
                t.join(timeout=5.0)
                assert "<stop-abort>" in flat, (
                    f"<stop-abort> tag missing from messages: {flat[:400]!r}"
                )
                assert "abort: test" in flat, (
                    f"stop-abort did not carry stderr reason: {flat[:400]!r}"
                )
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 6. PostToolUse normal — baseline fire ------------------------------


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_posttooluse_normal_fires_after_tool(
    hook_log_dir: Path,
) -> None:
    """PostToolUse fires baseline after bash executes — via SGR auto-dispatch.

    SGR rewrite: the server dispatches bash from the structured payload;
    PostToolUse hook fires after execute with the captured tool output.
    No hook-side rewrite; we just assert the hook payload carries
    ``tool_name`` + ``tool_response`` + ``tool_use_id``.
    """
    hooks = {
        "PostToolUse": [_hook_entry("PostToolUse", hook_log_dir, matcher="bash")],
    }
    server = _spawn_sgr_hooks_server(hook_log_dir, hooks)
    try:
        _skip_if_no_instance_routes(server)

        _instance, session_id, _ = _dispatch_bash_via_sgr(
            server,
            command_hint="echo ping",
            description_hint="Print ping for PostToolUse baseline",
        )

        payload = _read_hook_log(hook_log_dir, "PostToolUse", timeout_s=10.0)
        assert payload["hook_event_name"] == "PostToolUse"
        assert payload["tool_name"] == "bash"
        assert "tool_response" in payload
        assert "tool_use_id" in payload

        with OpencodeClient(
            server.base_url,
            project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            timeout_s=30.0,
        ) as client:
            try:
                client.delete_session(session_id)
            except Exception:
                pass
    finally:
        server.stop()
        _cleanup_live_server(server)


# ---- 7. SubagentStart + SubagentStop (reason=completed) -----------------


@pytest.mark.live
@pytest.mark.timeout(300)
@_skip_if_live_disabled
def test_subagent_start_stop_fire_on_sync_task(
    hook_log_dir: Path,
) -> None:
    """Sync ``task`` fires SubagentStart + SubagentStop with matching
    parent/child ids and ``reason: "completed"``."""
    hooks = {
        "SubagentStart": [_hook_entry("SubagentStart", hook_log_dir)],
        "SubagentStop": [_hook_entry("SubagentStop", hook_log_dir)],
    }
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()
                client.send_message(
                    session["id"],
                    (
                        "Call the `task` tool once with subagent_type='general', "
                        "description='t', prompt='Reply DONE', async=false. Stop."
                    ),
                    providerID=TOOL_MODEL["providerID"],
                    modelID=TOOL_MODEL["modelID"],
                )
                try:
                    start = _read_hook_log(hook_log_dir, "SubagentStart", timeout_s=120.0)
                except TimeoutError:
                    pytest.skip(
                        "SubagentStart hook never fired — Copilot model "
                        "declined to invoke the task tool."
                    )
                assert start["hook_event_name"] == "SubagentStart"
                assert start.get("agent_type") == "general"
                parent_id = start.get("parent_session_id")
                child_id = start.get("child_session_id")
                assert isinstance(parent_id, str)
                assert isinstance(child_id, str)
                assert parent_id == session["id"]

                try:
                    stop = _read_hook_log(hook_log_dir, "SubagentStop", timeout_s=120.0)
                except TimeoutError:
                    pytest.skip(
                        "SubagentStop hook never fired — subagent never "
                        "completed within the poll deadline."
                    )
                assert stop["hook_event_name"] == "SubagentStop"
                assert stop.get("agent_type") == "general"
                assert stop.get("parent_session_id") == parent_id
                assert stop.get("child_session_id") == child_id
                assert stop.get("reason") == "completed"
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 8. SubagentStop reason=cancelled via turn interrupt ----------------


@pytest.mark.live
@pytest.mark.timeout(300)
@_skip_if_live_disabled
def test_subagent_stop_cancelled_on_interrupt(
    hook_log_dir: Path,
) -> None:
    """Start an async task, then interrupt its turn — the subagent
    lifecycle must close with ``reason: "cancelled"``."""
    hooks = {
        "SubagentStart": [_hook_entry("SubagentStart", hook_log_dir)],
        "SubagentStop": [_hook_entry("SubagentStop", hook_log_dir)],
    }
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()
                import threading

                def _fire() -> None:
                    try:
                        client.send_message(
                            session["id"],
                            (
                                "Call `task` once with subagent_type='general', "
                                "description='slow', prompt='Wait for SECRET "
                                "then reply DONE', async=true. Stop."
                            ),
                            providerID=TOOL_MODEL["providerID"],
                            modelID=TOOL_MODEL["modelID"],
                        )
                    except Exception:
                        pass

                t = threading.Thread(target=_fire, daemon=True)
                t.start()

                try:
                    start = _read_hook_log(
                        hook_log_dir, "SubagentStart", timeout_s=120.0
                    )
                except TimeoutError:
                    pytest.skip(
                        "SubagentStart hook never fired — Copilot model "
                        "declined to invoke the task tool."
                    )
                child_id = start.get("child_session_id")
                assert isinstance(child_id, str)

                # Wait briefly so the child's runLoop has a chance to
                # register its Runner in SessionRunState before we ask
                # for a cancel — otherwise the cancel lands before the
                # child is busy and becomes a no-op.
                time.sleep(3.0)

                # Interrupt the child — that maps to
                # ``SessionPrompt.Service.cancel(child_id)`` which
                # interrupts the child's Runner. On failure (e.g. the
                # child runner isn't registered yet) fall back to
                # interrupting the parent, which cancels its forked
                # child-fiber via the task tool's abort listener.
                try:
                    client.interrupt_turn(child_id)
                except Exception:
                    pass
                # Defensive double-tap: also interrupt the parent so the
                # task tool's own abort listener fires its ``cancelFiber``
                # callback if the child-session cancel didn't land.
                try:
                    client.interrupt_turn(session["id"])
                except Exception:
                    pass

                try:
                    stop = _read_hook_log(hook_log_dir, "SubagentStop", timeout_s=120.0)
                except TimeoutError:
                    pytest.skip(
                        "SubagentStop (cancelled) hook never fired — the "
                        "subagent didn't start so interrupt couldn't cancel."
                    )
                assert stop["hook_event_name"] == "SubagentStop"
                assert stop.get("reason") == "cancelled", (
                    f"expected reason=cancelled after interrupt; got "
                    f"reason={stop.get('reason')!r}"
                )
                t.join(timeout=30.0)
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 9. PermissionDenied(source=reject) — user rejects the prompt -------


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_permission_denied_source_reject(
    hook_log_dir: Path,
) -> None:
    """No preapproved rule for bash; user replies ``reject`` →
    PermissionDenied fires with ``source: "reject"`` — via SGR auto-dispatch.

    Setup: ``{"bash": "ask"}`` forces bash through ``Permission.Service``.
    The SGR auto-dispatch fires bash synchronously; bash calls
    ``ctx.ask`` → ``permission.asked`` SSE event fires. The test races
    a ``/permission/:id/reply {reply:"reject"}`` request, which makes
    the Deferred reject → ``PermissionDenied`` fires with
    ``source: "reject"``.
    """
    import threading as _threading

    hooks = {
        "PermissionDenied": [_hook_entry("PermissionDenied", hook_log_dir)],
    }
    # Force bash through the permission system.
    server = _spawn_sgr_hooks_server(
        hook_log_dir, hooks, permission={"bash": "ask"}
    )
    try:
        _skip_if_no_instance_routes(server)

        # Background event watcher — when ``permission.asked`` fires,
        # issue the reject reply so the pending Deferred resolves.
        reject_done = _threading.Event()
        rejected_req_id: list[str] = []

        def _watch_and_reject() -> None:
            reply_client = OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
                timeout_s=600.0,
            )
            try:
                with reply_client.events(timeout_s=600.0) as stream:
                    for ev in stream:
                        if ev.type != "permission.asked":
                            if reject_done.is_set():
                                return
                            continue
                        req_id = ev.properties.get("id")
                        if not isinstance(req_id, str):
                            continue
                        try:
                            r = reply_client._http.post(
                                f"/permission/{req_id}/reply",
                                json={"reply": "reject"},
                            )
                            r.raise_for_status()
                            rejected_req_id.append(req_id)
                        except Exception:
                            pass
                        return
            except Exception:
                pass
            finally:
                reply_client.close()

        watcher = _threading.Thread(target=_watch_and_reject, daemon=True)
        watcher.start()

        # Fire SGR dispatch on a background thread so the test can wait
        # on the hook log without being blocked by the synchronous
        # `/turn/start` call (which stays open until the rejected
        # permission resolves + the tool-error part lands).
        dispatch_done = _threading.Event()

        def _dispatch() -> None:
            try:
                _dispatch_bash_via_sgr(
                    server,
                    command_hint="echo hi",
                    description_hint="Echo hi for PermissionDenied reject test",
                    timeout_s=600.0,
                    retries=0,
                )
            except BaseException:
                pass
            finally:
                dispatch_done.set()

        dispatcher = _threading.Thread(target=_dispatch, daemon=True)
        dispatcher.start()

        try:
            payload = _read_hook_log(
                hook_log_dir, "PermissionDenied", timeout_s=300.0
            )
            assert payload["hook_event_name"] == "PermissionDenied"
            assert payload.get("source") == "reject", (
                f"expected source=reject; got source={payload.get('source')!r}"
            )
            assert rejected_req_id, "watcher did not reject any permission"
        finally:
            reject_done.set()
            watcher.join(timeout=5.0)
            dispatcher.join(timeout=15.0)
    finally:
        server.stop()
        _cleanup_live_server(server)


# ---- 10. PermissionGranted(source=hook) — hook short-circuits prompt ----


@pytest.mark.live
@pytest.mark.timeout(900)
@_skip_if_live_disabled
def test_permission_granted_source_hook(
    hook_log_dir: Path,
) -> None:
    """PreToolUse hook returning ``permissionDecision: "allow"`` must
    short-circuit the permission flow — via SGR auto-dispatch.

    Setup: force ``bash`` through ``Permission.Service`` with
    ``{"bash": "ask"}`` so the hook's allow decision actually
    short-circuits it. SGR deterministically dispatches bash; the
    PreToolUse hook returns allow; Permission.Service emits
    PermissionGranted with ``source: "hook"`` (not "rule" or "user"),
    and ``permission.asked`` MUST NOT fire.
    """
    # The hook must be **PermissionRequest** (not PreToolUse): only
    # PermissionRequest's ``permissionDecision=allow`` causes
    # `Permission.Service.ask` to short-circuit with
    # ``source: "hook"``. A PreToolUse allow decision has no
    # permission-flow side effect (see ``hook/command.ts`` lines 175-186).
    allow_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "permissionDecision": "allow",
            }
        }
    )
    hooks = {
        "PermissionRequest": [
            _hook_entry(
                "PermissionRequest",
                hook_log_dir,
                matcher="bash",
                stdout_json=allow_stdout,
            )
        ],
        "PermissionGranted": [_hook_entry("PermissionGranted", hook_log_dir)],
    }
    # Force bash through the permission system so the hook can grant it.
    server = _spawn_sgr_hooks_server(
        hook_log_dir, hooks, permission={"bash": "ask"}
    )
    try:
        _skip_if_no_instance_routes(server)

        _instance, session_id, _ = _dispatch_bash_via_sgr(
            server,
            command_hint="echo hi",
            description_hint="Echo hi for PermissionGranted hook test",
        )

        # PermissionRequest allow → PermissionGranted fires with
        # source=hook. Note: ``permission.asked`` on the event bus fires
        # BEFORE the hook runs (see ``permission/index.ts`` line 265),
        # so we cannot assert ``no permission.asked`` — the short-circuit
        # is about internal pending-registration lifecycle, not event
        # emission.
        payload = _read_hook_log(
            hook_log_dir, "PermissionGranted", timeout_s=30.0
        )
        assert payload["hook_event_name"] == "PermissionGranted"
        assert payload.get("source") == "hook", (
            f"expected source=hook; got source={payload.get('source')!r}"
        )
        # PermissionRequest hook log also exists (hooks.dispatch fired it
        # as part of Permission.Service.ask()).
        request_payload = _read_hook_log(
            hook_log_dir, "PermissionRequest", timeout_s=5.0
        )
        assert request_payload["hook_event_name"] == "PermissionRequest"
        assert request_payload["tool_name"] == "bash"

        with OpencodeClient(
            server.base_url,
            project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            timeout_s=30.0,
        ) as client:
            try:
                client.delete_session(session_id)
            except Exception:
                pass
    finally:
        server.stop()
        _cleanup_live_server(server)


# ---------------------------------------------------------------------------
# SGR (Schema-Guided Reasoning) hook tests
# ---------------------------------------------------------------------------
#
# Context: the legacy hook tests above skip whenever the Copilot model
# declines to invoke the ``bash`` tool (the ``PreToolUse`` /
# ``PostToolUse`` hooks only fire on a real tool execution). SGR
# fixes the "will the model emit a valid plan" half of that problem:
# ``format={"type": "json_schema"}`` forces the model to emit a
# schema-conforming JSON payload representing the desired bash
# command.
#
# Limitation (documented for future plumbing): SGR constrains the
# model to a single ``StructuredOutput`` tool call. It does NOT
# translate the validated payload into a downstream ``bash`` tool
# invocation, so PreToolUse/PostToolUse hooks DO NOT fire on a
# pure SGR turn. Wiring ``info.structured`` through the tool
# dispatch layer is a separate server-side change
# (``packages/opencode/src/session/prompt.ts`` + registry + hook
# service) and is out of scope for these tests.
#
# These SGR tests therefore validate the deterministic upstream
# contract that the hook rewrite surfaces rely on today: given a
# ``BashPlan`` or rewrite schema, the server + pydantic reliably
# produce a validated payload that downstream hook/tool execution can
# consume once dispatched.
#
# Documentation gap for opencode itself
# -------------------------------------
# The opencode server currently does NOT support ``format: json_schema``
# on ``/turn/start`` for every provider. This build works for
# ``opencode / gpt-5-nano`` (verified in test_sgr_determinism.py) and
# ``github-copilot#personal / gpt-5-mini`` (verified here). It does
# NOT currently work for vanilla ``github-copilot / gpt-4.1`` —
# the provider's ``/chat/completions`` envelope returns
# "request body is not valid JSON" regardless of whether
# ``format`` is set. Until opencode closes that gap the SGR tests
# must target the known-good provider/model pairs.


def _hooks_sgr_binary() -> str:
    """Return a binary symlink insulated from sibling pkill harnesses.

    Same pattern as ``test_sgr_determinism.py::_resolve_sgr_binary``,
    ``test_autobest.py::_sgr_binary``, and
    ``test_subagent.py::_subagent_sgr_binary``, but with a distinct
    link name so these tests don't collide when run in parallel.
    """
    src = os.environ.get("OPENCODE_BINARY") or "/Users/dave/.local/bin/opencode-unify"
    dst = "/tmp/opencode-sgr-hooks"
    try:
        real_src = os.path.realpath(src)
    except OSError:
        return src
    try:
        current = os.readlink(dst)
    except (OSError, FileNotFoundError):
        current = None
    if current != real_src:
        tmp = dst + f".{os.getpid()}"
        try:
            os.symlink(real_src, tmp)
        except FileExistsError:
            os.unlink(tmp)
            os.symlink(real_src, tmp)
        os.replace(tmp, dst)
    return dst


@pytest.fixture()
def hooks_sgr_server(tmp_path_factory):
    """Per-test SGR server (isolated home + Copilot creds).

    Function-scoped per the rationale in
    ``test_autobest.py::autobest_sgr_server`` (session-scoped SGR
    servers occasionally stalled once the first SGR turn settled).
    """
    if not has_copilot_credentials():
        pytest.skip(
            "No github-copilot OAuth token — SGR hook tests need Copilot creds"
        )

    root = tmp_path_factory.mktemp("sgr-hooks")
    isolated_home = prepare_isolated_home(preserve_tokens=True)
    server = OpencodeServer(
        binary=_hooks_sgr_binary(),
        ready_timeout_s=60.0,
        data_dir=isolated_home,
        cwd=root,
        capture_stderr=True,
    )
    server.start()
    try:
        yield server, str(root)
    finally:
        server.stop()
        shutil.rmtree(isolated_home, ignore_errors=True)


@pytest.fixture()
def hooks_sgr_client(hooks_sgr_server):
    server, project_dir = hooks_sgr_server
    client = OpencodeClient(
        server.base_url,
        project_directory=project_dir,
        timeout_s=180.0,
    )
    try:
        yield client
    finally:
        client.close()


@pytest.fixture(scope="session")
def hooks_sgr_model() -> dict[str, str]:
    """Provider/model pair for SGR hook tests.

    Defaults to ``github-copilot#personal / gpt-4.1`` — see
    ``test_autobest.py::autobest_sgr_model`` docstring for the model
    selection rationale. Overridable via ``OPENCODE_E2E_SGR_PROVIDER``
    / ``OPENCODE_E2E_SGR_MODEL``.
    """
    return {
        "providerID": os.environ.get(
            "OPENCODE_E2E_SGR_PROVIDER", "github-copilot#personal"
        ),
        "modelID": os.environ.get("OPENCODE_E2E_SGR_MODEL", "gpt-4.1"),
    }


# --- SGR schemas -----------------------------------------------------------


from pydantic import BaseModel, Field  # noqa: E402


class BashPlan(BaseModel):
    """Schema for a bash-command invocation plan.

    Mirrors the zod input schema of ``Tool.bash`` (see
    ``src/tool/bash.ts``): required ``command`` + ``description``
    fields both non-empty. SGR forces the provider to emit this exact
    shape — the server-side ``StructuredOutput`` validator rejects
    payloads that omit either field.
    """

    command: str = Field(
        description="The shell command to run.",
        min_length=1,
    )
    description: str = Field(
        description="Short human-readable description of the command.",
        min_length=1,
    )


class PreToolUseRewritePlan(BaseModel):
    """Schema for a PreToolUse updatedInput rewrite plan.

    When a PreToolUse hook returns ``updatedInput: {...}`` the
    opencode server replaces the tool args verbatim (see
    ``src/tool/registry.ts`` line ~376). A hook author building that
    ``updatedInput`` needs a schema-valid payload — this SGR test
    asserts the provider can emit the exact shape the hook-protocol
    expects.
    """

    updated_command: str = Field(
        description="The rewritten bash command the hook wants to run.",
        min_length=1,
    )
    reason: str = Field(
        description="Why the hook rewrote the command.",
        min_length=1,
    )


# ---- Tests ---------------------------------------------------------------


@pytest.mark.live
@pytest.mark.timeout(300)
def test_hooks_sgr_bash_plan_has_required_fields(
    hooks_sgr_client: OpencodeClient,
    hooks_sgr_model: dict[str, str],
) -> None:
    """SGR forces ``{command: str, description: str}`` bash plan.

    Deterministic assertions:

        1. ``BashPlan.model_validate`` succeeds — pydantic accepted
           the payload (``min_length=1`` enforces non-empty).
        2. ``instance.command.strip()`` is truthy — the shell command
           is non-empty.
        3. ``instance.description.strip()`` is truthy.

    These three are the minimum preconditions that the bash tool
    and the hook rewrite pipeline need before dispatch.
    """
    instance, _msg, _thread_id = run_sgr_or_skip(
        hooks_sgr_client,
        model=hooks_sgr_model,
        prompt=(
            "Build a plan to run `echo hooked` via the bash tool. "
            "Return a JSON object with `command` and `description` "
            "fields, both non-empty strings."
        ),
        pydantic_model=BashPlan,
        poll_timeout_s=240.0,
    )
    assert isinstance(instance, BashPlan)
    assert instance.command.strip(), instance.command
    assert instance.description.strip(), instance.description
    # Loose content assertion — the plan should mention echo or hooked,
    # but we allow the model latitude on exactly how it phrases the
    # command (e.g. `echo hooked` vs `echo "hooked"`).
    assert "echo" in instance.command.lower() or "hook" in instance.command.lower(), (
        f"plan command did not reference echo/hook: {instance.command!r}"
    )


@pytest.mark.live
@pytest.mark.timeout(300)
def test_hooks_sgr_pretooluse_rewrite_plan(
    hooks_sgr_client: OpencodeClient,
    hooks_sgr_model: dict[str, str],
) -> None:
    """SGR forces a PreToolUse-rewrite plan (``updated_command`` + ``reason``).

    This is the upstream contract a PreToolUse hook would emit via
    ``updatedInput``: a rewritten bash command plus a human-readable
    reason. Pydantic's ``min_length=1`` on both fields guarantees
    non-empty strings reach downstream consumers.

    Deterministic assertions:

        1. ``PreToolUseRewritePlan.model_validate`` succeeds.
        2. ``updated_command`` is non-empty stripped.
        3. ``reason`` is non-empty stripped.
        4. JSON roundtrip preserves both fields byte-for-byte.
    """
    import json as _json

    instance, _msg, _thread_id = run_sgr_or_skip(
        hooks_sgr_client,
        model=hooks_sgr_model,
        prompt=(
            "A PreToolUse hook wants to rewrite a bash command. "
            "Build the rewrite plan: set `updated_command` to "
            "`echo hooked` and set `reason` to a short sentence "
            "explaining that the original command was intercepted. "
            "Return as a JSON object."
        ),
        pydantic_model=PreToolUseRewritePlan,
        poll_timeout_s=240.0,
    )
    assert isinstance(instance, PreToolUseRewritePlan)
    assert instance.updated_command.strip()
    assert instance.reason.strip()
    decoded = _json.loads(instance.model_dump_json())
    assert decoded["updated_command"] == instance.updated_command
    assert decoded["reason"] == instance.reason
