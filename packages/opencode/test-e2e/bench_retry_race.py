#!/usr/bin/env python3
"""Benchmark for the HTTP retry-race orchestrator.

What it measures
----------------
Wall-clock latency per ``POST /turn/start`` in two configurations:

    1. Retry-race OFF (``OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED=false``)
    2. Retry-race ON  (default: ``enabled: true``, stagger 45s,
       concurrency 2, 3 max attempts, 3-minute deadline)

Each configuration drives ``N`` sequential turns with SGR
(``format={"type": "json_schema", "schema": ...}``) so every turn
produces a pydantic-validated JSON plan — the same surface the
``test_sgr_determinism.py`` suite exercises. Determinism is a non-goal
here; we only care about wall-clock tail latency.

What it asserts
---------------
``p99_on <  p99_off`` — the headline claim for the fork's retry-race
default flip. If this is false, either the race isn't wired, the
stagger is too long to intercept the observed tail, or upstream
latency is uniformly fast (no stalls to race against).

Usage
-----
From ``packages/opencode/test-e2e/``::

    .venv/bin/python bench_retry_race.py

Or override anything::

    .venv/bin/python bench_retry_race.py \\
        --turns 10 \\
        --provider github-copilot \\
        --model gpt-4.1 \\
        --per-turn-timeout 300

Env overrides:

    ``BENCH_RETRY_RACE_TURNS``               (default: 10)
    ``BENCH_RETRY_RACE_PER_TURN_TIMEOUT_S``  (default: 300.0)
    ``BENCH_RETRY_RACE_PROVIDER``            (default: auto)
    ``BENCH_RETRY_RACE_MODEL``               (default: auto)
    ``OPENCODE_BINARY``                      (default: /Users/dave/.local/bin/opencode-unify)

Why not a pytest test
---------------------
This is a wall-clock benchmark, not a functional test. It needs its
own isolated server for each configuration (otherwise the seeded
``httpRetryRaceCfg`` bleeds across runs), and its timing targets are
not apt for pytest-timeout. Keeping it as a standalone script also
lets operators re-run it after config tweaks without spinning up the
full pytest harness.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from harness import (  # noqa: E402
    OpencodeClient,
    OpencodeServer,
    has_copilot_credentials,
    prepare_isolated_home,
    resolve_opencode_binary,
)
from harness.sgr import run_sgr_turn  # noqa: E402

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_TURNS = 10
DEFAULT_PER_TURN_TIMEOUT_S = 300.0
DEFAULT_PROVIDER = "github-copilot"
DEFAULT_MODEL = "gpt-4.1"

# ``Plan`` schema — small enough that SGR finishes in 15-30s on a healthy
# provider, large enough to exercise the JSON-schema validation path end
# to end. We intentionally do NOT use pydantic here because the bench is
# a standalone script that imports cleanly even when the pydantic version
# doesn't match the harness; the schema is authored verbatim.
PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["goal", "steps"],
    "properties": {
        "goal": {
            "type": "string",
            "description": "One-sentence description of the plan goal.",
            "minLength": 1,
        },
        "steps": {
            "type": "array",
            "description": "Ordered steps that achieve the goal.",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["step", "description"],
                "properties": {
                    "step": {"type": "integer", "minimum": 1},
                    "description": {"type": "string", "minLength": 1},
                },
            },
        },
    },
}

BENCH_PROMPT = (
    "Produce a JSON plan with a short `goal` and 2-3 concrete `steps` "
    "describing how to add a new subcommand to a Python CLI built on "
    "Click. Each step should have a 1-based integer `step` number and a "
    "one-sentence `description`. Return only the plan via the "
    "StructuredOutput tool."
)


# ---------------------------------------------------------------------------
# Stats helpers
# ---------------------------------------------------------------------------


def percentile(values: list[float], p: float) -> float:
    """Linear-interpolated percentile matching ``numpy.percentile``.

    Accepts ``p`` in ``[0, 100]``. Returns the ``p``-th percentile of
    ``values``. Handles small N (the bench default is 10) correctly:
    for ``p=99`` on N=10 the cut lands at index 8.91, interpolating
    between the 9th and 10th data points.
    """
    if not values:
        return float("nan")
    sorted_vals = sorted(values)
    k = (len(sorted_vals) - 1) * (p / 100.0)
    low = int(math.floor(k))
    high = int(math.ceil(k))
    if low == high:
        return sorted_vals[low]
    frac = k - low
    return sorted_vals[low] * (1.0 - frac) + sorted_vals[high] * frac


def summarize(label: str, latencies: list[float]) -> dict[str, float]:
    """Return ``{p50, p95, p99, mean, min, max, n}`` for ``latencies``.

    ``label`` is stored so the caller can feed multiple summaries into
    the final report table without tracking their origin externally.
    """
    out: dict[str, float] = {
        "label": label,  # type: ignore[assignment] — string for reporting
        "n": float(len(latencies)),
        "p50": percentile(latencies, 50),
        "p95": percentile(latencies, 95),
        "p99": percentile(latencies, 99),
        "min": min(latencies) if latencies else float("nan"),
        "max": max(latencies) if latencies else float("nan"),
        "mean": sum(latencies) / len(latencies) if latencies else float("nan"),
    }
    return out


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------


def _resolve_bench_binary(src: str) -> str:
    """Return a symlink-named opencode binary that evades sibling pkill.

    Parallel test harnesses in this repo run ``pkill -9 -f "opencode-unify
    serve"`` to evict stale servers. Matching ``opencode-unify`` on argv[0]
    also kills *our* bench servers mid-run (observed: race-ON server
    exited with code -9 between configs). To insulate ourselves we spawn
    from a differently-named *symlink* — pkill can't match the symlink's
    argv[0]. This mirrors the ``_resolve_sgr_binary`` trick in
    ``test_sgr_determinism.py``.
    """
    dst = "/tmp/opencode-bench-retry-race"
    try:
        real_src = os.path.realpath(src)
    except OSError:
        return src
    try:
        current = os.readlink(dst)
    except (OSError, FileNotFoundError):
        current = None
    if current != real_src:
        # Race-safe re-link: symlink to a tmp name, then atomic rename.
        tmp = dst + f".{os.getpid()}"
        try:
            os.symlink(real_src, tmp)
        except FileExistsError:
            os.unlink(tmp)
            os.symlink(real_src, tmp)
        os.replace(tmp, dst)
    return dst


class BenchServer:
    """Isolated ``opencode serve`` for one benchmark configuration.

    Each config (race on, race off) needs its OWN server because the
    retry-race defaults are read once at plugin-load time via
    ``setHttpRetryRaceConfig(httpRetryRaceConfig(...))``. Sharing a
    single server across configs would mean the second run sees the
    first run's config.

    Copilot credentials are copied in via ``prepare_isolated_home`` so
    live turns can route through the user's real auth.json. The XDG
    env is set via ``OpencodeServer.data_dir``.
    """

    def __init__(
        self,
        *,
        binary: str,
        enable_race: bool,
        project_dir: Path,
    ) -> None:
        self.binary = binary
        self.enable_race = enable_race
        self.project_dir = project_dir
        self.home: Optional[Path] = None
        self.server: Optional[OpencodeServer] = None
        self.client: Optional[OpencodeClient] = None

    def __enter__(self) -> "BenchServer":
        self.home = prepare_isolated_home(preserve_tokens=True)
        env = {
            "OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED": (
                "true" if self.enable_race else "false"
            ),
            # Kick observability up a notch so the server stderr tells us
            # when the race actually spawns a backup attempt.
            "OPENCODE_DEBUG_PROVIDERS": "1",
        }
        self.server = OpencodeServer(
            binary=self.binary,
            data_dir=self.home,
            cwd=self.project_dir,
            ready_timeout_s=60.0,
            capture_stderr=True,
            env=env,
        )
        self.server.start()
        self.client = OpencodeClient(
            self.server.base_url,
            project_directory=str(self.project_dir),
            timeout_s=600.0,
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.client is not None:
            self.client.close()
        if self.server is not None:
            self.server.stop()
        if self.home is not None:
            shutil.rmtree(self.home, ignore_errors=True)


# ---------------------------------------------------------------------------
# Bench driver
# ---------------------------------------------------------------------------


def run_one_turn(
    client: OpencodeClient,
    *,
    provider: str,
    model: str,
    per_turn_timeout_s: float,
) -> tuple[float, bool, str]:
    """Drive one SGR turn and return ``(latency_s, ok, diagnostic)``.

    ``ok == True`` when the server returned a structured payload that
    parses as a dict with the ``goal``/``steps`` top-level keys.
    ``diagnostic`` carries a short human-readable reason on failure
    (so the final report can attribute skews to upstream rather than
    to the race).

    On timeout or protocol error we still return a latency — the
    wall-clock up to the failure point — but with ``ok=False``. The
    final report excludes those from the percentile computation so a
    single stuck turn doesn't dominate the p99.
    """
    started = time.monotonic()
    try:
        structured, _message = run_sgr_turn(
            client,
            model={"providerID": provider, "modelID": model},
            prompt=BENCH_PROMPT,
            schema=PLAN_SCHEMA,
            poll_timeout_s=per_turn_timeout_s,
        )
    except Exception as err:  # noqa: BLE001 — surface in report
        elapsed = time.monotonic() - started
        return elapsed, False, f"exception: {err!r}"

    elapsed = time.monotonic() - started
    if structured is None:
        return elapsed, False, "no structured payload"
    if not isinstance(structured, dict):
        return elapsed, False, f"structured not dict: {type(structured).__name__}"
    if "goal" not in structured or "steps" not in structured:
        return elapsed, False, f"missing keys: {sorted(structured)}"
    return elapsed, True, "ok"


def bench_config(
    *,
    binary: str,
    enable_race: bool,
    turns: int,
    provider: str,
    model: str,
    per_turn_timeout_s: float,
    project_dir: Path,
) -> tuple[list[float], list[tuple[int, float, bool, str]]]:
    """Run ``turns`` sequential SGR turns under one configuration.

    Returns ``(ok_latencies, all_rows)`` where ``all_rows`` has one
    ``(index, latency_s, ok, diagnostic)`` tuple per turn — the caller
    uses ``ok_latencies`` for percentile stats and ``all_rows`` for the
    per-turn table.
    """
    ok_latencies: list[float] = []
    rows: list[tuple[int, float, bool, str]] = []
    config_label = "ON " if enable_race else "OFF"

    with BenchServer(
        binary=binary, enable_race=enable_race, project_dir=project_dir
    ) as bs:
        assert bs.client is not None
        print(
            f"[bench] race {config_label} — server {bs.server.base_url if bs.server else '?'} "
            f"home={bs.home}",
            flush=True,
        )
        for i in range(1, turns + 1):
            elapsed, ok, diag = run_one_turn(
                bs.client,
                provider=provider,
                model=model,
                per_turn_timeout_s=per_turn_timeout_s,
            )
            rows.append((i, elapsed, ok, diag))
            if ok:
                ok_latencies.append(elapsed)
            print(
                f"[bench] race {config_label} turn {i}/{turns} "
                f"{elapsed:.2f}s ok={ok} {diag}",
                flush=True,
            )

    return ok_latencies, rows


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def print_summary(
    summary_off: dict[str, float],
    summary_on: dict[str, float],
    rows_off: list[tuple[int, float, bool, str]],
    rows_on: list[tuple[int, float, bool, str]],
) -> None:
    """Render the before/after table + the assertion verdict."""
    print("")
    print("=" * 78)
    print("Retry-race benchmark — per-turn latencies")
    print("=" * 78)

    def _row_block(label: str, rows: list[tuple[int, float, bool, str]]) -> None:
        print(f"\n[{label}]  n={len(rows)}")
        print("  turn   latency_s   ok  diagnostic")
        for (i, elapsed, ok, diag) in rows:
            print(f"  {i:>4}   {elapsed:>9.2f}   {str(ok):>5}  {diag}")

    _row_block("race OFF", rows_off)
    _row_block("race ON ", rows_on)

    print("\n" + "=" * 78)
    print("Summary (excludes failed turns)")
    print("=" * 78)
    header = f"{'config':<10} {'n':>3} {'mean':>8} {'p50':>8} {'p95':>8} {'p99':>8} {'min':>8} {'max':>8}"
    print(header)
    print("-" * len(header))
    for s in (summary_off, summary_on):
        print(
            f"{s['label']:<10} "
            f"{int(s['n']):>3} "
            f"{s['mean']:>8.2f} "
            f"{s['p50']:>8.2f} "
            f"{s['p95']:>8.2f} "
            f"{s['p99']:>8.2f} "
            f"{s['min']:>8.2f} "
            f"{s['max']:>8.2f}"
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Retry-race latency benchmark")
    parser.add_argument(
        "--turns",
        type=int,
        default=int(os.environ.get("BENCH_RETRY_RACE_TURNS", DEFAULT_TURNS)),
        help="Sequential turns per configuration (default 10)",
    )
    parser.add_argument(
        "--per-turn-timeout",
        type=float,
        default=float(
            os.environ.get(
                "BENCH_RETRY_RACE_PER_TURN_TIMEOUT_S", DEFAULT_PER_TURN_TIMEOUT_S
            )
        ),
        help="Per-turn wall-clock budget, seconds (default 300)",
    )
    parser.add_argument(
        "--provider",
        default=os.environ.get("BENCH_RETRY_RACE_PROVIDER", DEFAULT_PROVIDER),
        help="providerID to pass to /turn/start (default github-copilot)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("BENCH_RETRY_RACE_MODEL", DEFAULT_MODEL),
        help="modelID to pass to /turn/start (default gpt-4.1)",
    )
    args = parser.parse_args(argv)

    raw_binary = os.environ.get("OPENCODE_BINARY") or resolve_opencode_binary()
    if not Path(raw_binary).exists():
        print(f"[bench] binary not found: {raw_binary}", file=sys.stderr)
        return 2
    # Route through a non-``opencode-unify`` symlink so sibling pkill
    # patterns in other harnesses don't evict our servers mid-run.
    binary = _resolve_bench_binary(raw_binary)

    if not has_copilot_credentials():
        print(
            "[bench] no github-copilot OAuth token on disk — cannot benchmark "
            "live retry-race without real credentials.",
            file=sys.stderr,
        )
        return 3

    print(
        f"[bench] binary={binary} provider={args.provider} "
        f"model={args.model} turns={args.turns} "
        f"per_turn_timeout={args.per_turn_timeout:.0f}s",
        flush=True,
    )

    with tempfile.TemporaryDirectory(prefix="bench-retry-race-") as td:
        project_dir = Path(td)

        # --- Race OFF ----------------------------------------------------
        off_latencies, off_rows = bench_config(
            binary=binary,
            enable_race=False,
            turns=args.turns,
            provider=args.provider,
            model=args.model,
            per_turn_timeout_s=args.per_turn_timeout,
            project_dir=project_dir,
        )

        # --- Race ON -----------------------------------------------------
        on_latencies, on_rows = bench_config(
            binary=binary,
            enable_race=True,
            turns=args.turns,
            provider=args.provider,
            model=args.model,
            per_turn_timeout_s=args.per_turn_timeout,
            project_dir=project_dir,
        )

    if not off_latencies or not on_latencies:
        print(
            "[bench] no successful turns in one of the runs — cannot compare "
            f"p99. off_ok={len(off_latencies)} on_ok={len(on_latencies)}",
            file=sys.stderr,
        )
        # Still print whatever rows landed so the operator can diagnose.
        summary_off = summarize("race-off", off_latencies)
        summary_on = summarize("race-on", on_latencies)
        print_summary(summary_off, summary_on, off_rows, on_rows)
        return 4

    summary_off = summarize("race-off", off_latencies)
    summary_on = summarize("race-on", on_latencies)
    print_summary(summary_off, summary_on, off_rows, on_rows)

    # --- Write machine-readable report next to the script ----------------
    report_path = _HERE / "bench_retry_race_report.json"
    try:
        report_path.write_text(
            json.dumps(
                {
                    "turns": args.turns,
                    "provider": args.provider,
                    "model": args.model,
                    "per_turn_timeout_s": args.per_turn_timeout,
                    "race_off": {
                        "latencies_s": off_latencies,
                        "rows": [
                            {"turn": r[0], "latency_s": r[1], "ok": r[2], "diag": r[3]}
                            for r in off_rows
                        ],
                        "summary": summary_off,
                    },
                    "race_on": {
                        "latencies_s": on_latencies,
                        "rows": [
                            {"turn": r[0], "latency_s": r[1], "ok": r[2], "diag": r[3]}
                            for r in on_rows
                        ],
                        "summary": summary_on,
                    },
                },
                indent=2,
                default=str,
            )
        )
        print(f"\n[bench] wrote machine-readable report: {report_path}")
    except OSError as err:
        print(f"[bench] failed to write report: {err}", file=sys.stderr)

    # --- Assertion: p99_on < p99_off -------------------------------------
    p99_on = summary_on["p99"]
    p99_off = summary_off["p99"]
    print(
        f"\n[bench] p99_off = {p99_off:.2f}s    p99_on = {p99_on:.2f}s"
        f"    delta = {p99_off - p99_on:+.2f}s"
    )
    if p99_on < p99_off:
        print("[bench] PASS — retry-race reduces p99 latency")
        return 0

    print(
        "[bench] FAIL — retry-race did not reduce p99 latency. "
        "This may indicate upstream is uniformly fast (no stalls to race), "
        "the stagger is too long to intercept observed tail events, or a "
        "regression in the race itself.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
