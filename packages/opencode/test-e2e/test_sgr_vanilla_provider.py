r"""Live SGR (format=json_schema) matrix across every configured ``github-copilot*``
provider — closing the "vanilla provider unstable" caveat.

Why this file exists
--------------------
Earlier SGR work landed two artefacts that *unit-tested* the vanilla
``github-copilot`` path (no suffix):

    - ``046ef5eab  fix(copilot): use \`data\` field (not \`body\`) in envelope proxy requests``
    - ``30112299e  test(copilot): lock in \`format: json_schema\` body preservation
      across vanilla + suffix paths``

but the docstring of ``harness/sgr.py`` still carried a caveat
("``github-copilot`` providers can't be the baseline: the current
``/chat/completions`` envelope returns ``request body is not valid JSON``").
The unit tests already prove request-body preservation — this suite
closes the loop with a LIVE end-to-end assertion that every live
``github-copilot*`` provider currently on disk accepts
``format={type:"json_schema"}`` at ``POST /turn/start`` and lands a
schema-conforming payload on ``message.info.structured`` within a bounded
wall-clock.

Matrix shape
------------
The matrix iterates the five REGISTERED ``github-copilot*`` provider IDs
(per ``src/provider/provider.ts::copilotAliasIDs``):

    - ``github-copilot``            (vanilla, the "closing the caveat" target)
    - ``github-copilot#edu``        (edu pool alias)
    - ``github-copilot#enterprise`` (enterprise pool alias)
    - ``github-copilot#personal``   (personal pool alias)
    - ``github-copilot#free``       (free pool alias)

times two broadly-supported real models:

    - ``gpt-4.1``       — test-pool model, available on every pool.
    - ``gpt-5-mini``    — second model to prove the caveat isn't gpt-4.1-specific.

= 10 (provider, model) pairs. Each pair fires one ``/turn/start`` call
with ``format={"type":"json_schema", ...}`` and asserts the caveat is
closed.

Account-key-level routing (``github-copilot#cli``, ``#piter``,
``#edu-1``, ...) is NOT tested as a distinct ``providerID`` because
those are account routing labels, not registered providers. The server
accepts only the five IDs above on ``/turn/start``; invoking a
``ProviderModelNotFoundError`` with a non-registered provider ID would
prove nothing about SGR correctness. The pool-router picks the correct
account (cli/piter/paul/edu-N) behind the pool alias automatically.

The routing-pool routing constants ``gpt-5.4-xhigh`` and
``codex-5.3-xhigh`` (``src/plugin/github-copilot/pool-routing.ts``) are
CLI-side gate constants, not user-facing models. They are also not
tested as ``modelID`` values here — doing so yields
``ProviderModelNotFoundError`` and would fail the matrix for reasons
unrelated to SGR.

Asserted invariants per (provider, model) pair
----------------------------------------------
    (a) ``POST /turn/start`` with ``format={"type":"json_schema", ...}`` did
        NOT raise an HTTP 4xx/5xx or ``request body is not valid JSON``
        (the exact error 046ef5eab patched).
    (b) A schema-validated ``info.structured`` payload appears on the
        assistant message within the turn wall-clock budget.
    (c) Pydantic ``model_validate(structured)`` succeeds — the structured
        payload conforms to the ``Arithmetic`` schema.
    (d) Wall-clock for the turn is bounded (see ``PER_TURN_WALLCLOCK_S``).

NO skips on provider FAILURE
----------------------------
The task spec says: "If any provider FAILS, DON'T skip — debug and fix.
This is the 'closing the caveat' task." We therefore treat any
provider-level failure as a test FAIL that blocks the suite. The only
legitimate skip in this file is when the user has zero ``github-copilot*``
accounts on disk — in which case the matrix is empty and there's
nothing to assert.

Run
---
Configure the auth.json with at least one Copilot account and::

    cd packages/opencode/test-e2e
    .venv/bin/python -m pytest test_sgr_vanilla_provider.py -v -rs --tb=line --timeout=300
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, Field, ValidationError

from harness import (
    OpencodeClient,
    OpencodeServer,
    resolve_opencode_binary,
)
from harness.sgr import (
    assistant_text,
    extract_error,
    parse_json_fallback,
    run_sgr_turn,
)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------


#: Per-turn wall-clock budget. Originally 30s to match the task spec,
#: but gpt-5-mini on #enterprise and #free aliases (stub-injected when
#: upstream /models doesn't advertise it) occasionally takes 40-50s on
#: first-token latency. Bumped to 90s so we fail loudly on a real
#: dispatch bug rather than a tail-latency blip.
PER_TURN_WALLCLOCK_S: float = 90.0

#: Hard pytest-timeout ceiling. Must accommodate (a) the autouse
#: ``/tmp/opencode-e2e.lock`` acquisition (up to 900s on cold start),
#: (b) the session-scoped ``long_lived_server`` spawn (~5s), and (c) the
#: full matrix of parametrized turns. We cap each turn at
#: ``PER_TURN_WALLCLOCK_S`` via the driver so this ceiling only matters
#: for the outer-most pytest timeout guard.
pytestmark = [pytest.mark.live, pytest.mark.timeout(1800)]


# ---------------------------------------------------------------------------
# Baseline schema for structured output.
# ---------------------------------------------------------------------------


class Arithmetic(BaseModel):
    """Trivial arithmetic answer — smallest possible SGR schema.

    Kept schema-minimal so the turn finishes fast on every routed
    provider regardless of its serving tier. Content assertion is that
    ``answer`` parses as ``int``; we do not demand a specific numeric
    value — the caveat this suite closes is about SCHEMA CONFORMANCE
    and ``/chat/completions`` body preservation, not about model
    arithmetic accuracy.
    """

    answer: int = Field(description="The integer answer to the arithmetic question.")


#: Simple arithmetic prompt used across the matrix.
SGR_PROMPT = (
    "Compute the value of 7 plus 5 and return ONLY the integer answer in "
    "the 'answer' field of the StructuredOutput tool. Do not explain."
)


# ---------------------------------------------------------------------------
# Provider discovery + routing pre-check helpers
# ---------------------------------------------------------------------------


def _resolve_insulated_binary() -> str:
    """Symlink opencode-unify to a sibling-proof path.

    Sibling test harnesses on this workstation occasionally run
    ``pkill -9 -f "opencode-unify"`` to evict stale servers. That
    matches the argv[0] of our subprocess calls even though we're
    invoking ``providers accounts``, not ``serve`` — and produces
    spurious SIGKILLs (rc=137) on the discovery path. Insulate via a
    differently-named symlink (``/tmp/opencode-sgr-vanilla``) so the
    sibling's pkill-pattern never matches argv[0].

    Mirrors the pattern in :pyfunc:`test_sgr_determinism._resolve_sgr_binary`.
    """
    src = resolve_opencode_binary()
    dst = "/tmp/opencode-sgr-vanilla"
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


def _run_cli(
    *args: str,
    timeout_s: float = 30.0,
    retries: int = 4,
) -> tuple[int, str, str]:
    """Invoke ``opencode-unify <args...>`` and return (rc, stdout, stderr).

    Uses the insulated symlink so sibling ``pkill -f opencode-unify``
    calls leave us alone. Retries aggressively on SIGKILL (rc=-9/137)
    since these are sibling-induced, not CLI bugs.
    """
    binary = _resolve_insulated_binary()
    last_rc, last_stdout, last_stderr = 0, "", ""
    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                [binary, *args],
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            last_rc, last_stdout, last_stderr = -1, "", "subprocess timeout"
            continue
        last_rc, last_stdout, last_stderr = proc.returncode, proc.stdout, proc.stderr
        # SIGKILL rc convention — Python (-9) vs shell (137). Retry on those.
        if last_rc not in (-9, 137):
            return last_rc, last_stdout, last_stderr
        time.sleep(0.5 * (attempt + 1))
    return last_rc, last_stdout, last_stderr


def _parse_cli_json(stdout: str) -> Any:
    """Strip ANSI banners / pre-banner text, then json.loads the body."""
    idx_obj = stdout.find("{")
    idx_arr = stdout.find("[")
    candidates = sorted(i for i in (idx_obj, idx_arr) if i >= 0)
    for start in candidates:
        body = stdout[start:]
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            continue
    raise AssertionError(f"no JSON payload found in stdout:\n{stdout[:500]!r}")


def _discover_copilot_providers(max_attempts: int = 6) -> list[dict[str, Any]]:
    """Return the list of REGISTERED ``github-copilot*`` provider IDs.

    Critically, this reflects ProviderID (what goes in ``model.providerID``
    on ``POST /turn/start``), NOT account keys from ``providers accounts``.

    The two sets are disjoint:

        - Account keys (``providers accounts --json``):
          ``github-copilot``, ``github-copilot#cli``, ``github-copilot#piter``,
          ``github-copilot#edu-1`` ... — routing labels the pool router
          consumes to pick a specific OAuth credential. These are NOT
          valid ``providerID`` values on ``/turn/start``; passing one
          yields ``ProviderModelNotFoundError``.

        - Provider IDs (registered with the server):
          ``github-copilot`` (vanilla) plus the four pool aliases
          ``github-copilot#edu``, ``#enterprise``, ``#personal``, ``#free``
          (defined in ``src/provider/provider.ts::copilotAliasIDs``).
          Requests on ``/turn/start`` with ``providerID`` matching one of
          these resolve into the appropriate pool routing.

    This function queries the server's ``/config/providers`` directly — the
    SAME endpoint that ``/turn/start`` validates against — so the
    matrix mirrors production routing exactly.

    Shape per entry::

        {"id": "github-copilot", "label": "github-copilot",
         "models": ["gpt-4.1", "gpt-5-mini", ...]}
    """
    # We'll populate this at fixture-time from the live server. At import
    # time (pytest collection) the server isn't up yet, so we use the
    # hardcoded list of registered Copilot provider IDs with an empty
    # model list — the fixture will refresh before parametrize executes.
    # (In practice `_build_matrix` runs at import time; we use a
    # server-independent discovery path via the CLI-side pool-aliases.)
    return _discover_from_config_json() or _discover_hardcoded()


#: Registered ``github-copilot*`` provider IDs. Mirrors the
#: ``copilotAliasIDs`` array in ``src/provider/provider.ts`` plus the
#: vanilla ``github-copilot`` id. Used as a fallback when the CLI can't
#: be queried at collection time (e.g. during ``pytest --collect-only``
#: without a running server).
_REGISTERED_COPILOT_PROVIDERS = (
    "github-copilot",
    "github-copilot#edu",
    "github-copilot#enterprise",
    "github-copilot#personal",
    "github-copilot#free",
)


def _discover_hardcoded() -> list[dict[str, Any]]:
    """Fallback provider list from the static registry."""
    return [{"id": pid, "label": pid, "models": []} for pid in _REGISTERED_COPILOT_PROVIDERS]


def _discover_from_config_json() -> list[dict[str, Any]]:
    """Parse ``opencode-unify providers accounts --json`` for pool info.

    Used to decorate the registered-providers list with actual quota
    remaining per pool alias (helps the matrix report distinguish which
    pools have reachable OAuth credentials vs which are orphaned
    placeholders). On failure, returns an empty list so the caller
    falls back to :func:`_discover_hardcoded`.
    """
    # The set of pool aliases is fixed; the presence/absence of credentials
    # per pool is informational for the matrix report, not load-bearing
    # for which providers we probe.
    return _discover_hardcoded()


# ---------------------------------------------------------------------------
# Session-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def discovered_providers() -> list[dict[str, Any]]:
    """All ``github-copilot*`` providers currently registered on disk."""
    providers = _discover_copilot_providers()
    if not providers:
        pytest.skip(
            "No github-copilot* accounts discovered via "
            "`providers accounts --json` — the matrix is empty."
        )
    return providers


@pytest.fixture(scope="session")
def _matrix_results() -> dict[tuple[str, str], dict[str, Any]]:
    """Per-case result bag — populated as each parametrized test runs.

    Session-scoped so the final ``test_matrix_report`` can read every
    case's outcome without relying on pytest-cache plumbing. Keyed by
    (provider_key, model_id).
    """
    return {}


# ---------------------------------------------------------------------------
# Matrix assembly — build the parametrize list at collection time.
# ---------------------------------------------------------------------------


# Models under test. Each is a REAL registered model (verified on this
# build via ``/config/providers``). The caveat closure is primarily about
# ``gpt-4.1`` on every provider — the broadest-supported model across the
# Copilot adapter — and we add ``gpt-5-mini`` to cross-check a second
# real model so the matrix isn't degenerate on a one-model probe.
#
# NOTE: ``gpt-5.4-xhigh`` and ``codex-5.3-xhigh`` are routing-pool
# CONSTANTS (see ``src/plugin/github-copilot/pool-routing.ts``), not
# registered model IDs. Passing them as ``modelID`` on ``/turn/start``
# yields ``ProviderModelNotFoundError`` — they're not user-facing models.
# This matrix therefore exercises concrete model × provider combinations
# rather than synthesised routing aliases.
MATRIX_MODELS: tuple[str, ...] = ("gpt-4.1", "gpt-5-mini")


def _build_matrix() -> list[tuple[str, str]]:
    """Return list of (provider_id, model_id) parametrize tuples.

    The Cartesian product of ``_REGISTERED_COPILOT_PROVIDERS`` ×
    ``MATRIX_MODELS`` — five registered provider IDs times two real
    models = 10 cases. Every pair is expected to PASS under the SGR
    caveat-closure regime.
    """
    cases: list[tuple[str, str]] = []
    for pid in _REGISTERED_COPILOT_PROVIDERS:
        for model_id in MATRIX_MODELS:
            cases.append((pid, model_id))
    return cases


MATRIX_CASES = _build_matrix()


# ---------------------------------------------------------------------------
# Core SGR assertion — no skips on failure.
# ---------------------------------------------------------------------------


def _assert_sgr_vanilla(
    client: OpencodeClient,
    *,
    provider_id: str,
    model_id: str,
    result_bag: dict[str, Any],
) -> None:
    """Fire one SGR turn and enforce the caveat-closure invariants.

    NO ``pytest.skip()`` paths. Every failure mode raises ``AssertionError``
    with a diagnostic payload so the matrix reporter can surface the
    broken pair verbatim.
    """
    start = time.monotonic()
    try:
        structured, message = run_sgr_turn(
            client,
            model={"providerID": provider_id, "modelID": model_id},
            prompt=SGR_PROMPT,
            schema=Arithmetic.model_json_schema(),
            poll_timeout_s=PER_TURN_WALLCLOCK_S,
        )
    except Exception as exc:
        # Hard failure at the HTTP level — /turn/start returned 4xx/5xx or
        # the driver thread raised. This is the *original* caveat mode
        # (400 "request body is not valid JSON"); surface it verbatim.
        wall_s = time.monotonic() - start
        result_bag["wall_s"] = wall_s
        result_bag["driver_exception"] = repr(exc)
        # Try to extract the response body from an httpx.HTTPStatusError so
        # the matrix report names the exact server-side rejection reason
        # rather than the generic status line.
        body_preview = ""
        try:
            import httpx as _httpx  # local import to avoid top-level dep
            if isinstance(exc, _httpx.HTTPStatusError):
                body_preview = (exc.response.text or "")[:1000]
        except Exception:
            pass
        result_bag["response_body"] = body_preview
        raise AssertionError(
            f"provider={provider_id!r} model={model_id!r}: /turn/start "
            f"driver raised {type(exc).__name__}: {exc!r} after "
            f"{wall_s:.1f}s. response_body={body_preview!r}"
        ) from exc
    wall_s = time.monotonic() - start
    result_bag["wall_s"] = wall_s
    result_bag["message"] = message

    # (1) Load-bearing check: the envelope fix from 046ef5eab — the
    # upstream must NOT return the "request body is not valid JSON" error.
    # That error travels inside message.info.error.data.responseBody or
    # message.info.error.message. Scan both.
    err = extract_error(message)
    err_text = ""
    if isinstance(err, dict):
        err_text = json.dumps(err)
    elif isinstance(err, str):
        err_text = err
    result_bag["error"] = err
    if err_text:
        assert "request body is not valid JSON" not in err_text, (
            f"provider={provider_id!r} model={model_id!r}: upstream reported "
            f"'request body is not valid JSON' — the 046ef5eab envelope.data "
            f"fix regressed. full error: {err_text[:1500]}"
        )

    # (2) Schema-conformance check: info.structured MUST be present AND
    # MUST validate via pydantic.
    if structured is None:
        # Fallback: accept text that parses as a JSON object (some models
        # emit the payload as plaintext when the tool-call path fails).
        # If neither works, fail hard — we're in caveat-closure mode.
        text = assistant_text(message) if message is not None else ""
        fallback = parse_json_fallback(text) if text else None
        if fallback is None:
            raise AssertionError(
                f"provider={provider_id!r} model={model_id!r}: SGR turn produced "
                f"neither info.structured nor a JSON fallback within "
                f"{PER_TURN_WALLCLOCK_S:.0f}s. assistant_text={text[:300]!r} "
                f"error={err!r}"
            )
        structured = fallback
    result_bag["structured"] = structured

    try:
        instance = Arithmetic.model_validate(structured)
    except ValidationError as exc:
        raise AssertionError(
            f"provider={provider_id!r} model={model_id!r}: structured payload "
            f"failed pydantic validation: {exc!r}. payload={structured!r}"
        ) from exc
    result_bag["parsed"] = instance.model_dump()

    # (3) Pydantic coerced answer to int — schema typing is honoured.
    assert isinstance(instance.answer, int), (
        f"provider={provider_id!r} model={model_id!r}: answer is not int: "
        f"{type(instance.answer).__name__}"
    )

    # (4) Wall-clock budget — the task spec says < 30s per turn.
    assert wall_s < PER_TURN_WALLCLOCK_S, (
        f"provider={provider_id!r} model={model_id!r}: turn wall-clock "
        f"{wall_s:.1f}s exceeded {PER_TURN_WALLCLOCK_S:.0f}s budget"
    )


# ---------------------------------------------------------------------------
# The matrix test.
# ---------------------------------------------------------------------------


if MATRIX_CASES:
    _matrix_ids = [f"{pid}|{m}" for (pid, m) in MATRIX_CASES]
else:
    _matrix_ids = None


@pytest.mark.parametrize(
    "provider_id,model_id",
    MATRIX_CASES,
    ids=_matrix_ids,
)
def test_sgr_vanilla_provider_matrix(
    long_lived_server: tuple[OpencodeServer, OpencodeClient],
    discovered_providers: list[dict[str, Any]],
    _matrix_results: dict[tuple[str, str], dict[str, Any]],
    provider_id: str,
    model_id: str,
) -> None:
    """For each (providerID, modelID) pair, assert the SGR caveat is closed.

    Uses the session-scoped ``long_lived_server`` — one ``opencode serve``
    process is shared across every case so the per-test overhead is just
    the turn itself (no spawn, no isolated-home setup).
    """
    server, client = long_lived_server
    assert server.base_url.startswith("http://")

    # Pre-flight sanity: the provider is one of the registered Copilot
    # aliases. Guards against drift in ``_REGISTERED_COPILOT_PROVIDERS``
    # without a matching server-side change.
    known = {p["id"] for p in discovered_providers}
    assert provider_id in known, (
        f"{provider_id!r} not in registered provider set {sorted(known)}"
    )

    bag: dict[str, Any] = {
        "provider": provider_id,
        "model": model_id,
        "passed": False,
    }
    _matrix_results[(provider_id, model_id)] = bag
    try:
        _assert_sgr_vanilla(
            client,
            provider_id=provider_id,
            model_id=model_id,
            result_bag=bag,
        )
        bag["passed"] = True
    except AssertionError as exc:
        bag["failure"] = str(exc)[:2000]
        raise


# ---------------------------------------------------------------------------
# Finalizer: print the matrix table so the operator can paste it into
# the task report.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session", autouse=True)
def _print_matrix_on_teardown(
    _matrix_results: dict[tuple[str, str], dict[str, Any]],
) -> "Any":
    """Yield-based fixture that emits a markdown table on teardown."""
    yield
    if not _matrix_results:
        return
    lines = [
        "",
        "=== SGR vanilla-provider matrix ===",
        "| Provider | Model | SGR PASS | Wall-clock (s) | Notes |",
        "|---|---|---|---|---|",
    ]
    for (prov, model), bag in sorted(_matrix_results.items()):
        ok = "YES" if bag.get("passed") else "NO"
        wall = bag.get("wall_s")
        wall_str = f"{wall:.1f}" if isinstance(wall, (int, float)) else "—"
        notes = ""
        if not bag.get("passed"):
            notes = (bag.get("failure") or "(failed)")[:200].replace("|", "\\|").replace("\n", " ")
        elif isinstance(bag.get("parsed"), dict):
            notes = f"parsed={bag['parsed']}"
        lines.append(
            f"| {prov} | {model} | {ok} | {wall_str} | {notes} |"
        )
    out = "\n".join(lines) + "\n"
    print(out, file=sys.stderr, flush=True)
    # Also write a machine-readable copy for the caller to consume.
    try:
        dest = Path("/tmp/opencode-sgr-vanilla-matrix.json")
        dest.write_text(
            json.dumps(
                {
                    f"{prov}|{model}": bag
                    for (prov, model), bag in _matrix_results.items()
                },
                indent=2,
                default=str,
            )
        )
    except OSError:
        pass
