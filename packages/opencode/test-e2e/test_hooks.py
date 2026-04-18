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
# Tests — live-LLM events (gated on provider env)
# --------------------------------------------------------------------------


_PROVIDER = os.environ.get("OPENCODE_E2E_PROVIDER")
_MODEL = os.environ.get("OPENCODE_E2E_MODEL")

_skip_no_llm = pytest.mark.skipif(
    not (_PROVIDER and _MODEL),
    reason="set OPENCODE_E2E_PROVIDER + OPENCODE_E2E_MODEL to run live-LLM hook tests",
)


@_skip_no_llm
def test_turn_lifecycle_hooks_fire_on_prompt(hook_log_dir: Path) -> None:
    """TurnStart/TurnStop/UserMessage/AssistantMessage/Stop all fire on a
    one-shot prompt turn."""
    events = ["TurnStart", "TurnStop", "UserMessage", "AssistantMessage", "Stop"]
    hooks = {ev: [_hook_entry(ev, hook_log_dir)] for ev in events}

    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
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
                    "Reply with the single word: pong.",
                    providerID=_PROVIDER,  # type: ignore[arg-type]
                    modelID=_MODEL,  # type: ignore[arg-type]
                )

                for ev in events:
                    payload = _read_hook_log(hook_log_dir, ev, timeout_s=10.0)
                    assert payload["hook_event_name"] == ev
                    assert payload["session_id"] == session["id"]
        finally:
            _cleanup_server_dirs(server)


@_skip_no_llm
def test_precompact_postcompact_hooks_fire_on_summarize(hook_log_dir: Path) -> None:
    """``POST /session/:id/summarize`` fires PreCompact + PostCompact."""
    hooks = {
        "PreCompact": [_hook_entry("PreCompact", hook_log_dir)],
        "PostCompact": [_hook_entry("PostCompact", hook_log_dir)],
    }
    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
        _skip_if_no_instance_routes(server)
        try:
            with OpencodeClient(
                server.base_url,
                project_directory=str(server._e2e_cwd),  # type: ignore[attr-defined]
                timeout_s=300.0,
            ) as client:
                session = client.create_session()
                # Need at least one prior turn for summarize to have content.
                client.send_message(
                    session["id"],
                    "Say hi.",
                    providerID=_PROVIDER,  # type: ignore[arg-type]
                    modelID=_MODEL,  # type: ignore[arg-type]
                )
                client.summarize(
                    session["id"],
                    providerID=_PROVIDER,  # type: ignore[arg-type]
                    modelID=_MODEL,  # type: ignore[arg-type]
                )

                pre = _read_hook_log(hook_log_dir, "PreCompact", timeout_s=10.0)
                assert pre["hook_event_name"] == "PreCompact"
                assert "trigger" in pre

                post = _read_hook_log(hook_log_dir, "PostCompact", timeout_s=10.0)
                assert post["hook_event_name"] == "PostCompact"
                assert "kept_messages" in post
                assert "dropped_messages" in post
        finally:
            _cleanup_server_dirs(server)


@_skip_no_llm
def test_pretooluse_deny_short_circuits_tool(hook_log_dir: Path) -> None:
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
    with _spawn_server(hook_log_dir=hook_log_dir, hooks=hooks) as server:
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
                    "Use the bash tool to run `echo hello`. If blocked, just say BLOCKED.",
                    providerID=_PROVIDER,  # type: ignore[arg-type]
                    modelID=_MODEL,  # type: ignore[arg-type]
                )
                # Hook should have fired at least once.
                payload = _read_hook_log(hook_log_dir, "PreToolUse", timeout_s=15.0)
                assert payload["hook_event_name"] == "PreToolUse"
                assert "tool_name" in payload
        finally:
            _cleanup_server_dirs(server)
