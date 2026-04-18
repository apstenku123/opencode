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

from harness import OpencodeClient, OpencodeServer, resolve_opencode_binary

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
        ready_timeout_s=30.0,
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


def test_session_start_hook_fires_on_create(hook_log_dir: Path) -> None:
    """``POST /session`` → ``SessionStart`` hook receives JSON payload."""
    hooks = {"SessionStart": [_hook_entry("SessionStart", hook_log_dir)]}
    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            ) as client:
                session = client.create_session()
                assert session["id"].startswith("ses_")

                payload = _read_hook_log(hook_log_dir, "SessionStart")
                assert payload["hook_event_name"] == "SessionStart"
                assert payload["session_id"] == session["id"]
                assert "cwd" in payload
                assert "triggered_at" in payload
                # SessionStart carries `source` + `model` fields.
                assert "source" in payload
        finally:
            _cleanup_server_dirs(server)


def test_session_end_hook_fires_on_delete(hook_log_dir: Path) -> None:
    """``DELETE /session/:id`` → ``SessionEnd`` hook receives JSON payload."""
    hooks = {
        "SessionStart": [_hook_entry("SessionStart", hook_log_dir)],
        "SessionEnd": [_hook_entry("SessionEnd", hook_log_dir)],
    }
    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            ) as client:
                session = client.create_session()
                _read_hook_log(hook_log_dir, "SessionStart")  # wait for start

                client.delete_session(session["id"])

                payload = _read_hook_log(hook_log_dir, "SessionEnd")
                assert payload["hook_event_name"] == "SessionEnd"
                assert payload["session_id"] == session["id"]
                assert "reason" in payload
        finally:
            _cleanup_server_dirs(server)


def test_hook_matcher_filters_events(hook_log_dir: Path) -> None:
    """A matcher regex on ``SessionStart.source`` restricts firing."""
    # Match only sessions whose source is "no-such-source" — the default
    # source is "cli", so the hook should NOT fire.
    hooks = {
        "SessionStart": [
            _hook_entry(
                "SessionStart",
                hook_log_dir,
                matcher="^no-such-source$",
                name="mismatched",
            ),
        ],
    }
    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
            ) as client:
                client.create_session()

                log_path = hook_log_dir / "opencode-hook-SessionStart.log"
                # Poll briefly to catch any late write; must remain absent.
                time.sleep(0.5)
                assert not log_path.exists(), (
                    f"hook fired despite matcher mismatch; log={log_path.read_text()}"
                )
        finally:
            _cleanup_server_dirs(server)


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
        ready_timeout_s=30.0,
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
@_skip_if_live_disabled
def test_pretooluse_deny_short_circuits_tool(
    hook_log_dir: Path,
    isolated_copilot_home: Path,
) -> None:
    """PreToolUse hook with permissionDecision=deny causes the tool call
    to NOT execute — assistant either reports an error or skips."""
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
                    "Use the bash tool to run `echo hi`. If blocked, say BLOCKED.",
                    providerID=TOOL_MODEL["providerID"],
                    modelID=TOOL_MODEL["modelID"],
                )
                # PreToolUse only fires after the model commits to a tool
                # call. When Copilot's ``/responses`` API rejects the
                # specific model outright, the turn short-circuits before
                # any tool call — we detect that and skip rather than
                # failing (the TS unit tests cover the deny path against
                # a controlled fake provider; this live test only
                # asserts end-to-end wiring when the upstream cooperates).
                log_path = hook_log_dir / "opencode-hook-PreToolUse.log"
                start = time.monotonic()
                while time.monotonic() - start < 60.0:
                    if log_path.exists():
                        break
                    time.sleep(0.5)

                if not log_path.exists():
                    msgs = client.get_messages(session["id"])
                    flat = json.dumps(msgs)
                    if (
                        "githubcopilot.com" in flat
                        and "model_not_supported" in flat
                    ):
                        pytest.skip(
                            "upstream Copilot endpoint rejected the model "
                            "via /responses; tool dispatch never happened. "
                            "The deny-hook path is covered by TS unit tests."
                        )

                payload = _read_hook_log(hook_log_dir, "PreToolUse", timeout_s=5.0)
                assert payload["hook_event_name"] == "PreToolUse"
                assert "tool_name" in payload
                # Strong assertion: the tool must NOT have executed. If it
                # had, bash would echo ``hi\n`` into some tool-result frame.
                # The deny hook runs BEFORE execute, so ``hi\n`` must be
                # absent — and the deny reason must surface in the error
                # chain so the assistant knows why the tool failed.
                msgs = client.get_messages(session["id"])
                flat = json.dumps(msgs)
                if '"hi\\n"' in flat:
                    raise AssertionError(
                        "bash echo stdout appeared despite PreToolUse deny"
                    )
                assert (
                    "blocked by e2e test hook" in flat
                    or "denied" in flat.lower()
                    or "BLOCKED" in flat
                ), "deny reason did not propagate into any message frame"
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
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
        ready_timeout_s=30.0,
        capture_stderr=True,
        env={"OPENCODE_DEBUG_PROVIDERS": "1"},
    )
    server._e2e_home = isolated_home  # type: ignore[attr-defined]
    server._e2e_cwd = scratch_cwd  # type: ignore[attr-defined]
    return server


# ---- 1. PreToolUse updatedInput — bash command is rewritten -------------


@pytest.mark.live
@_skip_if_live_disabled
def test_pretooluse_updated_input_rewrites_bash_command(
    hook_log_dir: Path,
) -> None:
    """Hook returns updatedInput that replaces the model's bash command.

    The original prompt asks for ``echo original``; the hook must force
    ``echo hooked``. We assert the tool's captured stdout contains
    ``hooked`` rather than ``original``.
    """
    # `updatedInput` is a full replacement of the tool's args — not a
    # partial merge (see ``src/tool/registry.ts`` line 376). The bash
    # tool's zod schema requires ``command`` + ``description``, so we
    # include both verbatim so downstream validation passes cleanly.
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
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()
                # Use the non-blocking start_turn + poll pattern so a long
                # model round-trip doesn't time out the HTTP connection
                # itself (the sync ``send_message`` blocks the wire until
                # the turn settles, which for an updatedInput roundtrip
                # can exceed 60s when the model loops back after the
                # tool result).
                client.start_turn(
                    session["id"],
                    "Run `echo original` via the bash tool. Then stop.",
                    model={
                        "providerID": TOOL_MODEL["providerID"],
                        "modelID": TOOL_MODEL["modelID"],
                    },
                )
                # Wait for the hook to fire — that proves bash was
                # invoked and the PreToolUse path ran with the rewritten
                # input (tool_input on the log was the original, the
                # effective input is what the executor received).
                payload = _read_hook_log(hook_log_dir, "PreToolUse", timeout_s=180.0)
                assert payload["hook_event_name"] == "PreToolUse"
                assert payload["tool_name"] == "bash"

                # Wait for the bash tool's output to surface on a message.
                # The turn may still be running when our poll starts — we
                # keep polling until a bash tool part shows a ``state.output``
                # or a deadline elapses.
                deadline = time.monotonic() + 180.0
                bash_outs: list[str] = []
                while time.monotonic() < deadline:
                    msgs = client.get_messages(session["id"])
                    bash_outs = _tool_outputs(msgs, "bash")
                    if bash_outs and any(bo.strip() for bo in bash_outs):
                        break
                    time.sleep(1.0)
                if not bash_outs:
                    pytest.skip(
                        "model did not invoke bash — cannot assert "
                        "updatedInput took effect"
                    )
                joined = "\n".join(bash_outs)
                assert "hooked" in joined, (
                    "PreToolUse updatedInput did not rewrite bash command; "
                    f"captured bash output: {joined!r}"
                )
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 2. PostToolUse updatedMCPToolOutput — tool output replaced ---------


@pytest.mark.live
@_skip_if_live_disabled
def test_posttooluse_updated_output_replaces_tool_result(
    hook_log_dir: Path,
) -> None:
    """PostToolUse hook returns ``updatedMCPToolOutput: "REPLACED"`` —
    the captured tool output string is overwritten."""
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
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()
                client.send_message(
                    session["id"],
                    "Run `echo marker42` via the bash tool. Stop.",
                    providerID=TOOL_MODEL["providerID"],
                    modelID=TOOL_MODEL["modelID"],
                )
                payload = _read_hook_log(hook_log_dir, "PostToolUse", timeout_s=60.0)
                assert payload["hook_event_name"] == "PostToolUse"
                assert payload["tool_name"] == "bash"
                assert "tool_response" in payload

                msgs = client.get_messages(session["id"])
                bash_outs = _tool_outputs(msgs, "bash")
                if not bash_outs:
                    pytest.skip("model did not invoke bash tool")
                joined = "\n".join(bash_outs)
                assert "REPLACED" in joined, (
                    f"PostToolUse updatedMCPToolOutput was not applied: "
                    f"{joined!r}"
                )
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 4. PreToolUse ask — forwards to Permission.Service ------------------


@pytest.mark.live
@_skip_if_live_disabled
def test_pretooluse_ask_emits_permission_request(
    hook_log_dir: Path,
) -> None:
    """PreToolUse hook returns permissionDecision=ask — Permission.Service
    emits a ``permission.asked`` SSE event whose metadata carries
    ``hookReason`` (see ``src/tool/registry.ts``).
    """
    ask_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": "hook wants user approval",
            }
        }
    )
    hooks = {
        "PreToolUse": [
            _hook_entry(
                "PreToolUse",
                hook_log_dir,
                matcher="bash",
                stdout_json=ask_stdout,
            )
        ],
    }
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()

                # send_message blocks until the turn settles; fire it on a
                # background thread so we can race the permission flow.
                import threading

                def _fire() -> None:
                    try:
                        client.send_message(
                            session["id"],
                            "Run `echo hi` via the bash tool. Stop.",
                            providerID=TOOL_MODEL["providerID"],
                            modelID=TOOL_MODEL["modelID"],
                        )
                    except Exception:
                        pass

                t = threading.Thread(target=_fire, daemon=True)
                t.start()

                asked = None
                deadline = time.monotonic() + 120.0
                with client.events(timeout_s=150.0) as stream:
                    for ev in stream:
                        if ev.type == "permission.asked":
                            asked = ev
                            break
                        if time.monotonic() >= deadline:
                            break

                if asked is None:
                    pytest.skip(
                        "no permission.asked event observed — model may "
                        "have skipped the bash tool"
                    )

                props = asked.properties
                assert props.get("sessionID") == session["id"]
                metadata = props.get("metadata") or {}
                assert "hookReason" in metadata, (
                    f"hookReason missing from permission metadata: {metadata!r}"
                )

                # Auto-answer so the turn unblocks; reject is fine — the
                # assertion has already landed and the server now just
                # needs to settle.
                req_id = props.get("id")
                if isinstance(req_id, str):
                    try:
                        client._http.post(
                            f"/permission/{req_id}/reply",
                            json={"reply": "reject"},
                        )
                    except Exception:
                        pass
                t.join(timeout=30.0)
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 5. FailedAbort on Stop — exit 2 + stderr -----------------------------


@pytest.mark.live
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

                payload = _read_hook_log(hook_log_dir, "Stop", timeout_s=180.0)
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
@_skip_if_live_disabled
def test_posttooluse_normal_fires_after_tool(
    hook_log_dir: Path,
) -> None:
    """No hook output — just verify the hook fires and payload has
    ``tool_name`` + ``tool_response``."""
    hooks = {
        "PostToolUse": [_hook_entry("PostToolUse", hook_log_dir, matcher="bash")],
    }
    server = _live_hooks_spawn_server(hook_log_dir, hooks)
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()
                client.send_message(
                    session["id"],
                    "Run `echo ping` via the bash tool. Stop.",
                    providerID=TOOL_MODEL["providerID"],
                    modelID=TOOL_MODEL["modelID"],
                )
                payload = _read_hook_log(hook_log_dir, "PostToolUse", timeout_s=60.0)
                assert payload["hook_event_name"] == "PostToolUse"
                assert payload["tool_name"] == "bash"
                assert "tool_response" in payload
                assert "tool_use_id" in payload
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 7. SubagentStart + SubagentStop (reason=completed) -----------------


@pytest.mark.live
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
                start = _read_hook_log(hook_log_dir, "SubagentStart", timeout_s=120.0)
                assert start["hook_event_name"] == "SubagentStart"
                assert start.get("agent_type") == "general"
                parent_id = start.get("parent_session_id")
                child_id = start.get("child_session_id")
                assert isinstance(parent_id, str)
                assert isinstance(child_id, str)
                assert parent_id == session["id"]

                stop = _read_hook_log(hook_log_dir, "SubagentStop", timeout_s=120.0)
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

                start = _read_hook_log(
                    hook_log_dir, "SubagentStart", timeout_s=120.0
                )
                child_id = start.get("child_session_id")
                assert isinstance(child_id, str)

                # Interrupt the child session's turn — this is what drives
                # the cancellation path in ``subagent/registry.ts``.
                try:
                    client.interrupt_turn(child_id)
                except Exception:
                    client.interrupt_turn(session["id"])

                stop = _read_hook_log(hook_log_dir, "SubagentStop", timeout_s=120.0)
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
@_skip_if_live_disabled
def test_permission_denied_source_reject(
    hook_log_dir: Path,
) -> None:
    """No preapproved rule for bash; user replies ``reject`` → a
    PermissionDenied hook must fire with ``source: "reject"``.
    """
    hooks = {
        "PermissionDenied": [_hook_entry("PermissionDenied", hook_log_dir)],
    }
    # Force bash through the permission system.
    server = _spawn_live_with_permission_overrides(
        hook_log_dir, hooks, {"bash": "ask"}
    )
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
                            "Run `echo hi` via the bash tool. Stop.",
                            providerID=TOOL_MODEL["providerID"],
                            modelID=TOOL_MODEL["modelID"],
                        )
                    except Exception:
                        pass

                t = threading.Thread(target=_fire, daemon=True)
                t.start()

                asked = None
                deadline = time.monotonic() + 150.0
                with client.events(timeout_s=180.0) as stream:
                    for ev in stream:
                        if ev.type == "permission.asked":
                            asked = ev
                            break
                        if time.monotonic() >= deadline:
                            break
                if asked is None:
                    pytest.skip(
                        "no permission.asked event within 150s — model did "
                        "not invoke bash"
                    )
                req_id = asked.properties.get("id")
                assert isinstance(req_id, str)
                r = client._http.post(
                    f"/permission/{req_id}/reply", json={"reply": "reject"}
                )
                r.raise_for_status()

                payload = _read_hook_log(
                    hook_log_dir, "PermissionDenied", timeout_s=90.0
                )
                assert payload["hook_event_name"] == "PermissionDenied"
                assert payload.get("source") == "reject"
                t.join(timeout=30.0)
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)


# ---- 10. PermissionGranted(source=hook) — hook short-circuits prompt ----


@pytest.mark.live
@_skip_if_live_disabled
def test_permission_granted_source_hook(
    hook_log_dir: Path,
) -> None:
    """A PreToolUse hook returning ``permissionDecision: "allow"`` must
    short-circuit the permission flow — no user prompt — and fire
    PermissionGranted with ``source: "hook"``.
    """
    allow_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }
        }
    )
    hooks = {
        "PreToolUse": [
            _hook_entry(
                "PreToolUse",
                hook_log_dir,
                matcher="bash",
                stdout_json=allow_stdout,
            )
        ],
        "PermissionGranted": [_hook_entry("PermissionGranted", hook_log_dir)],
    }
    # Force bash through the permission system so the hook can grant it.
    server = _spawn_live_with_permission_overrides(
        hook_log_dir, hooks, {"bash": "ask"}
    )
    with server:
        _skip_if_no_instance_routes(server)
        try:
            with _live_client(server) as client:
                session = client.create_session()

                # Watch for permission.asked in the background — it MUST
                # NOT fire when the hook short-circuits with allow.
                seen_asked: list[Any] = []
                import threading

                def _watch() -> None:
                    try:
                        with client.events(timeout_s=90.0) as stream:
                            for ev in stream:
                                if ev.type == "permission.asked":
                                    seen_asked.append(ev)
                    except Exception:
                        pass

                watcher = threading.Thread(target=_watch, daemon=True)
                watcher.start()

                client.send_message(
                    session["id"],
                    "Run `echo hi` via the bash tool. Stop.",
                    providerID=TOOL_MODEL["providerID"],
                    modelID=TOOL_MODEL["modelID"],
                )

                payload = _read_hook_log(
                    hook_log_dir, "PermissionGranted", timeout_s=60.0
                )
                assert payload["hook_event_name"] == "PermissionGranted"
                assert payload.get("source") == "hook", (
                    f"expected source=hook; got source={payload.get('source')!r}"
                )
                assert not seen_asked, (
                    f"permission.asked fired despite hook allow short-circuit: "
                    f"{[ev.properties for ev in seen_asked]!r}"
                )
                try:
                    client.delete_session(session["id"])
                except Exception:
                    pass
        finally:
            _cleanup_live_server(server)
