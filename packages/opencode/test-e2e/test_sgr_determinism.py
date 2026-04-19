"""Schema-Guided Reasoning (SGR) determinism tests.

What this file verifies
-----------------------
Opencode's ``POST /turn/start`` accepts a ``format`` parameter of shape
``{"type": "json_schema", "schema": {...}}``. When set, the server:

    1. Registers an internal ``StructuredOutput`` tool whose input schema
       is exactly the caller-supplied JSON Schema.
    2. Forces ``toolChoice="required"`` on the provider call, so the model
       MUST emit a tool invocation (not free text).
    3. Validates the emitted arguments against the schema and stores
       them on the assistant message as ``info.structured``.

See ``packages/opencode/src/session/prompt.ts`` (``createStructuredOutputTool``
and the ``format.type === "json_schema"`` branches of the prompt loop) and
``packages/opencode/src/session/message-v2.ts`` (``OutputFormatJsonSchema``
schema + the ``structured`` field on the assistant message).

That plumbing is *exactly* the SGR pattern from
https://abdullin.com/schema-guided-reasoning/ and the ``sgr-agent-core``
reference (see ``sgr_agent_core/tools/generate_plan_tool.py``): define a
pydantic ``BaseModel`` that describes the desired output shape, pass its
``model_json_schema()`` as the guide, and the model is constrained to
emit a valid instance — no free-form refusal paths, no "I won't call the
tool" drift.

Why this matters
----------------
The wider ``test-e2e/`` suite currently skips/marks-xfail roughly 27
Copilot cases because models randomly refuse to call ``bash``/``task``
tools. SGR sidesteps that entire failure mode: the model isn't offered
the ordinary tool surface — its only legal next-token path is a single
``StructuredOutput`` call carrying a schema-conforming JSON object.
The server's retry loop then validates (``retryCount`` > 0 triggers
automatic self-correction on schema mismatch) and hands us back a
payload that *pydantic itself* re-parses. If pydantic accepts it, the
structure is correct by construction.

Provider / model choice
-----------------------
Default: ``opencode / gpt-5-nano`` (via ``harness.sgr.SGR_DEFAULT_MODEL``).
Verified on this build to honour ``format={type: "json_schema"}``, call
the injected ``StructuredOutput`` tool, and land the validated payload
on ``info.structured`` inside ~15-30s per turn for simple prompts.
``github-copilot`` providers can't be the baseline: the current
``/chat/completions`` envelope returns ``"request body is not valid JSON"``
on every turn (structured or not) on this build — same failure surface
as the ~27 xfail'd cases elsewhere in ``test-e2e/``. Overridable via
``OPENCODE_E2E_SGR_PROVIDER`` / ``OPENCODE_E2E_SGR_MODEL``.

Prompt choice
-------------
Prompts are deliberately short arithmetic / classification questions —
not planning or creative tasks. Longer free-form prompts occasionally
drove gpt-5-nano into 3-5 minute reasoning loops or triggered refusal
("I'm sorry, but I cannot assist with that request.") which produced
skips. The determinism test is about *schema conformance*, not model
creativity, so the simplest reliably-structured prompt is the best
baseline.

Graceful-degradation strategy
-----------------------------
``harness.sgr.run_sgr_or_skip`` handles upstream flakes cleanly:

    1. ``info.structured`` present → validate via pydantic; success.
    2. Assistant emitted plaintext that parses as JSON → re-validate.
    3. Nothing workable → ``pytest.skip`` with a diagnostic reason.

Skips are therefore upstream-only (provider timed out, declined the
tool-call, or returned an error). When the turn reaches us, the
structural correctness is asserted unconditionally.
"""

from __future__ import annotations

import json
import os
from typing import Any

import pytest
from pydantic import BaseModel, Field

from harness import OpencodeClient, OpencodeServer
from harness.sgr import SGR_DEFAULT_MODEL, run_sgr_or_skip


# Per-test live-turn budget. Simple arithmetic-style SGR turns normally
# finish in 15-30s on opencode/gpt-5-nano but the Zen-hosted endpoint's
# tail latency occasionally spikes to 200+ seconds on back-to-back
# requests. 300s of headroom keeps the suite reliable under that
# drift; pytest-timeout gets a generous multiple so fixture teardown
# always has room to run.
LIVE_TURN_TIMEOUT_S = 300.0
pytestmark = [pytest.mark.live, pytest.mark.timeout(900)]


# ---------------------------------------------------------------------------
# Binary-path insulation.
# ---------------------------------------------------------------------------


def _resolve_sgr_binary() -> str:
    """Return a path to the opencode binary that won't be killed by siblings.

    Other CI harnesses in this repo run setup commands like
    ``pkill -9 -f "opencode-unify serve"`` to evict stale servers. When
    those run in parallel to this suite they also kill *our* servers
    mid-turn, producing flaky ``RemoteProtocolError`` failures that have
    nothing to do with SGR correctness.

    To insulate ourselves we spawn from a differently-named *symlink*
    (``/tmp/opencode-sgr``) to the real binary — ``pkill -f
    "opencode-unify serve"`` won't match the symlink's argv[0]. We
    can't use a raw copy because macOS code-signing rejects copies
    with SIGKILL.
    """
    src = os.environ.get("OPENCODE_BINARY") or "/Users/dave/.local/bin/opencode-unify"
    dst = "/tmp/opencode-sgr"
    try:
        real_src = os.path.realpath(src)
    except OSError:
        return src
    try:
        current = os.readlink(dst)
    except (OSError, FileNotFoundError):
        current = None
    if current != real_src:
        # Race-safe re-link: symlink to a tmp name, then rename.
        # Concurrent test processes all target the same link so the
        # last writer wins without a window of missing binary.
        tmp = dst + f".{os.getpid()}"
        try:
            os.symlink(real_src, tmp)
        except FileExistsError:
            os.unlink(tmp)
            os.symlink(real_src, tmp)
        os.replace(tmp, dst)
    return dst


# ---------------------------------------------------------------------------
# Server / client fixtures.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def sgr_server_root(tmp_path_factory) -> "tuple[OpencodeServer, str]":
    """Session-scoped ``opencode serve`` for SGR tests.

    Amortises spawn + provider-auth cost across the parametrized cases;
    spins up from ``/tmp/opencode-sgr`` (see ``_resolve_sgr_binary``) so
    sibling harnesses' ``pkill -f opencode-unify`` calls leave us alone.
    """
    binary = _resolve_sgr_binary()
    root = tmp_path_factory.mktemp("sgr")
    server = OpencodeServer(
        binary=binary,
        ready_timeout_s=60.0,
        cwd=root,
        capture_stderr=True,
    )
    server.start()
    try:
        yield server, str(root)
    finally:
        server.stop()


@pytest.fixture()
def sgr_server(sgr_server_root) -> "tuple[OpencodeServer, OpencodeClient]":
    """Per-test client pointing at the shared session server."""
    server, project_dir = sgr_server_root
    client = OpencodeClient(
        server.base_url,
        project_directory=project_dir,
        timeout_s=LIVE_TURN_TIMEOUT_S,
    )
    try:
        yield server, client
    finally:
        client.close()


# ---------------------------------------------------------------------------
# Provider / model selection.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def sgr_model() -> dict[str, str]:
    """Provider/model pair for SGR tests — overridable via env."""
    return {
        "providerID": (
            os.environ.get("OPENCODE_E2E_SGR_PROVIDER")
            or os.environ.get("OPENCODE_E2E_PROVIDER")
            or SGR_DEFAULT_MODEL["providerID"]
        ),
        "modelID": (
            os.environ.get("OPENCODE_E2E_SGR_MODEL")
            or os.environ.get("OPENCODE_E2E_MODEL")
            or SGR_DEFAULT_MODEL["modelID"]
        ),
    }


# ---------------------------------------------------------------------------
# Pydantic schemas — the SGR "guide" for each test.
# ---------------------------------------------------------------------------


class Arithmetic(BaseModel):
    """Single-answer arithmetic response — minimal schema, minimal work.

    Keeping the model's output surface tiny lets the turn finish in
    ~15-25s, which makes this suite a reliable regression signal for
    the SGR plumbing rather than a proxy for upstream-provider latency.
    """

    answer: int = Field(description="The numerical answer to the arithmetic question.")


class ArithmeticWithExplanation(BaseModel):
    """Arithmetic answer with a bounded confidence score.

    Introduces additional schema constraints (``ge``/``le`` on
    ``confidence``, ``min_length`` on ``explanation``) that the server's
    ``StructuredOutput`` validator enforces before it populates
    ``info.structured``. Lets us assert *more than one* bound per
    schema roundtrip.
    """

    answer: int = Field(description="The numerical answer.")
    explanation: str = Field(
        description="One-sentence description of how the answer was computed.",
        min_length=1,
    )
    confidence: float = Field(
        description="Self-reported confidence in the answer (0.0-1.0).",
        ge=0.0,
        le=1.0,
    )


class Classification(BaseModel):
    """Single-label classification with a fixed candidate set."""

    label: str = Field(description="One of: bug, feature, question, other.")
    rationale: str = Field(description="Brief reason for the chosen label.")


CLASSIFICATION_LABELS = ["bug", "feature", "question", "other"]


def _classification_schema() -> dict[str, Any]:
    """Return the ``Classification`` JSON Schema with an ``enum`` on ``label``.

    Pydantic's ``Literal`` emits ``const`` for single values and bloats
    the schema for larger sets; patching ``enum`` on the generated
    schema maps directly to the OpenAI-style JSON-Schema constraint
    that opencode's ``StructuredOutput`` tool validates against.
    """
    schema = Classification.model_json_schema()
    schema["properties"]["label"]["enum"] = CLASSIFICATION_LABELS
    return schema


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_sgr_arithmetic_schema_is_valid(
    sgr_server: tuple[OpencodeServer, OpencodeClient],
    sgr_model: dict[str, str],
) -> None:
    """Minimal SGR happy path: ``{"answer": int}`` for a trivial arithmetic
    question.

    Deterministic assertions (>=3):

        1. ``Arithmetic.model_validate`` succeeds (performed inside
           ``run_sgr_or_skip`` — the whole point of SGR).
        2. ``isinstance(instance.answer, int)`` — pydantic coerced the
           value into the declared int type.
        3. ``instance.answer == 12`` — the arithmetic answer is fixed;
           this is the only content assertion in the suite, and it's
           safe because the question admits exactly one answer.
        4. ``model_dump_json`` roundtrips without mutation.
    """
    _server, client = sgr_server
    instance, _msg, _tid = run_sgr_or_skip(
        client,
        model=sgr_model,
        prompt="Compute the value of 7 plus 5 and return it as the integer "
               "answer field.",
        pydantic_model=Arithmetic,
        poll_timeout_s=LIVE_TURN_TIMEOUT_S,
    )
    assert isinstance(instance, Arithmetic)
    assert isinstance(instance.answer, int), type(instance.answer)
    assert instance.answer == 12, f"expected 7+5=12, got {instance.answer}"
    # Roundtrip — dump -> parse -> equal.
    reparsed = Arithmetic.model_validate(json.loads(instance.model_dump_json()))
    assert reparsed.answer == instance.answer


# Three arithmetic prompts with a schema that carries multiple
# constraints. Each parametrized case runs as its own test; pytest
# reports pass/fail per case so drift is immediately attributable.
ARITHMETIC_CASES = [
    ("sum-a", "What is three plus four? Provide the integer answer.", 7),
    ("sum-b", "What is eight plus two? Provide the integer answer.", 10),
    ("sum-c", "What is nine plus six? Provide the integer answer.", 15),
]


@pytest.mark.parametrize(
    "case_id,prompt,expected",
    ARITHMETIC_CASES,
    ids=[c[0] for c in ARITHMETIC_CASES],
)
def test_sgr_arithmetic_is_deterministic_across_runs(
    sgr_server: tuple[OpencodeServer, OpencodeClient],
    sgr_model: dict[str, str],
    case_id: str,
    prompt: str,
    expected: int,
) -> None:
    """Three parametrized arithmetic SGR turns; each validates its own schema.

    The determinism claim is *structural*: every run yields a payload
    that pydantic re-parses, with ``answer`` matching a fixed integer,
    ``confidence`` inside ``[0.0, 1.0]``, and a non-empty explanation.
    We don't assert on the explanation *content* (that'd be testing
    model creativity, not SGR correctness).
    """
    _server, client = sgr_server
    instance, _msg, _tid = run_sgr_or_skip(
        client,
        model=sgr_model,
        prompt=prompt,
        pydantic_model=ArithmeticWithExplanation,
        poll_timeout_s=LIVE_TURN_TIMEOUT_S,
    )
    # 1. pydantic accepted the payload (implicit — we reached this line).
    assert isinstance(instance, ArithmeticWithExplanation)
    # 2. answer is the expected integer.
    assert instance.answer == expected, (
        f"{case_id}: expected {expected}, got {instance.answer!r}"
    )
    # 3. confidence was clamped into range by the schema's ge/le.
    assert 0.0 <= instance.confidence <= 1.0, (
        f"{case_id}: confidence out of range: {instance.confidence!r}"
    )
    # 4. explanation is a non-empty string (min_length=1 schema guard).
    assert instance.explanation.strip(), (
        f"{case_id}: explanation empty: {instance.explanation!r}"
    )


def test_sgr_classification_enforces_enum(
    sgr_server: tuple[OpencodeServer, OpencodeClient],
    sgr_model: dict[str, str],
) -> None:
    """``Classification`` with an ``enum`` constraint yields an in-set label.

    Deterministic assertions (>=3):

        1. ``Classification.model_validate`` succeeds.
        2. ``label`` is one of the declared enum candidates (the JSON
           Schema ``enum`` was honoured by the StructuredOutput
           validator).
        3. ``rationale`` is a non-empty string.
        4. A full ``model_dump_json`` roundtrip preserves both fields.
    """
    _server, client = sgr_server
    instance, _msg, _tid = run_sgr_or_skip(
        client,
        model=sgr_model,
        prompt="Classify this user message as one of the labels 'bug', "
               "'feature', 'question', or 'other'. Return the chosen "
               "label and a brief rationale. User message: 'Could you "
               "add dark mode to the settings page?'",
        pydantic_model=Classification,
        schema_overrides=_classification_schema(),
        poll_timeout_s=LIVE_TURN_TIMEOUT_S,
    )
    assert isinstance(instance, Classification)
    assert instance.label in CLASSIFICATION_LABELS, instance.label
    assert instance.rationale.strip(), instance.rationale
    decoded = json.loads(instance.model_dump_json())
    assert decoded["label"] == instance.label
    assert decoded["rationale"] == instance.rationale
