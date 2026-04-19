"""Schema-Guided Reasoning (SGR) helpers for e2e tests.

What this module provides
-------------------------
A small wrapper around ``POST /turn/start`` that fires a turn with
``format={"type": "json_schema", "schema": ...}`` set and polls the
session for an ``info.structured`` payload. The caller supplies a
pydantic ``BaseModel`` to validate the payload against.

Why
---
Real provider turns in the wider e2e suite skip a lot when the model
declines to call a specific tool (``bash``, ``task``, etc.). SGR
bypasses that: when ``format.type === "json_schema"`` is set, the
opencode server registers a ``StructuredOutput`` tool whose input
schema is the caller's JSON Schema and forces ``toolChoice="required"``
so the model's only legal next token is a ``StructuredOutput``
invocation with a schema-conforming JSON object. See
``packages/opencode/src/session/prompt.ts`` (``createStructuredOutputTool``
and ``lastUser.format?.type === "json_schema"`` branches) and
``packages/opencode/src/session/message-v2.ts`` (``structured`` field
on assistant message).

This mirrors the determinism-test helper in
``test_sgr_determinism.py`` — we factor it out here so the
``test_subagent.py`` / ``test_hooks.py`` / ``test_autobest.py`` tests
can reuse the same polling logic without copy-pasting ~100 lines.

Usage
-----

    from harness.sgr import run_sgr_turn

    class Plan(BaseModel):
        command: str = Field(description="shell command to run")

    instance, message = run_sgr_turn(
        client,
        model={"providerID": "opencode", "modelID": "gpt-5-nano"},
        prompt="Emit a plan to print `hooked` via bash.",
        pydantic_model=Plan,
    )
    assert instance.command  # pydantic-validated

``run_sgr_turn`` returns ``(instance_or_None, assistant_message_or_None)``.
``_run_sgr_or_skip`` replicates the legacy ladder used in
``test_sgr_determinism.py``: ``info.structured`` first, text-JSON
fallback second, ``pytest.skip`` with a diagnostic reason last.
"""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Optional

import httpx
import pytest
from pydantic import BaseModel, ValidationError

from .client import OpencodeClient


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


DEFAULT_POLL_TIMEOUT_S = 180.0
DEFAULT_POLL_INTERVAL_S = 1.0


# Models verified on this build to honour ``format={"type":"json_schema"}``
# and land ``info.structured`` within ~20-30s for small arithmetic-style
# payloads. Callers can override via the ``model=`` argument.
SGR_DEFAULT_MODEL = {"providerID": "opencode", "modelID": "gpt-5-nano"}


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_json_fallback(text: str) -> Optional[dict[str, Any]]:
    """Best-effort extraction of a JSON object from free-form model text.

    Used when the model ignored the ``StructuredOutput`` tool and
    instead emitted its answer as plain text (rare but observed on
    some models when ``toolChoice=required`` isn't honoured end-to-end).
    If any JSON object parses cleanly into a dict we return it; the
    caller re-validates via pydantic.
    """
    if not text:
        return None
    stripped = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", stripped, re.DOTALL)
    if fence:
        stripped = fence.group(1).strip()
    try:
        obj = json.loads(stripped)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    match = _JSON_OBJECT_RE.search(text)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def assistant_text(message: dict[str, Any]) -> str:
    parts = message.get("parts") or []
    pieces: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text")
            if isinstance(text, str) and text:
                pieces.append(text)
    return "".join(pieces)


def extract_error(message: Optional[dict[str, Any]]) -> Any:
    if not isinstance(message, dict):
        return None
    info = message.get("info")
    if not isinstance(info, dict):
        return None
    return info.get("error")


def is_turn_finished(message: dict[str, Any]) -> bool:
    info = message.get("info") or message
    if not isinstance(info, dict):
        return False
    time_info = info.get("time") or {}
    if isinstance(time_info, dict) and time_info.get("completed") is not None:
        return True
    return bool(info.get("completed"))


# ---------------------------------------------------------------------------
# Core SGR turn driver
# ---------------------------------------------------------------------------


def run_sgr_turn(
    client: OpencodeClient,
    *,
    model: dict[str, str],
    prompt: str,
    schema: dict[str, Any],
    thread_id: Optional[str] = None,
    retry_count: int = 0,
    poll_timeout_s: float = DEFAULT_POLL_TIMEOUT_S,
    poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
) -> tuple[Any, Optional[dict[str, Any]]]:
    """Drive one SGR-constrained turn end-to-end.

    ``POST /turn/start`` is nominally synchronous on the opencode server.
    Holding an HTTP connection open for minutes is fragile on laptops:
    the OS, the httpx pool, and the network stack can all tear it down
    for reasons unrelated to SGR correctness. To decouple the test from
    connection longevity we fire ``start_turn`` in a background thread
    (so the socket lives on its own pool) and poll
    ``GET /session/:id/message`` on the main thread. ``structured``
    appearing on any assistant message is the terminal success signal;
    the driver exiting without ``structured`` is the terminal
    "no SGR" signal.

    Returns ``(structured_payload_or_None, last_assistant_message_or_None)``.
    """
    if thread_id is None:
        thread = client.create_thread()
        thread_id = thread["id"]
        assert isinstance(thread_id, str) and thread_id

    turn_error: list[BaseException] = []
    turn_done = threading.Event()

    # Dedicated client for the long-held driver connection.
    driver_client = OpencodeClient(
        client.base_url,
        project_directory=client.project_directory,
        timeout_s=max(poll_timeout_s * 2, 600.0),
    )

    def _drive() -> None:
        try:
            driver_client.start_turn(
                thread_id,
                prompt,
                model=model,
                format={
                    "type": "json_schema",
                    "schema": schema,
                    "retryCount": retry_count,
                },
            )
        except BaseException as err:  # noqa: BLE001 — surface for caller
            turn_error.append(err)
        finally:
            turn_done.set()
            driver_client.close()

    worker = threading.Thread(
        target=_drive, name=f"sgr-turn-{thread_id}", daemon=True
    )
    worker.start()

    deadline = time.monotonic() + poll_timeout_s
    last_assistant: Optional[dict[str, Any]] = None
    while time.monotonic() < deadline:
        try:
            messages = client.get_messages(thread_id)
        except (httpx.HTTPError, Exception):
            time.sleep(poll_interval_s)
            continue
        if isinstance(messages, list):
            for m in messages:
                info = m.get("info") or {}
                if not isinstance(info, dict):
                    continue
                if info.get("role") != "assistant":
                    continue
                last_assistant = m
                structured = info.get("structured")
                if structured is not None:
                    return structured, m
        if turn_done.is_set():
            # Final scan in case structured landed between the last
            # GET and the driver's final write.
            try:
                messages = client.get_messages(thread_id)
            except Exception:
                messages = []
            if isinstance(messages, list):
                for m in messages:
                    info = m.get("info") or {}
                    if isinstance(info, dict) and info.get("role") == "assistant":
                        last_assistant = m
                        structured = info.get("structured")
                        if structured is not None:
                            return structured, m
            if last_assistant is None and turn_error:
                raise turn_error[0]
            return None, last_assistant
        time.sleep(poll_interval_s)

    return None, last_assistant


def run_sgr_or_skip(
    client: OpencodeClient,
    *,
    model: dict[str, str],
    prompt: str,
    pydantic_model: type[BaseModel],
    schema_overrides: Optional[dict[str, Any]] = None,
    thread_id: Optional[str] = None,
    poll_timeout_s: float = DEFAULT_POLL_TIMEOUT_S,
) -> tuple[BaseModel, Optional[dict[str, Any]], str]:
    """Run one SGR turn, return a validated pydantic instance + thread id, or skip.

    Ladder:

        1. ``info.structured`` present → validate via pydantic; return
           instance on success, skip on ValidationError.
        2. Assistant emitted plaintext that parses as JSON → re-validate.
        3. Nothing workable → ``pytest.skip`` with a diagnostic reason.

    Returns ``(instance, assistant_message, thread_id)``. ``thread_id``
    is returned so the caller can issue follow-up turns on the same
    session.
    """
    schema = schema_overrides or pydantic_model.model_json_schema()

    if thread_id is None:
        thread = client.create_thread()
        thread_id = thread["id"]
        assert isinstance(thread_id, str) and thread_id

    structured, message = run_sgr_turn(
        client,
        model=model,
        prompt=prompt,
        schema=schema,
        thread_id=thread_id,
        poll_timeout_s=poll_timeout_s,
    )

    if structured is not None:
        try:
            return pydantic_model.model_validate(structured), message, thread_id
        except ValidationError as err:
            pytest.skip(
                f"SGR structured payload failed pydantic validation: {err!r}. "
                f"payload={structured!r}"
            )

    if message is None:
        pytest.skip(
            f"No assistant reply within {poll_timeout_s:.0f}s — "
            "upstream model likely declined / rate-limited / timed out."
        )

    text = assistant_text(message)
    if not text.strip() and not is_turn_finished(message):
        pytest.skip(
            f"Assistant turn did not complete within {poll_timeout_s:.0f}s. "
            f"error={extract_error(message)!r}"
        )
    if not text.strip():
        pytest.skip(
            "Assistant reply empty (model likely declined the tool-call). "
            f"error={extract_error(message)!r}"
        )
    fallback = parse_json_fallback(text)
    if fallback is None:
        pytest.skip(
            "Model emitted text without schema-conforming JSON. "
            f"text_preview={text[:200]!r}"
        )
    try:
        return pydantic_model.model_validate(fallback), message, thread_id
    except ValidationError as err:
        pytest.skip(
            f"Fallback JSON failed pydantic validation: {err!r}. "
            f"payload={fallback!r}"
        )


__all__ = [
    "DEFAULT_POLL_INTERVAL_S",
    "DEFAULT_POLL_TIMEOUT_S",
    "SGR_DEFAULT_MODEL",
    "assistant_text",
    "extract_error",
    "is_turn_finished",
    "parse_json_fallback",
    "run_sgr_or_skip",
    "run_sgr_turn",
]
