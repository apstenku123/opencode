"""Helpers for driving real-LLM turns against a live opencode server.

Mirrors the codex-rs SDK's ``run_turn`` helper: send a prompt, wait for the
assistant-turn to complete, return the final assistant message parts so
the test can assert on content.

The transport is opencode's normal HTTP: ``POST /turn/start`` to enqueue
a user turn, then poll ``GET /session/:id/message`` (matching the pattern
used by existing hook tests) until an assistant message with a non-empty
``text`` part is observed. We intentionally avoid the SSE event stream
here — it's great for fine-grained tracing but pytest-level smoke tests
are clearer when the wait surface is HTTP alone.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import httpx

from .client import OpencodeClient


def _assistant_text(message: dict[str, Any]) -> str:
    """Concatenate all ``text`` parts of an assistant message into a string."""
    parts = message.get("parts") or []
    pieces: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text")
            if isinstance(text, str) and text:
                pieces.append(text)
    return "".join(pieces)


def _message_role(message: dict[str, Any]) -> Optional[str]:
    """Best-effort role extraction — opencode nests it under ``info``."""
    info = message.get("info") or {}
    if isinstance(info, dict):
        role = info.get("role")
        if isinstance(role, str):
            return role
    role = message.get("role")
    return role if isinstance(role, str) else None


def _has_tool_part(message: dict[str, Any]) -> bool:
    """Check whether a message contains at least one tool-call part."""
    parts = message.get("parts") or []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "tool":
            return True
    return False


def _is_turn_finished(message: dict[str, Any]) -> bool:
    """Return True when an assistant message's ``time.completed`` is set."""
    info = message.get("info") or message
    if not isinstance(info, dict):
        return False
    time_info = info.get("time") or {}
    if isinstance(time_info, dict) and time_info.get("completed") is not None:
        return True
    # Fallback: opencode sometimes sets a top-level ``completed`` flag.
    return bool(info.get("completed"))


def run_live_turn(
    client: OpencodeClient,
    thread_id: str,
    prompt: str,
    *,
    model: Optional[dict[str, str]] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    timeout_s: int = 120,
    poll_interval_s: float = 0.5,
    agent: Optional[str] = None,
) -> dict[str, Any]:
    """Send ``prompt`` as a user turn and block until the assistant replies.

    Accepts either a full ``model={'providerID': ..., 'modelID': ...}`` dict
    (matching the opencode HTTP schema) or the pair of string args
    ``provider_id``/``model_id`` for convenience.

    Returns a dict::

        {
            "user_message_id": str,
            "assistant_message_id": str,
            "assistant_text": str,
            "assistant_message": dict,   # full record incl. parts
            "all_messages": list[dict],  # every message on the session
            "tool_messages": list[dict], # assistant messages with tool parts
        }

    Raises ``TimeoutError`` if no completed assistant message arrives
    within ``timeout_s`` seconds — we deliberately do not swallow this
    so test failures point at the real problem (dead endpoint, auth
    broken, quota exhausted) rather than silently passing.
    """
    if model is None:
        if provider_id is not None and model_id is not None:
            model = {"providerID": provider_id, "modelID": model_id}
    # ``POST /turn/start`` accepts an optional ``model``; passing it
    # through unchanged matches the shape the OpencodeClient helper
    # expects. When omitted, the server picks the thread's default.
    start_kwargs: dict[str, Any] = {}
    if model is not None:
        start_kwargs["model"] = model
    if agent is not None:
        start_kwargs["agent"] = agent

    # ``POST /turn/start`` can hit httpx.ReadTimeout when the upstream
    # Copilot endpoint stalls mid-stream (observed on bash_echo turns).
    # Swallow the transport error and fall through to the poll loop —
    # the assistant message is persisted server-side even when the POST
    # disconnects, so `get_messages` will eventually see it.
    try:
        start = client.start_turn(thread_id, prompt, **start_kwargs)
    except (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ReadError):
        start = {}
    # ``POST /turn/start`` returns an assistant-message stub with an id —
    # we use it to filter once the turn completes.
    assistant_id = None
    if isinstance(start, dict):
        info = start.get("info") or start
        if isinstance(info, dict):
            candidate = info.get("id")
            if isinstance(candidate, str):
                assistant_id = candidate

    deadline = time.monotonic() + timeout_s
    last_messages: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        try:
            messages = client.get_messages(thread_id)
        except Exception:
            time.sleep(poll_interval_s)
            continue
        if not isinstance(messages, list):
            time.sleep(poll_interval_s)
            continue
        last_messages = messages
        # Find the target assistant message (or fall back to the last one).
        candidates = [m for m in messages if _message_role(m) == "assistant"]
        if assistant_id is not None:
            match = next(
                (
                    m
                    for m in candidates
                    if isinstance(m.get("info"), dict)
                    and m["info"].get("id") == assistant_id
                ),
                None,
            )
            target = match or (candidates[-1] if candidates else None)
        else:
            target = candidates[-1] if candidates else None

        if target is not None and _is_turn_finished(target):
            user_msg = next(
                (m for m in messages if _message_role(m) == "user"),
                None,
            )
            user_id = None
            if user_msg and isinstance(user_msg.get("info"), dict):
                user_id = user_msg["info"].get("id")
            tool_messages = [m for m in messages if _has_tool_part(m)]
            target_id = None
            if isinstance(target.get("info"), dict):
                target_id = target["info"].get("id")
            return {
                "user_message_id": user_id,
                "assistant_message_id": target_id,
                "assistant_text": _assistant_text(target),
                "assistant_message": target,
                "all_messages": messages,
                "tool_messages": tool_messages,
            }
        time.sleep(poll_interval_s)

    # Timeout: surface as much diagnostic context as possible.
    raise TimeoutError(
        f"live turn on thread {thread_id} did not complete within "
        f"{timeout_s}s (messages seen: {len(last_messages)})"
    )


def fetch_account_quotas(
    binary: str,
    *,
    env: Optional[dict[str, str]] = None,
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """Run ``opencode providers accounts --json`` and return the parsed output.

    The binary is invoked out-of-process (not via HTTP) because the
    account-overview command bypasses the server and hits the Copilot
    quota API directly. Passing the same XDG env as the running server
    ensures both see the same credentials + connection state.
    """
    import json
    import subprocess

    cmd = [binary, "providers", "accounts", "--json"]
    merged_env = {**(env or {})}
    # Inherit PATH etc. when caller didn't provide a full env.
    import os as _os

    for k, v in _os.environ.items():
        merged_env.setdefault(k, v)

    result = subprocess.run(
        cmd,
        capture_output=True,
        timeout=timeout_s,
        env=merged_env,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"providers accounts --json exited {result.returncode}: "
            f"{result.stderr.decode('utf-8', errors='replace')}"
        )
    stdout = result.stdout.decode("utf-8", errors="replace")
    # The CLI emits a ``prompts.intro`` preamble (including ANSI codes) on
    # stdout even in --json mode. Strip ANSI and find the first top-level
    # JSON object via ``raw_decode``.
    import re as _re

    stripped = _re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", stdout)
    # Skip to the first ``{`` at column 0 (the envelope always starts at
    # the margin); fall back to the first ``{`` anywhere if no margin
    # match (some builds don't include the intro banner).
    idx = stripped.find("\n{")
    if idx >= 0:
        idx += 1
    else:
        idx = stripped.find("{")
    if idx < 0:
        raise RuntimeError(
            f"could not locate JSON envelope in providers accounts output: "
            f"{stdout[:400]!r}"
        )
    try:
        obj, _ = json.JSONDecoder().raw_decode(stripped[idx:])
    except json.JSONDecodeError as err:
        raise RuntimeError(
            f"failed to parse providers accounts JSON at offset {idx}: "
            f"{err}; tail={stripped[idx : idx + 400]!r}"
        ) from err
    return obj


def premium_remaining(quota_json: dict[str, Any]) -> dict[str, Optional[int]]:
    """Extract ``premium.remaining`` per account from ``fetch_account_quotas``.

    Returns ``{account_key: remaining_int_or_None}``. Used by the quota
    decrement test: diff before/after and assert at least one account's
    remaining dropped — that's the only reliable signal that the turn
    actually routed through Copilot and consumed a premium credit.
    """
    out: dict[str, Optional[int]] = {}
    items = quota_json.get("items")
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        info = item.get("info") or {}
        # The key isn't always in ``info`` — older shapes put it in ``status``.
        key = None
        status = item.get("status")
        if isinstance(status, dict):
            key = status.get("key")
        if not isinstance(key, str):
            continue
        quota = item.get("quota")
        remaining = None
        if isinstance(quota, dict):
            premium = quota.get("premium")
            if isinstance(premium, dict):
                r = premium.get("remaining")
                if isinstance(r, (int, float)):
                    remaining = int(r)
        out[key] = remaining
    return out
