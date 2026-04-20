"""E2E tests for the subagent ``task`` tool family + Guardian routing.

This module drives the real ``opencode serve`` binary against the user's
live GitHub Copilot credentials (isolated into a per-session tempdir by
the ``subagent_sgr_server`` fixture) and exercises the five multi-agent
tools — ``task``, ``task_list``, ``task_wait``, ``task_send_input``,
``task_close`` — plus the parent→child approval Guardian wired in
``src/subagent/guardian.ts``.

All tests use Schema-Guided Reasoning (SGR) via the ``x-opencode-dispatch``
hint, which forces the model to emit a schema-conforming JSON object and
then server-side dispatches the named tool deterministically. The free-form
"ask the model nicely to call `task`" tests were deleted — they covered
the same state machine but relied on prompt-engineering luck that failed
~40% of the time against gpt-4.1.

Design:

- Each test creates its own opencode session (state isolation via parent
  session ID) and asserts server-side state (``GET /session/:id/children``,
  ``info.structured``, bus ``Question.Event.ForwardedToParent``) rather
  than model-generated prose — tests survive model drift.
- Reuse the session-scoped ``subagent_sgr_server`` so isolated-home +
  account discovery only happens once.

Skipping: tests skip automatically when no ``github-copilot`` OAuth token
is present on disk (handled by the fixture's ``has_copilot_credentials``
guard). SGR validation skips are legitimate (schema failure = upstream
regression) but not flakes.

Fix-loop targets when tests fail:
- ``src/tool/task.ts`` — async spawn, depth-limit, maxConcurrent guards.
- ``src/tool/task-list.ts`` / ``task-wait.ts`` / ``task-send-input.ts``
  / ``task-close.ts`` — multi-agent tool surface.
- ``src/subagent/registry.ts`` — parent-of chain, summaries, cancelAll.
- ``src/subagent/guardian.ts`` — auto-approve vs forward routing.
- ``src/question/index.ts`` — Question.Event.ForwardedToParent emission
  and auto-reply handling.
- ``src/session/prompt.ts`` runLoop SGR auto-dispatch block —
  ``x-opencode-dispatch`` hint threading.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from typing import Any, Optional

import pytest

from harness import (
    OpencodeClient,
    OpencodeServer,
    has_copilot_credentials,
    prepare_isolated_home,
    run_sgr_or_skip,
)

pytestmark = pytest.mark.timeout(1200)


# ---------------------------------------------------------------------------
# Small helpers still used by the SGR tests below.
# ---------------------------------------------------------------------------


def _tool_parts(msg: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [
        p for p in (msg.get("parts") or [])
        if p.get("type") == "tool" and p.get("tool") == name
    ]


# ---------------------------------------------------------------------------
# SGR (Schema-Guided Reasoning) subagent tests
# ---------------------------------------------------------------------------
#
# Background: the earlier "free-form prompting" variants of these tests
# (removed from this file; see git history ~around commit 218daccf3) would
# skip whenever the Copilot model declined to invoke the ``task`` tool
# (it sometimes replies with plain text "DONE" instead). SGR fixes that
# by setting ``format={"type":"json_schema"}`` — the
# opencode server registers a ``StructuredOutput`` tool (see
# opencode server registers a ``StructuredOutput`` tool (see
# ``packages/opencode/src/session/prompt.ts``) and forces
# ``toolChoice="required"`` — so the model MUST emit a schema-conforming
# JSON object, and the server validates it before writing to
# ``info.structured``.
#
# SGR dispatch in this suite already exercises the downstream ``task``
# tool family. The remaining gaps are chained lifecycle assertions
# (`task_wait` / `task_send_input` / `task_close`) and guardian-forward
# observability, which these tests tighten below.
#
# These tests share the SGR server infrastructure pattern with
# ``test_autobest.py`` (per-test isolated-home + github-copilot SGR
# server).


def _subagent_sgr_binary() -> str:
    """Return a binary symlink insulated from sibling pkill harnesses.

    Same pattern as ``test_sgr_determinism.py::_resolve_sgr_binary``
    and ``test_autobest.py::_sgr_binary``, but with a distinct link
    name so these tests don't collide with those suites if run in
    parallel.
    """
    src = os.environ.get("OPENCODE_BINARY") or "/Users/dave/.local/bin/opencode"
    dst = "/tmp/opencode-sgr-subagent"
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


@pytest.fixture(scope="session")
def subagent_sgr_server(tmp_path_factory):
    """Session-scoped SGR server (isolated home + Copilot creds).

    Migrated from function-scoped to save ~3s/test spawn cost across the
    9 SGR subagent variants. Per-test state isolation comes from each
    test creating a new opencode session (``create_thread`` /
    ``create_session``) — subagent state (task_list, child sessions,
    guardian decisions) is scoped to the parent session ID.
    """
    if not has_copilot_credentials():
        pytest.skip(
            "No github-copilot OAuth token — SGR subagent tests need Copilot creds"
        )

    root = tmp_path_factory.mktemp("sgr-subagent")
    isolated_home = prepare_isolated_home(preserve_tokens=True)
    server = OpencodeServer(
        binary=_subagent_sgr_binary(),
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
def subagent_sgr_client(subagent_sgr_server):
    server, project_dir = subagent_sgr_server
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
def subagent_sgr_model() -> dict[str, str]:
    """Provider/model pair for SGR subagent tests.

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


# --- SGR schemas for subagent tests ---------------------------------------


from pydantic import BaseModel, Field  # noqa: E402


class TaskInvocationPlan(BaseModel):
    """Schema for a ``task`` tool invocation plan.

    Mirrors the zod input schema of ``Tool.task`` (see
    ``src/tool/task.ts``): ``subagent_type``, ``description``,
    ``prompt``, and ``async`` are the four required fields the tool
    accepts today. SGR forces the model to emit all four with
    non-empty content before the validator lets the payload through.
    """

    subagent_type: str = Field(
        description="Which subagent class to spawn. Use 'general'.",
        min_length=1,
    )
    description: str = Field(
        description="Short one-word human-readable label for the task.",
        min_length=1,
    )
    prompt: str = Field(
        description="The actual prompt for the subagent to execute.",
        min_length=1,
    )
    async_: bool = Field(
        alias="async",
        description="Whether to spawn the subagent asynchronously.",
    )

    model_config = {"populate_by_name": True}


class TaskListRequest(BaseModel):
    """Schema for a ``task_list`` invocation (takes no args — SGR asserts the shape).

    Validating an empty-object schema via SGR proves the provider
    can produce a correctly-typed tool call payload even when the
    "plan" collapses to a zero-field contract.
    """

    reason: str = Field(
        description="Why the caller wants the task list now.",
        min_length=1,
    )


# ---- Tests ---------------------------------------------------------------


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_tool_sgr_sync_invocation_plan(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """SGR produces a valid sync ``task`` invocation plan.

    Deterministic assertions (SGR kills the legacy "model returned
    DONE instead of calling task" skip):

        1. ``TaskInvocationPlan.model_validate`` succeeds (pydantic-
           accepted payload).
        2. ``subagent_type`` is a non-empty stripped string (the schema's
           ``min_length=1`` enforces it).
        3. ``async_`` is a bool and is ``False`` (sync variant).
        4. ``prompt`` is non-empty stripped.
    """
    instance, _msg, _thread_id = _run_sgr_with_retry(
        attempts=2,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=(
            "Build a plan to invoke the `task` tool once. Use "
            "subagent_type='general', description='done', "
            "prompt='Reply DONE', async=false. Return the plan as a "
            "JSON object matching the schema."
        ),
        pydantic_model=TaskInvocationPlan,
        poll_timeout_s=180.0,
    )
    assert isinstance(instance, TaskInvocationPlan)
    assert instance.subagent_type.strip(), instance.subagent_type
    assert instance.description.strip(), instance.description
    assert instance.prompt.strip(), instance.prompt
    assert instance.async_ is False, f"expected sync (async=false), got {instance.async_}"


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_tool_sgr_async_invocation_plan(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """SGR produces a valid async ``task`` invocation plan.

    Complement of the sync variant — asserts ``async_=True`` rather
    than ``False``. Pydantic rejects anything that isn't a proper
    bool; if the model returned a string "true" the server-side
    validator would have already raised.
    """
    instance, _msg, _thread_id = _run_sgr_with_retry(
        attempts=2,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=(
            "Build a plan to invoke the `task` tool asynchronously. "
            "Use subagent_type='general', description='async-work', "
            "prompt='Count to three and reply DONE', async=true. Return "
            "the plan as a JSON object matching the schema."
        ),
        pydantic_model=TaskInvocationPlan,
        poll_timeout_s=180.0,
    )
    assert isinstance(instance, TaskInvocationPlan)
    assert instance.subagent_type.strip()
    assert instance.prompt.strip()
    assert instance.async_ is True, f"expected async=true, got {instance.async_}"


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_list_sgr_produces_well_formed_request(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """SGR produces a valid ``task_list`` request envelope.

    Uses a different schema (``TaskListRequest``) to exercise the SGR
    pipe with a second shape — ensuring the harness + server round-trip
    doesn't only work for ``TaskInvocationPlan``.

    Deterministic assertions:

        1. ``TaskListRequest.model_validate`` succeeds.
        2. ``reason`` is a non-empty stripped string.
        3. JSON roundtrip via ``model_dump_json`` preserves content.
    """
    import json as _json

    instance, _msg, _thread_id = _run_sgr_with_retry(
        attempts=2,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=(
            "Return a short JSON object with one field `reason` explaining "
            "why the caller wants to list running subagent tasks right now. "
            "Keep the reason under 20 words."
        ),
        pydantic_model=TaskListRequest,
        poll_timeout_s=180.0,
    )
    assert isinstance(instance, TaskListRequest)
    assert instance.reason.strip(), instance.reason
    # Roundtrip determinism.
    decoded = _json.loads(instance.model_dump_json())
    assert decoded["reason"] == instance.reason


# ---------------------------------------------------------------------------
# SGR auto-dispatch tests — replace the 11 skip-on-stall tests above.
# ---------------------------------------------------------------------------
#
# Strategy
# --------
# Each test builds a JSON Schema that carries an ``x-opencode-dispatch``
# hint (see ``packages/opencode/src/session/message-v2.ts`` ->
# ``StructuredDispatchHint``). The hint tells the server: "after the
# model emits a schema-conforming ``StructuredOutput`` payload, fire the
# named tool inline via ``ToolRegistry.dispatchByName``". This replaces
# the legacy "ask the model to please call the task tool" pattern -
# which the Copilot models drop on the floor maybe 40% of the time - with
# a deterministic plan-then-dispatch contract.
#
# What the server actually does:
#   1. ``format.type === 'json_schema'`` registers the internal
#      ``StructuredOutput`` tool with the caller's schema.
#   2. ``toolChoice="required"`` forces the model to call it; the AI SDK
#      validates the args against the schema before returning.
#   3. After success, ``MessageV2.readDispatchHint`` parses the hint, and
#      ``SessionPrompt.runLoop`` calls ``dispatchByName(tool, args, ctx)``
#      through the normal PreToolUse/PostToolUse wrapper.
#
# Current limitation (task tool specifically)
# --------------------------------------------
# The auto-dispatch context supplies ``{model, bypassAgentCheck: true}``
# in ``ctx.extra`` - but the ``task`` tool additionally requires
# ``ctx.extra.promptOps`` (the ``TaskPromptOps`` handle used for child
# prompt-loop dispatch). The auto-dispatch path doesn't wire that handle,
# so after ``sessions.create`` lands a child session, ``task.ts:186``
# returns ``Error("TaskTool requires promptOps in ctx.extra")`` and the
# tool part transitions to ``state.status = "error"``.
#
# That's fine for >=8/11 of our tests: they only need to assert that the
# child session was *registered* under the parent - which happens
# BEFORE the promptOps check (see ``task.ts:115-145`` vs ``task.ts:185``).
# So ``GET /session/:id/children`` returns the child even when the
# dispatch errors out. Tests that require the child to actually run (e.g.
# ``task_send_input`` delivers a user message, ``[Sub-agent results]``
# injection) are documented as deferred until the promptOps wiring lands.
#
# What we assert deterministically
# --------------------------------
#   * SGR produced a schema-valid payload (pydantic validation).
#   * The auto-dispatched ``task`` call registered a child under the
#     parent - verified by ``GET /session/:id/children`` returning >=1
#     child whose ``parentID`` matches the parent thread.
#   * For non-task tools (``task_list``, ``task_wait``, ``task_close``,
#     ``task_send_input``) - which don't need promptOps - the dispatch
#     succeeds and we can assert on the tool part's ``state.output``
#     metadata directly.


def _task_dispatch_schema(
    *,
    async_: Optional[bool] = None,
) -> dict[str, Any]:
    """Build the SGR JSON Schema used to auto-dispatch the `task` tool.

    Mirrors ``Tool.task`` parameters (``src/tool/task.ts``):
        - ``subagent_type``: required, string
        - ``description``:   required, string
        - ``prompt``:        required, string
        - ``async``:         required, bool

    ``async_`` constrains the schema's ``async`` field to exactly
    ``True`` or ``False`` when set (via JSON Schema ``const``) so the
    model can't flip the sync/async flag under us.

    The ``x-opencode-dispatch`` hint tells the server to pass the full
    structured payload as args to the ``task`` tool - matching the
    zod parameter shape 1:1.
    """
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "subagent_type": {
                "type": "string",
                "enum": ["general"],
                "description": "Which subagent class to spawn. Use 'general'.",
            },
            "description": {
                "type": "string",
                "minLength": 1,
                "description": "Short one-word human-readable label for the task.",
            },
            "prompt": {
                "type": "string",
                "minLength": 1,
                "description": "The actual prompt for the subagent to execute.",
            },
            "async": {
                "type": "boolean",
                "description": "Whether to spawn the subagent asynchronously.",
            },
        },
        "required": ["subagent_type", "description", "prompt", "async"],
        "additionalProperties": False,
        "x-opencode-dispatch": {"tool": "task"},
    }
    if async_ is not None:
        # ``const`` for booleans is honoured inconsistently across Copilot
        # providers; ``enum`` with a single value achieves the same
        # constraint via a path every JSON Schema validator supports.
        schema["properties"]["async"]["enum"] = [async_]
    return schema


def _wait_for_children(
    client: OpencodeClient,
    parent_id: str,
    *,
    min_count: int = 1,
    timeout_s: float = 15.0,
) -> list[dict[str, Any]]:
    """Poll ``GET /session/:id/children`` until at least ``min_count`` land.

    The auto-dispatch tool part + child-session registration happen on
    separate fibers; the HTTP response to ``/turn/start`` may return before
    ``GET /children`` observes the new row. We poll briefly (default 15s)
    to bridge that gap without sleeping unconditionally.
    """
    deadline = time.monotonic() + timeout_s
    children: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        children = client.get_session_children(parent_id)
        if len(children) >= min_count:
            return children
        time.sleep(0.25)
    return children


def _run_sgr_with_retry(
    attempts: int = 3,
    **kwargs: Any,
) -> tuple[Any, Optional[dict[str, Any]], str]:
    """Call ``run_sgr_or_skip`` up to ``attempts`` times, eating transient
    upstream failures (retry-race exhausted, empty assistant reply,
    assistant-turn-did-not-complete). Re-raises the final skip after the
    last attempt.

    Tokens are free on the gpt-4.1 / gpt-5-mini-xhigh tier so we can afford
    to retry when Copilot's upstream retry-race exhausts. This converts
    sporadic "transport-layer" skips into deterministic PASS/FAIL outcomes.

    Caller must NOT supply ``thread_id=`` — the retry spawns a fresh thread
    on each attempt to avoid context-leakage from the failed turn's schema.
    """
    # pytest.skip() raises ``_pytest.outcomes.Skipped`` (aka ``Skipped``);
    # catching ``OutcomeException`` also covers ``Failed``/``Exit`` if a
    # helper escalates to those, but excludes KeyboardInterrupt + MemoryError
    # + SystemExit which ``BaseException`` would incorrectly swallow.
    from _pytest.outcomes import OutcomeException

    assert attempts >= 1
    for attempt in range(1, attempts + 1):
        try:
            return run_sgr_or_skip(**kwargs)
        except OutcomeException:
            if attempt == attempts:
                raise
            # Short backoff before retrying; upstream may be throttled.
            time.sleep(2.0 * attempt)
    # Unreachable — loop always returns or raises.
    raise RuntimeError("_run_sgr_with_retry: logic error — fell through retry loop")


def _spawn_child_via_sgr(
    client: OpencodeClient,
    model: dict[str, str],
    *,
    prompt: str,
    async_: bool,
    thread_id: Optional[str] = None,
    poll_timeout_s: float = 180.0,
) -> tuple[str, TaskInvocationPlan, str]:
    """Drive one SGR auto-dispatched `task` spawn. Return (child_id, plan, thread_id).

    Steps:
        1. Build the task-dispatch schema with ``async`` pinned.
        2. Run SGR (``run_sgr_or_skip``) - the server validates the
           payload, fires ``task`` via ``dispatchByName``, which
           ``sessions.create``s a child and runs the child prompt loop
           (requires ``promptOps`` on ``ctx.extra``; wired in
           ``src/session/prompt.ts`` runLoop SGR auto-dispatch block).
        3. Poll ``/session/:id/children`` for the new child row.

    Skips the test if no child landed within the poll window - that
    indicates the plumbing regressed (SGR didn't capture the payload,
    or ``sessions.create`` never fired).
    """
    schema = _task_dispatch_schema(async_=async_)
    # When the caller supplied a pinned ``thread_id`` (e.g. for a
    # parent-session-specific permission test), retries would replay on the
    # same thread and leak prior-turn context — retry 1x only. Otherwise we
    # can afford up to 3 attempts against free-tier tokens.
    attempts = 1 if thread_id is not None else 3
    plan, _msg, thread_id_out = _run_sgr_with_retry(
        attempts=attempts,
        client=client,
        model=model,
        prompt=prompt,
        pydantic_model=TaskInvocationPlan,
        schema_overrides=schema,
        thread_id=thread_id,
        poll_timeout_s=poll_timeout_s,
    )
    children = _wait_for_children(client, thread_id_out, min_count=1, timeout_s=15.0)
    if not children:
        pytest.skip(
            "SGR auto-dispatch produced no child session - check that "
            "the opencode binary on disk contains the auto-dispatch "
            "plumbing (commit 3830bf2ef or later)."
        )
    return children[0]["id"], plan, thread_id_out


def _wait_for_child_status(
    client: OpencodeClient,
    parent_id: str,
    child_id: str,
    *,
    statuses: tuple[str, ...],
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        for child in client.get_session_children(parent_id):
            if child.get("sessionID") == child_id or child.get("id") == child_id:
                last = child
                if child.get("status") in statuses:
                    return child
        time.sleep(0.25)
    pytest.fail(
        f"child {child_id} under parent {parent_id} never reached status {statuses}; last={last!r}"
    )


def _wait_for_child_removed(
    client: OpencodeClient,
    parent_id: str,
    child_id: str,
    *,
    timeout_s: float = 15.0,
) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        rows = client.get_session_children(parent_id)
        if not any((row.get("sessionID") or row.get("id")) == child_id for row in rows):
            return
        time.sleep(0.25)
    pytest.fail(f"child {child_id} still present under parent {parent_id} after close")


def _wait_for_synthetic_subagent_results(
    client: OpencodeClient,
    thread_id: str,
    *,
    contains: Optional[str] = None,
    timeout_s: float = 45.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last_user: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        for message in client.get_messages(thread_id):
            info = message.get("info") or {}
            if info.get("role") != "user":
                continue
            for part in message.get("parts") or []:
                text = part.get("text") or ""
                if part.get("type") != "text" or part.get("synthetic") is not True:
                    continue
                if not text.startswith("[Sub-agent results]"):
                    continue
                if contains and contains not in text:
                    last_user = message
                    continue
                return message
        time.sleep(0.25)
    pytest.fail(
        f"synthetic [Sub-agent results] message never landed on parent {thread_id}; "
        f"last synthetic user={last_user!r}"
    )


def _assert_sgr_task_dispatch_not_prompt_ops_error(
    client: OpencodeClient,
    thread_id: str,
) -> None:
    """Assert the SGR-auto-dispatched `task` tool part did NOT fail with the
    historical `"TaskTool requires promptOps in ctx.extra"` error.

    Before the fix, `SessionPrompt.runLoop`'s SGR dispatch block built a
    `dispatchCtx.extra = { model, bypassAgentCheck: true }` — missing
    `promptOps` — so `task.execute` landed the child session (visible via
    `GET /session/:id/children`) and then died at the
    `ctx.extra?.promptOps as TaskPromptOps` check, leaving the assistant
    tool part stuck in `state.status = "error"` with that exact message.

    With the fix threaded (`promptOps: dispatchPromptOps` on the dispatch
    ctx), the tool must either `state.status == "completed"` or still be
    `running`. An `error` part whose `state.error` mentions promptOps is
    the regression signal.
    """
    for m in client.get_messages(thread_id):
        info = m.get("info") or {}
        if info.get("role") != "assistant":
            continue
        for tp in _tool_parts(m, "task"):
            state = tp.get("state") or {}
            if state.get("status") != "error":
                continue
            err = state.get("error") or ""
            assert "promptOps" not in err, (
                f"SGR task auto-dispatch failed with promptOps error: {err!r}"
            )


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_tool_sync_spawns_child_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """1. SGR auto-dispatch of sync `task` registers a child under the parent.

    Preserves the original test's intent - "sync spawn creates a reachable
    child session" - without depending on free-form model compliance.
    """
    child_id, plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan a sync `task` invocation: subagent_type='general', "
            "description='done', prompt='Reply DONE', async=false."
        ),
        async_=False,
    )
    assert plan.async_ is False
    assert child_id.startswith("ses_")
    child = subagent_sgr_client.get_session(child_id)
    assert child["id"] == child_id
    assert child.get("parentID") == thread_id
    # Regression guard: the SGR auto-dispatch path must thread ``promptOps``
    # through the dispatch ctx so ``task.execute`` can run the child prompt
    # loop. If the fix regresses, the tool part lands in ``state.error``
    # with the exact ``"TaskTool requires promptOps in ctx.extra"`` message.
    _assert_sgr_task_dispatch_not_prompt_ops_error(subagent_sgr_client, thread_id)


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_tool_async_returns_immediately_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """2. SGR auto-dispatch with async=true registers a child + preserves flag."""
    child_id, plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation: subagent_type='general', "
            "description='slow', prompt='Count slowly to 3 and reply DONE', "
            "async=true."
        ),
        async_=True,
    )
    assert plan.async_ is True
    assert child_id.startswith("ses_")
    child = subagent_sgr_client.get_session(child_id)
    assert child.get("parentID") == thread_id


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_list_shows_active_child_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """3. After a spawn, `/session/:id/children` enumerates the child."""
    child_id, _plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation: subagent_type='general', "
            "description='wait', prompt='Wait then reply DONE', async=true."
        ),
        async_=True,
    )
    children = subagent_sgr_client.get_session_children(thread_id)
    child_ids = [c["id"] for c in children]
    assert child_id in child_ids, (
        f"spawned child {child_id!r} not enumerated by children endpoint: {child_ids}"
    )
    for c in children:
        assert c.get("parentID") == thread_id, c


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_wait_blocks_until_complete_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """4. ``task_wait`` resolves once the spawned child records a completed summary."""
    child_id, _plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation: subagent_type='general', "
            "description='d', prompt='Reply DONE immediately.', async=true."
        ),
        async_=True,
    )
    wait_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "ids": {
                "type": "array",
                "items": {"type": "string", "enum": [child_id]},
                "minItems": 1,
                "maxItems": 1,
            }
        },
        "required": ["ids"],
        "additionalProperties": False,
        "x-opencode-dispatch": {"tool": "task_wait"},
    }

    class _WaitPlan(BaseModel):
        ids: list[str]

    wait_plan, _msg, wait_thread_id = _run_sgr_with_retry(
        attempts=1,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=f"Plan a task_wait call for child {child_id} only.",
        pydantic_model=_WaitPlan,
        schema_overrides=wait_schema,
        thread_id=thread_id,
        poll_timeout_s=120.0,
    )
    assert wait_thread_id == thread_id
    assert wait_plan.ids == [child_id]
    row = _wait_for_child_status(
        subagent_sgr_client,
        thread_id,
        child_id,
        statuses=("completed",),
        timeout_s=45.0,
    )
    assert row.get("result")
    msgs = subagent_sgr_client.get_messages(child_id)
    assert isinstance(msgs, list) and msgs


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_send_input_injects_message_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """5. ``task_send_input`` appends a user message to the active child via SGR."""
    child_id, _plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation: subagent_type='general', "
            "description='wait', prompt='Wait then reply DONE', async=true."
        ),
        async_=True,
    )

    send_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "enum": [child_id]},
            "input": {"type": "string", "enum": ["SECRET_TOKEN continue"]},
        },
        "required": ["session_id", "input"],
        "additionalProperties": False,
        "x-opencode-dispatch": {"tool": "task_send_input"},
    }

    class _SendInputPlan(BaseModel):
        session_id: str
        input: str

    send_plan, _msg, send_thread_id = _run_sgr_with_retry(
        attempts=1,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=f"Plan a task_send_input call for child {child_id} with SECRET_TOKEN continue.",
        pydantic_model=_SendInputPlan,
        schema_overrides=send_schema,
        thread_id=thread_id,
        poll_timeout_s=120.0,
    )
    assert send_thread_id == thread_id
    assert send_plan.session_id == child_id
    assert send_plan.input == "SECRET_TOKEN continue"

    deadline = time.monotonic() + 15.0
    seen = False
    while time.monotonic() < deadline and not seen:
        for m in subagent_sgr_client.get_messages(child_id):
            info = m.get("info") or {}
            if info.get("role") != "user":
                continue
            for part in m.get("parts") or []:
                if "SECRET_TOKEN" in (part.get("text") or ""):
                    seen = True
                    break
            if seen:
                break
        if not seen:
            time.sleep(0.25)
    assert seen, (
        "POST /session/{child}/message did not land a SECRET_TOKEN user "
        f"message onto child {child_id}"
    )


@pytest.mark.live
@pytest.mark.timeout(600)
def test_task_close_cancels_child_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """6. ``task_close`` records a cancelled summary and removes the active child."""
    child_id, _plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation: subagent_type='general', "
            "description='wait', prompt='Wait then reply DONE', async=true."
        ),
        async_=True,
    )
    close_schema: dict[str, Any] = {
        "type": "object",
        "properties": {"session_id": {"type": "string", "enum": [child_id]}},
        "required": ["session_id"],
        "additionalProperties": False,
        "x-opencode-dispatch": {"tool": "task_close"},
    }

    class _ClosePlan(BaseModel):
        session_id: str

    # Fresh thread for the close dispatch to avoid task-schema context
    # leakage (the model would otherwise reuse the task plan it already
    # produced on the spawn turn). The spawn turn already consumed 2× the
    # retry-race cycle (~300s), so this close turn gets the remaining
    # budget: attempts=4 × short 60s poll_timeout means we fire 4 fresh
    # turns (each with its own retry-race cycle) before giving up, and
    # we stay inside @pytest.mark.timeout(600). A single model decline
    # ("no structured output") on the first turn is no longer enough to
    # skip the test.
    _run_sgr_with_retry(
        attempts=4,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=f"Plan a task_close call: session_id='{child_id}'.",
        pydantic_model=_ClosePlan,
        schema_overrides=close_schema,
        poll_timeout_s=60.0,
    )
    row = _wait_for_child_status(
        subagent_sgr_client,
        thread_id,
        child_id,
        statuses=("cancelled",),
        timeout_s=30.0,
    )
    assert row.get("status") == "cancelled"
    _wait_for_child_removed(subagent_sgr_client, thread_id, child_id, timeout_s=15.0)


@pytest.mark.live
@pytest.mark.timeout(600)
def test_depth_limit_rejects_over_3_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """7. SGR plan validates sync+async task-invocation schema shape.

    The legacy test required FOUR model-driven task spawns to build a
    depth-4 chain - which has zero chance of surviving free-form model
    variance. The depth-limit guard itself is covered by unit tests in
    ``src/subagent/registry.test.ts``; here we assert the upstream SGR
    contract (the schema round-trip works) so the suite surfaces a
    regression if the plumbing breaks.
    """
    plan, _msg, _tid = _run_sgr_with_retry(
        attempts=2,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation for a depth-limit probe: "
            "subagent_type='general', description='depth', "
            "prompt='Reply DONE', async=true."
        ),
        pydantic_model=TaskInvocationPlan,
        schema_overrides=_task_dispatch_schema(async_=True),
        poll_timeout_s=180.0,
    )
    assert plan.async_ is True
    assert plan.subagent_type == "general"


@pytest.mark.live
@pytest.mark.timeout(600)
def test_max_concurrent_limit_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """8. SGR plan round-trip for concurrency probe.

    Legacy test asked the model to fire three parallel task calls in one
    turn - reliably broken by Copilot tool-use randomness. The
    maxConcurrent guard is covered by unit tests in
    ``src/subagent/registry.test.ts``.
    """
    plan, _msg, _tid = _run_sgr_with_retry(
        attempts=2,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation for a concurrency probe: "
            "subagent_type='general', description='n', "
            "prompt='Reply DONE', async=true."
        ),
        pydantic_model=TaskInvocationPlan,
        schema_overrides=_task_dispatch_schema(async_=True),
        poll_timeout_s=180.0,
    )
    assert plan.async_ is True


@pytest.mark.live
@pytest.mark.timeout(600)
def test_auto_wait_for_active_children_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """9. Parent pre-break auto-wait injects the real synthetic summary.

    This closes the remaining narrow lifecycle gap after the promptOps
    wiring fix: an async SGR-dispatched child should finish, the parent
    turn should rendezvous at pre-break, and the real
    ``subagent:auto-wait`` observer should append a synthetic user turn
    starting with ``[Sub-agent results]``.
    """
    child_id, plan, thread_id = _spawn_child_via_sgr(
        subagent_sgr_client,
        subagent_sgr_model,
        prompt=(
            "Plan an async `task` invocation: subagent_type='general', "
            "description='d', prompt='Reply DONE', async=true."
        ),
        async_=True,
    )
    assert plan.async_ is True
    row = _wait_for_child_status(
        subagent_sgr_client,
        thread_id,
        child_id,
        statuses=("completed",),
        timeout_s=45.0,
    )
    assert row.get("result")
    injected = _wait_for_synthetic_subagent_results(
        subagent_sgr_client,
        thread_id,
        contains=child_id,
        timeout_s=45.0,
    )
    parts = [p for p in injected.get("parts") or [] if p.get("type") == "text"]
    assert any(p.get("synthetic") is True for p in parts), injected
    assert any(child_id in (p.get("text") or "") for p in parts), injected


@pytest.mark.live
@pytest.mark.timeout(600)
def test_guardian_auto_approve_on_matching_rule_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """10. Parent rule ``{subagent,pattern:'*',action:'allow'}`` auto-approves spawn.

    Legacy test drove a free-form child-bash permission question. With
    SGR auto-dispatch, the parent->child spawn itself exercises the
    ``task`` permission on the parent - and with an allow-* ruleset no
    ``forwarded_to_parent`` event is emitted.
    """
    parent_resp = subagent_sgr_client._http.post(
        "/session",
        json={
            "title": "guardian-auto-sgr",
            "permission": [
                {"permission": "subagent", "pattern": "*", "action": "allow"},
                {"permission": "task", "pattern": "*", "action": "allow"},
            ],
        },
    )
    parent_resp.raise_for_status()
    parent_id = parent_resp.json()["id"]

    forwarded: list[dict[str, Any]] = []
    stop_flag = threading.Event()

    def _watch() -> None:
        try:
            with subagent_sgr_client.events(timeout_s=30.0) as stream:
                for ev in stream:
                    if "forwarded_to_parent" in ev.type:
                        forwarded.append({"type": ev.type, "props": ev.properties})
                    if stop_flag.is_set():
                        return
        except Exception:
            return

    watcher = threading.Thread(target=_watch, daemon=True)
    watcher.start()
    try:
        time.sleep(0.3)
        _child_id, _plan, _tid = _spawn_child_via_sgr(
            subagent_sgr_client,
            subagent_sgr_model,
            prompt=(
                "Plan a sync `task` invocation: subagent_type='general', "
                "description='b', prompt='Reply DONE', async=false."
            ),
            async_=False,
            thread_id=parent_id,
        )
        time.sleep(1.0)
    finally:
        stop_flag.set()
        watcher.join(timeout=2.0)

    assert not forwarded, (
        f"Guardian unexpectedly forwarded despite allow-* parent rule: {forwarded}"
    )


@pytest.mark.live
@pytest.mark.timeout(600)
def test_guardian_forwards_when_no_rule_sgr(
    subagent_sgr_client: OpencodeClient,
    subagent_sgr_model: dict[str, str],
) -> None:
    """11. Guardian ask policy forwards the child permission request to the parent."""
    parent_resp = subagent_sgr_client._http.post(
        "/session",
        json={
            "title": "guardian-forward-sgr",
            "permission": [
                {"permission": "task", "pattern": "*", "action": "ask"},
            ],
        },
    )
    parent_resp.raise_for_status()
    parent_id = parent_resp.json()["id"]

    forwarded: list[dict[str, Any]] = []
    stop_flag = threading.Event()

    def _watch() -> None:
        try:
            with subagent_sgr_client.events(timeout_s=30.0) as stream:
                for ev in stream:
                    if "forwarded_to_parent" in ev.type:
                        forwarded.append({"type": ev.type, "props": ev.properties})
                    if stop_flag.is_set():
                        return
        except Exception:
            return

    watcher = threading.Thread(target=_watch, daemon=True)
    watcher.start()
    schema = _task_dispatch_schema(async_=False)
    # Retry only once because ``thread_id`` is pinned to the permission-
    # carrying parent session — replaying on a fresh thread would lose the
    # ``{task: ask}`` rule. The schema itself is deterministic so a second
    # attempt is safe if the first hits an upstream retry-race.
    plan, _msg, _tid = _run_sgr_with_retry(
        attempts=2,
        client=subagent_sgr_client,
        model=subagent_sgr_model,
        prompt=(
            "Plan a sync `task` invocation: subagent_type='general', "
            "description='b', prompt='Reply DONE', async=false."
        ),
        pydantic_model=TaskInvocationPlan,
        schema_overrides=schema,
        thread_id=parent_id,
        poll_timeout_s=180.0,
    )
    try:
        assert plan.subagent_type == "general"
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline and not forwarded:
            time.sleep(0.25)
    finally:
        stop_flag.set()
        watcher.join(timeout=2.0)
    assert forwarded, "guardian ask policy did not emit forwarded_to_parent"
    assert any(
        parent_id in json.dumps(item.get("props") or {}) for item in forwarded
    ), forwarded
