"""End-to-end tests for the MemCoder-style memory subsystem.

Exercises the ``memory`` CLI surface + the ``<similar_past_problems>``
turn-hook injection path against a *live* Copilot-backed ``opencode
serve``. No mocks, no fake provider overrides — we point the binary at
the user's real ``~/.local/share/opencode/auth.json`` (copied into an
isolated data dir via ``harness.prepare_isolated_home``) and drive
Phase-1 extraction, turn-hook retrieval, hybrid/cosine/bm25 retrieval,
the commit crawler, and foreign ingest end-to-end.

Isolation
---------
Each test spawns ``opencode serve`` with a fresh isolated home root
produced by :func:`harness.prepare_isolated_home`. The ``auth.json`` is
*copied* (not symlinked) into the isolated data dir so Copilot auth
works; refresh tokens may rotate in the isolated copy and never leak
back. The memory SQLite DB + commit JSONL cache all live under the
isolated ``XDG_DATA_HOME/opencode``.

Each test emits the markers ``isolated opencode home: <path>`` and
``live-LLM project dir: <path>`` on stderr so external log-pollers (the
parallel-agent ``sleep 180 + poll log`` contract) can discover the
per-test state.

Skip rules
----------
- No ``github-copilot`` OAuth token on disk → every test skips.
- ``OPENCODE_BINARY`` (or ``opencode-unify`` on PATH) missing → every
  test skips at fixture setup.

Running
-------
::

    cd packages/opencode
    python3 -m pytest test-e2e/test_memory.py -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterator, Optional

import httpx
import pytest

# Make ``harness`` importable whether pytest is invoked from the package
# dir or the repo root.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from harness import (  # noqa: E402
    OpencodeClient,
    OpencodeServer,
    has_copilot_credentials,
    prepare_isolated_home,
    resolve_opencode_binary,
    xdg_env_for,
)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


skip_if_no_copilot = pytest.mark.skipif(
    not has_copilot_credentials(),
    reason="requires ~/.local/share/opencode/auth.json with a github-copilot OAuth token",
)


def _write_config(root: Path, config: dict[str, Any]) -> None:
    """Persist an opencode config under the isolated home's XDG_CONFIG_HOME."""
    cfg_dir = root / "config" / "opencode"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.json").write_text(
        json.dumps({"$schema": "https://opencode.ai/config.json", **config})
    )


def _env_for(root: Path) -> dict[str, str]:
    """Combine process env + isolated XDG overrides for subprocess calls."""
    env = dict(os.environ)
    env.update(xdg_env_for(root))
    return env


def _print_markers(root: Path, scratch: Path) -> None:
    """Emit the ``isolated opencode home`` + ``live-LLM`` markers stderr."""
    print(f"[memory-e2e] isolated opencode home: {root}", file=sys.stderr)
    print(f"[memory-e2e] live-LLM project dir:   {scratch}", file=sys.stderr)


def _run_memory_cli(
    root: Path,
    *args: str,
    cwd: Path,
    stdin: Optional[str] = None,
    timeout_s: float = 180.0,
) -> tuple[int, str, str]:
    """Run ``opencode-unify memory <args...>`` against the isolated home.

    Retries once on SIGKILL (-9 / 137) — macOS sandbox occasionally kills
    the bundled binary on first spawn (cf. the retry pattern in
    ``test_copilot_multi_account.py``).
    """
    binary = resolve_opencode_binary()
    last: tuple[int, str, str] = (0, "", "")
    for attempt in range(3):
        proc = subprocess.run(
            [binary, "memory", *args],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=_env_for(root),
            cwd=str(cwd),
            input=stdin,
        )
        last = (proc.returncode, proc.stdout, proc.stderr)
        if proc.returncode not in (-9, 137):
            return last
        time.sleep(0.5 * (attempt + 1))
    return last


def _parse_json_tail(stdout: str) -> Any:
    """Extract the JSON body emitted by ``memory <cmd> --json``.

    The CLI prints a ``prompts.intro`` banner / DB-migration notice
    before the JSON body on first run; slide forward until the first
    parseable ``{`` or ``[``.
    """
    for start in sorted(i for i in (stdout.find("{"), stdout.find("[")) if i >= 0):
        try:
            return json.loads(stdout[start:])
        except json.JSONDecodeError:
            continue
    raise AssertionError(f"no JSON found in stdout:\n{stdout[:400]}")


def _poll_sextuple_count(root: Path, cwd: Path, *, deadline_s: float) -> int:
    """Poll ``memory status --json`` until sextupleCount > 0 or deadline."""
    end = time.monotonic() + deadline_s
    last = 0
    while time.monotonic() < end:
        rc, stdout, _ = _run_memory_cli(root, "status", "--json", cwd=cwd)
        if rc == 0:
            try:
                last = _parse_json_tail(stdout).get("sextupleCount", 0)
                if last >= 1:
                    return last
            except AssertionError:
                pass
        time.sleep(1.0)
    return last


# ---------------------------------------------------------------------------
# Per-test live Copilot server fixture
# ---------------------------------------------------------------------------


def _server_supports_instance_routes(base_url: str, cwd: str) -> bool:
    try:
        r = httpx.post(
            f"{base_url}/session",
            headers={"x-opencode-directory": cwd},
            json={},
            timeout=5.0,
        )
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def _spawn_server(
    root: Path,
    scratch: Path,
    *,
    ready_timeout_s: float = 180.0,
    print_logs: bool = False,
) -> OpencodeServer:
    """Start ``opencode serve`` with XDG env pointing at ``root``.

    ``ready_timeout_s`` matches the "sleep 180 + poll log" contract:
    a live-LLM server can take up to 3 minutes to boot + probe providers
    when several Copilot accounts need refresh. On readiness failure
    the isolated dirs are left in place for post-mortem.

    Set ``print_logs=True`` (or ``OPENCODE_E2E_PRINT_LOGS=1`` env) to
    pipe the serve subprocess's stderr into the pytest capture so you
    can scrape memory-observer firing from the log.
    """
    print_logs = print_logs or os.environ.get("OPENCODE_E2E_PRINT_LOGS") == "1"
    server = OpencodeServer(
        binary=resolve_opencode_binary(),
        data_dir=root,
        cwd=scratch,
        ready_timeout_s=ready_timeout_s,
        print_logs=print_logs,
    )
    _print_markers(root, scratch)
    server.start()
    return server


# ---------------------------------------------------------------------------
# Test 1 — memories disabled → no extraction
# ---------------------------------------------------------------------------


@skip_if_no_copilot
def test_memories_disabled_no_extraction(copilot_model: dict[str, str]) -> None:
    """With ``memories.enabled = false`` a 2-turn defect-resolution
    exchange must produce zero sextuples."""
    root = prepare_isolated_home(preserve_tokens=True)
    scratch = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-cwd-"))
    _write_config(root, {"memories": {"enabled": False}})
    try:
        server = _spawn_server(root, scratch)
        try:
            if not _server_supports_instance_routes(server.base_url, str(scratch)):
                pytest.skip("opencode serve missing instance routes")
            with OpencodeClient(
                server.base_url,
                project_directory=str(scratch),
                timeout_s=300.0,
            ) as client:
                session = client.create_session()
                try:
                    client.send_message(
                        session["id"],
                        "I have a defect: parseInt('08') returns 0 in older Node runtimes.",
                        providerID=copilot_model["providerID"],
                        modelID=copilot_model["modelID"],
                    )
                    client.send_message(
                        session["id"],
                        "The fix is to pass an explicit radix: parseInt('08', 10).",
                        providerID=copilot_model["providerID"],
                        modelID=copilot_model["modelID"],
                    )
                except (httpx.RemoteProtocolError, httpx.ReadError, httpx.ConnectError):
                    # Upstream Copilot/LLM connection dropped mid-turn —
                    # that's an infra flake, not a memory-pipeline bug.
                    # With memories disabled, no sextuples should be
                    # recorded regardless, so continue to the assertion.
                    pass
        finally:
            server.stop()

        rc, stdout, stderr = _run_memory_cli(root, "status", "--json", cwd=scratch)
        assert rc == 0, f"memory status rc={rc}\nstderr={stderr}\nstdout={stdout}"
        status = _parse_json_tail(stdout)
        assert status["sextupleCount"] == 0, f"expected 0 sextuples, got {status}"
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 2 — Phase-1 extraction → sextupleCount ≥ 1 with non-empty fields
# ---------------------------------------------------------------------------


# SGR JSON-Schema for the Phase-1 extraction response contract. Mirrors
# `parsePhase1Response` in `packages/opencode/src/memory/phase1.ts` —
# any shape drift here is a regression signal, not a config choice.
# Supplying this via `memories.extractionFormatSchema` swaps the bridge
# from `generateText` to `generateObject` (see `memory/llm-bridge.ts`),
# which forces the provider to emit a schema-conforming object instead
# of free-form JSON.
PHASE1_SEXTUPLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "keywords": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "maxItems": 8,
        },
        "problem": {"type": "string", "minLength": 1},
        "root_cause": {"type": "string", "minLength": 1},
        "solution": {"type": "string", "minLength": 1},
    },
    "required": ["keywords", "problem", "root_cause", "solution"],
    "additionalProperties": False,
}

PHASE1_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "rollout_summary": {"type": "string"},
        "rollout_slug": {"type": "string"},
        "raw_memory": {"type": "string"},
        "sextuples": {
            "type": "array",
            "items": PHASE1_SEXTUPLE_SCHEMA,
            "minItems": 1,
            "maxItems": 5,
        },
    },
    "required": ["rollout_summary", "rollout_slug", "raw_memory", "sextuples"],
    "additionalProperties": False,
}


@skip_if_no_copilot
def test_phase1_extracts_sextuples(copilot_model: dict[str, str]) -> None:
    """With memories + Phase-1 extraction enabled, a defect-resolution
    turn produces ≥1 sextuple whose ``{problem, root_cause, solution,
    keywords}`` fields are all non-empty."""
    model_spec = f"{copilot_model['providerID']}/{copilot_model['modelID']}"
    keep_dirs = os.environ.get("OPENCODE_E2E_KEEP") == "1"
    root = prepare_isolated_home(preserve_tokens=True)
    scratch = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-cwd-"))
    _write_config(
        root,
        {
            "memories": {
                "enabled": True,
                "extractionEnabled": True,
                "retrievalEnabled": False,
                "rerankEnabled": False,
                "extractionModel": model_spec,
                # SGR guard — forces `generateObject` on the Phase-1 LLM
                # call so the provider can't drift off the schema.
                "extractionFormatSchema": PHASE1_RESPONSE_SCHEMA,
            },
            "model": model_spec,
        },
    )
    try:
        server = _spawn_server(root, scratch)
        try:
            if not _server_supports_instance_routes(server.base_url, str(scratch)):
                pytest.skip("opencode serve missing instance routes")
            try:
                with OpencodeClient(
                    server.base_url,
                    project_directory=str(scratch),
                    timeout_s=300.0,
                ) as client:
                    session = client.create_session()
                    client.send_message(
                        session["id"],
                        (
                            "I fixed a bug where parseInt('01') was treating leading "
                            "zero as octal. Solution: use parseInt(x, 10) with "
                            "explicit radix."
                        ),
                        providerID=copilot_model["providerID"],
                        modelID=copilot_model["modelID"],
                    )
                    # Post-turn Phase-1 extraction fires in a forked fiber
                    # (`Effect.forkDetach` inside the memory turn observer).
                    # The server must stay alive long enough for the fork
                    # to finish its LLM round-trip + storage write;
                    # stop() while the fork is pending cancels it. Poll
                    # status against the running server so the fork has
                    # time to complete.
                    count = _poll_sextuple_count(
                        root, scratch, deadline_s=180.0
                    )
            except Exception:
                # Surface the server's stderr capture to aid diagnosis
                # when the server disconnects mid-turn.
                print(
                    f"[memory-e2e] server stderr:\n{server.stderr_text()[-4000:]}",
                    file=sys.stderr,
                )
                raise
        finally:
            if os.environ.get("OPENCODE_E2E_PRINT_LOGS") == "1":
                print(
                    f"[memory-e2e] server stderr tail:\n"
                    f"{server.stderr_text()[-8000:]}",
                    file=sys.stderr,
                )
            server.stop()

        # SGR-constrained extraction: the provider is forced through
        # `generateObject`, so a 0-sextuple outcome is a hard failure,
        # not an upstream flake.
        assert count >= 1, (
            f"Phase-1 SGR extraction produced 0 sextuples after 180s "
            f"(model={model_spec}, schema=PHASE1_RESPONSE_SCHEMA). "
            f"Provider rejected `generateObject` constraint or the "
            f"extraction fiber did not finish before server teardown — "
            f"inspect OPENCODE_MEMORY_OBSERVER_DEBUG=1 logs."
        )

        # Retrieve + verify every required field is non-empty. Retries up
        # to 5× with 2s backoff because the embedding index on disk can
        # lag a few seconds behind the extraction fiber's sqlite write.
        body: dict[str, Any] = {}
        last_stderr = ""
        for attempt in range(5):
            rc, stdout, last_stderr = _run_memory_cli(
                root,
                "retrieve",
                "--query",
                "parseInt leading zero octal radix bug",
                "--mode",
                "cosine",
                "--top-k",
                "5",
                "--json",
                cwd=scratch,
            )
            assert rc == 0, f"memory retrieve rc={rc}\nstderr={last_stderr}"
            body = _parse_json_tail(stdout)
            if body.get("hits"):
                break
            time.sleep(2.0)
        assert body.get("hits"), (
            f"no hits returned after 5× retries: {body}\n"
            f"stderr tail:\n{last_stderr[-2000:]}"
        )
        top = body["hits"][0]
        assert (top.get("problem") or "").strip(), f"empty problem: {top}"
        assert (top.get("rootCause") or "").strip(), f"empty rootCause: {top}"
        assert (top.get("solution") or "").strip(), f"empty solution: {top}"
        assert top.get("keywords"), f"empty keywords: {top}"
    finally:
        if not keep_dirs:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(scratch, ignore_errors=True)
        else:
            print(f"[memory-e2e] keep-dirs: root={root} scratch={scratch}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Test 3 — turn-hook injects <similar_past_problems> into system prompt
# ---------------------------------------------------------------------------


@skip_if_no_copilot
def test_turn_hook_injects_similar_past_problems(
    copilot_model: dict[str, str],
) -> None:
    """SGR-hardened verification that the retrieval enrichment block reaches the system context.

    Opencode deliberately does NOT persist the enrichment block in
    message history — it lives only in the per-turn ``system[]`` array
    passed to the model. The black-box way to assert injection is
    therefore to ask the model to report what it sees in its system
    context. Routing the question through ``/turn/start`` with a
    ``format={"type":"json_schema", ...}`` envelope forces the server
    to register the ``StructuredOutput`` tool + ``toolChoice=required``
    so the model's only legal next token is a schema-conforming tool
    call — no refusal paths, no free-form drift, no upstream skips.
    """
    model_spec = f"{copilot_model['providerID']}/{copilot_model['modelID']}"
    root = prepare_isolated_home(preserve_tokens=True)
    scratch = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-cwd-"))
    _write_config(
        root,
        {
            "memories": {
                "enabled": True,
                "retrievalEnabled": True,
                "extractionEnabled": False,
                "rerankEnabled": False,
                "retrievalTopK": 3,
                "retrievalMinScore": 0.0,
                "retrieval": {"mode": "hybrid"},
            },
            "model": model_spec,
        },
    )
    seed_body = {
        "keywords": [
            "null",
            "pointer",
            "undefined",
            "nested",
            "property",
            "OCTOPUS_MARKER_42",
        ],
        "problem": (
            "OCTOPUS_MARKER_42: null pointer dereference when accessing a "
            "nested property on an undefined parent"
        ),
        "rootCause": (
            "parent object is undefined; direct `.child.value` access "
            "throws TypeError"
        ),
        "solution": (
            "guard with optional chaining `parent?.child?.value` or a "
            "null check"
        ),
    }

    # SGR schema pinning the answer surface to a 2-value enum + a free
    # string for the echoed token. Free-form replies are no longer
    # possible — the model either emits MEM_INJECTED + a token or
    # MEM_NOT_INJECTED + an empty string.
    injection_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "saw_memory_block": {
                "type": "string",
                "enum": ["MEM_INJECTED", "MEM_NOT_INJECTED"],
                "description": (
                    "MEM_INJECTED if the system context contains a "
                    "`<similar_past_problems>` block, else MEM_NOT_INJECTED."
                ),
            },
            "echoed_marker": {
                "type": "string",
                "description": (
                    "When saw_memory_block == MEM_INJECTED, verbatim "
                    "copy of a distinguishable identifier from inside "
                    "the block (e.g. OCTOPUS_MARKER_42). Empty string "
                    "when MEM_NOT_INJECTED."
                ),
            },
        },
        "required": ["saw_memory_block", "echoed_marker"],
        "additionalProperties": False,
    }

    try:
        rc, stdout, stderr = _run_memory_cli(
            root, "seed", "--json", cwd=scratch, stdin=json.dumps(seed_body)
        )
        assert rc == 0, f"seed rc={rc}\nstderr={stderr}\nstdout={stdout}"
        assert _parse_json_tail(stdout)["hashId"], "seed did not return hashId"

        rc, stdout, _ = _run_memory_cli(root, "status", "--json", cwd=scratch)
        status = _parse_json_tail(stdout)
        assert status["sextupleCount"] >= 1, f"seed not visible: {status}"

        server = _spawn_server(root, scratch)
        structured: Optional[dict[str, Any]] = None
        try:
            if not _server_supports_instance_routes(server.base_url, str(scratch)):
                pytest.skip("opencode serve missing instance routes")
            with OpencodeClient(
                server.base_url,
                project_directory=str(scratch),
                timeout_s=300.0,
            ) as client:
                thread = client.create_thread()
                thread_id = thread["id"]

                # Background the /turn/start drive so the HTTP pool can
                # be torn down without aborting a long Copilot turn.
                # Poll GET /session/:id/message for `info.structured` on
                # the main thread (mirrors harness/sgr.py).
                import threading as _threading
                import time as _time

                turn_err: list[BaseException] = []
                turn_done = _threading.Event()
                turn_prompt = (
                    "Inspect your system context. If it contains a block "
                    "labelled `<similar_past_problems>`, set "
                    "saw_memory_block to MEM_INJECTED and put any unique "
                    "identifier you see inside that block into "
                    "echoed_marker. Otherwise set saw_memory_block to "
                    "MEM_NOT_INJECTED and leave echoed_marker empty."
                )

                def _drive() -> None:
                    try:
                        client.start_turn(
                            thread_id,
                            turn_prompt,
                            model=copilot_model,
                            format={
                                "type": "json_schema",
                                "schema": injection_schema,
                            },
                        )
                    except BaseException as err:  # noqa: BLE001
                        turn_err.append(err)
                    finally:
                        turn_done.set()

                drv = _threading.Thread(
                    target=_drive,
                    name=f"mem-inject-{thread_id}",
                    daemon=True,
                )
                drv.start()

                deadline = _time.monotonic() + 240.0
                while _time.monotonic() < deadline:
                    try:
                        msgs = client.get_messages(thread_id)
                    except Exception:
                        _time.sleep(1.0)
                        continue
                    for m in msgs or []:
                        info = m.get("info") or {}
                        if info.get("role") == "assistant":
                            candidate = info.get("structured")
                            if isinstance(candidate, dict):
                                structured = candidate
                                break
                    if structured is not None:
                        break
                    if turn_done.is_set():
                        # Final scan after the driver thread finished.
                        try:
                            msgs = client.get_messages(thread_id)
                        except Exception:
                            msgs = []
                        for m in msgs or []:
                            info = m.get("info") or {}
                            if info.get("role") == "assistant":
                                candidate = info.get("structured")
                                if isinstance(candidate, dict):
                                    structured = candidate
                                    break
                        break
                    _time.sleep(1.0)
        finally:
            server.stop()

        assert structured is not None, (
            "SGR turn did not land a structured payload on the assistant "
            "message within 240s — server plumbing (StructuredOutput tool "
            "+ toolChoice=required) likely regressed, or provider rejected "
            "the /turn/start format envelope."
        )
        saw = str(structured.get("saw_memory_block") or "")
        echoed = str(structured.get("echoed_marker") or "")
        assert saw == "MEM_INJECTED", (
            f"model reported saw_memory_block={saw!r} echoed_marker={echoed!r}; "
            "enrichment block did NOT reach the system context, or the "
            f"model disagreed with the schema. Full payload: {structured!r}"
        )
        assert echoed.strip(), (
            f"model reported MEM_INJECTED but echoed_marker is empty — "
            f"the enrichment block is present but may not contain a "
            f"distinguishable identifier. Full payload: {structured!r}"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 4 — memory reset clears the corpus
# ---------------------------------------------------------------------------


@skip_if_no_copilot
def test_memory_reset_clears_corpus() -> None:
    """After a seed, ``memory reset --yes`` must return the store to
    ``sextupleCount == 0``."""
    root = prepare_isolated_home(preserve_tokens=True)
    scratch = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-cwd-"))
    _write_config(root, {"memories": {"enabled": True}})
    _print_markers(root, scratch)

    try:
        seed_body = {
            "keywords": ["reset", "test", "dummy"],
            "problem": "dummy problem for reset test, 20+ characters long",
            "rootCause": "dummy root cause",
            "solution": "dummy solution",
        }
        rc, _, stderr = _run_memory_cli(
            root, "seed", "--json", cwd=scratch, stdin=json.dumps(seed_body)
        )
        assert rc == 0, f"seed failed: {stderr}"

        rc, stdout, _ = _run_memory_cli(root, "status", "--json", cwd=scratch)
        status = _parse_json_tail(stdout)
        assert status["sextupleCount"] >= 1, f"pre-reset status: {status}"

        rc, stdout, stderr = _run_memory_cli(
            root, "reset", "--yes", "--json", cwd=scratch
        )
        assert rc == 0, f"reset rc={rc}\nstderr={stderr}"

        rc, stdout, _ = _run_memory_cli(root, "status", "--json", cwd=scratch)
        post = _parse_json_tail(stdout)
        assert post["sextupleCount"] == 0, f"post-reset status: {post}"
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 5 — cosine vs bm25 vs hybrid produce distinct rankings
# ---------------------------------------------------------------------------


@skip_if_no_copilot
def test_retrieval_modes_produce_different_ranks() -> None:
    """Seed 3 distinct sextuples and run the same ambiguous query in
    ``cosine``, ``bm25``, and ``hybrid`` modes. At least 2 of the 3
    mode orderings must differ — otherwise the ranker implementations
    have collapsed to the same ordering, which would silently hide
    retrieval bugs.
    """
    root = prepare_isolated_home(preserve_tokens=True)
    scratch = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-cwd-"))
    _write_config(root, {"memories": {"enabled": True}})
    _print_markers(root, scratch)

    try:
        seeds = [
            {
                "keywords": ["timeout", "fetch", "network", "retry"],
                "problem": "HTTP fetch hangs forever when the remote endpoint stalls",
                "rootCause": "no AbortController signal wired to the fetch call",
                "solution": "wrap fetch with AbortController + setTimeout(5000)",
            },
            {
                "keywords": ["parseint", "octal", "radix", "javascript"],
                "problem": "parseInt misinterprets leading-zero strings as octal in legacy runtimes",
                "rootCause": "omitted explicit radix triggers octal parsing mode",
                "solution": "always pass radix 10: parseInt(x, 10)",
            },
            {
                "keywords": ["memory", "leak", "listener", "unsubscribe"],
                "problem": "event listener never removed, memory grows unbounded on reloads",
                "rootCause": "effect cleanup did not call removeEventListener",
                "solution": "return () => removeEventListener(...) from the hook effect",
            },
        ]
        for body in seeds:
            rc, _, stderr = _run_memory_cli(
                root, "seed", "--json", cwd=scratch, stdin=json.dumps(body)
            )
            assert rc == 0, f"seed failed: {stderr}"

        def _top3(mode: str) -> list[str]:
            rc, stdout, stderr = _run_memory_cli(
                root,
                "retrieve",
                "--query",
                "network timeout parseInt memory bug fix retry",
                "--mode",
                mode,
                "--top-k",
                "3",
                "--json",
                cwd=scratch,
            )
            assert rc == 0, f"retrieve {mode} rc={rc}\nstderr={stderr}"
            return [h["hashId"] for h in _parse_json_tail(stdout)["hits"]]

        cosine = _top3("cosine")
        bm25 = _top3("bm25")
        hybrid = _top3("hybrid")

        assert cosine, "cosine produced empty top-3"
        assert bm25, "bm25 produced empty top-3"
        assert hybrid, "hybrid produced empty top-3"

        distinct = {tuple(cosine), tuple(bm25), tuple(hybrid)}
        assert len(distinct) >= 2, (
            f"all three retrieval modes produced identical top-3 order "
            f"(cosine={cosine}, bm25={bm25}, hybrid={hybrid}) — "
            f"ranker implementations have collapsed"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 6 — commit crawler produces JSONL ≥1 sextuple
# ---------------------------------------------------------------------------


@skip_if_no_copilot
def test_commit_crawler_produces_jsonl(copilot_model: dict[str, str]) -> None:
    """Commit crawler with SGR-constrained polisher yields ≥1 sextuple JSONL row.

    The polisher emits a flat ``PolisherSextuple`` per commit (just
    ``{keywords, problem, root_cause, solution}`` — NOT the Phase-1
    wrapped contract). We configure ``memories.polishFormatSchema`` so
    ``memory crawl --polish`` invokes ``generateObject`` with the flat
    schema on every commit — no upstream-variance skip branch required.
    """
    model_spec = f"{copilot_model['providerID']}/{copilot_model['modelID']}"
    root = prepare_isolated_home(preserve_tokens=True)
    repo = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-gitrepo-"))
    _write_config(
        root,
        {
            "memories": {
                "enabled": True,
                "polishModel": model_spec,
                # SGR guard — forces the polisher through `generateObject`
                # with the flat `PolisherSextuple` shape. See
                # `src/memory/commit-crawler.ts::PolisherSextuple`.
                "polishFormatSchema": PHASE1_SEXTUPLE_SCHEMA,
            },
            "model": model_spec,
        },
    )
    _print_markers(root, repo)

    def _git(*args: str) -> None:
        subprocess.run(
            ["git", *args],
            cwd=str(repo),
            check=True,
            env={
                **os.environ,
                "GIT_AUTHOR_NAME": "E2E",
                "GIT_AUTHOR_EMAIL": "e2e@example.com",
                "GIT_COMMITTER_NAME": "E2E",
                "GIT_COMMITTER_EMAIL": "e2e@example.com",
            },
            capture_output=True,
        )

    try:
        _git("init", "-q")
        _git("checkout", "-q", "-b", "main")
        # Commit 1: initial buggy state.
        (repo / "index.js").write_text(
            "function parseNumber(s) {\n"
            "  return parseInt(s)\n"
            "}\n\nmodule.exports = parseNumber\n"
        )
        _git("add", "index.js")
        _git(
            "commit",
            "-q",
            "-m",
            "initial: add parseNumber helper that wraps parseInt without "
            "an explicit radix argument",
        )

        # Commit 2: fix.
        (repo / "index.js").write_text(
            "function parseNumber(s) {\n"
            "  return parseInt(s, 10)\n"
            "}\n\nmodule.exports = parseNumber\n"
        )
        _git("add", "index.js")
        _git(
            "commit",
            "-q",
            "-m",
            "fix(parseInt): pass explicit radix 10 to prevent older "
            "runtimes from parsing leading-zero strings as octal. Without "
            "the radix, parseInt('08') returned 0 in legacy Node, which "
            "broke the number-parsing path in this module.",
        )

        # Commit 3: unrelated fix to exercise diversity.
        (repo / "fetch.js").write_text(
            "export async function get(url) {\n"
            "  const ctrl = new AbortController()\n"
            "  const t = setTimeout(() => ctrl.abort(), 5000)\n"
            "  try { return await fetch(url, { signal: ctrl.signal }) }\n"
            "  finally { clearTimeout(t) }\n"
            "}\n"
        )
        _git("add", "fetch.js")
        _git(
            "commit",
            "-q",
            "-m",
            "fix(fetch): wrap fetch with AbortController + setTimeout so "
            "hanging remote endpoints no longer stall the caller "
            "indefinitely. Previously a slow server could hold the "
            "request forever.",
        )

        rc, stdout, stderr = _run_memory_cli(
            root,
            "crawl",
            "--polish",
            "--limit",
            "10",
            "--json",
            cwd=repo,
            timeout_s=300.0,
        )
        assert rc == 0, f"memory crawl rc={rc}\nstderr={stderr}\nstdout={stdout}"
        stats = _parse_json_tail(stdout)
        assert stats["commitsWalked"] >= 3, f"crawl walked too few commits: {stats}"

        commit_mem_dir = root / "data" / "opencode" / "memory" / "commit_memory"
        assert commit_mem_dir.exists(), f"{commit_mem_dir} missing"
        jsonl_files = [
            p
            for p in commit_mem_dir.iterdir()
            if p.suffix == ".jsonl" and p.stat().st_size > 0
        ]
        found_sextuple = False
        for jf in jsonl_files:
            for line in jf.read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("problem") and row.get("keywords"):
                    found_sextuple = True
                    break
            if found_sextuple:
                break
        assert found_sextuple, (
            f"SGR-constrained polisher produced no non-empty sextuples "
            f"across {len(jsonl_files)} JSONL file(s) (stats={stats}). "
            f"With `polishFormatSchema` wired, every non-trivial commit "
            f"must produce a schema-valid row — a zero outcome indicates "
            f"provider refusal or a crawler-wiring regression."
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(repo, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 7 — foreign ingest (opencode self) records checkpoint progress
# ---------------------------------------------------------------------------


@skip_if_no_copilot
def test_foreign_ingest_opencode_self() -> None:
    """``memory ingest --tool opencode`` walks the isolated data dir and
    records checkpoint / stats progress end-to-end.

    ``inserted`` may be zero in an isolated home (no prior sessions) —
    the assertion is that the pipeline runs to completion and emits a
    well-formed stats object, and that a subsequent ``status`` call
    succeeds against the same data dir.
    """
    root = prepare_isolated_home(preserve_tokens=True)
    scratch = Path(tempfile.mkdtemp(prefix="opencode-e2e-memory-cwd-"))
    _write_config(root, {"memories": {"enabled": True}})
    _print_markers(root, scratch)

    # Initialise scratch as a git repo so the ingest's git-root scoping
    # anchors itself somewhere predictable (opencode-self pipes sessions
    # keyed by worktree).
    subprocess.run(
        ["git", "init", "-q"],
        cwd=str(scratch),
        check=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "E2E",
            "GIT_AUTHOR_EMAIL": "e2e@example.com",
            "GIT_COMMITTER_NAME": "E2E",
            "GIT_COMMITTER_EMAIL": "e2e@example.com",
        },
    )

    try:
        rc, stdout, stderr = _run_memory_cli(
            root,
            "ingest",
            "--tool",
            "opencode",
            "--json",
            cwd=scratch,
            timeout_s=180.0,
        )
        assert rc == 0, f"ingest rc={rc}\nstderr={stderr}\nstdout={stdout}"
        stats = _parse_json_tail(stdout)
        for key in ("discovered", "inserted", "skippedDone", "parseFailed", "durationMs"):
            assert key in stats, f"missing {key} in ingest stats: {stats}"

        # Status must still work afterwards — checkpoint rows may exist.
        rc, stdout, _ = _run_memory_cli(root, "status", "--json", cwd=scratch)
        assert rc == 0, f"post-ingest status failed: {stdout}"
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)
