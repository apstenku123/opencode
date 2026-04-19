"""Inspect the e2e session-lock at ``/tmp/opencode-e2e.lock``.

Usage (from ``packages/opencode/test-e2e/`` with the venv active)::

    python3 -m harness.lock_status

Prints a human-readable report of the current lock state:

    * Whether the lock file exists (kernel-backed ``flock`` path).
    * Whether the audit meta file (``/tmp/opencode-e2e.lock.meta``) exists.
    * Holder PID, holder test suite names, wall-clock age, and whether
      the PID is still alive (detects zombie holders).

Exit codes::

    0 — lock is either free, or held by a live process (healthy state).
    2 — lock/meta is present but the holder PID is dead (stale lock —
        your next pytest invocation will break it automatically via the
        stale-lock sweep in ``conftest._break_stale_lock_if_present``).
    3 — meta file is corrupt / unreadable.

This tool is read-only: it does NOT unlink either file. The conftest
sweep handles that on the next ``pytest`` run.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

LOCK_PATH = "/tmp/opencode-e2e.lock"
META_PATH = "/tmp/opencode-e2e.lock.meta"
HOLD_TIMEOUT_S = 900  # mirror E2E_LOCK_TIMEOUT_S in conftest.py


def _pid_alive(pid: int) -> bool:
    """True iff ``pid`` is a signalable live process on this host."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but we can't signal it — still alive, just owned elsewhere.
        return True
    except OSError:
        return False
    return True


def _format_duration(seconds: float) -> str:
    """Format ``seconds`` as ``HhMmSs`` / ``MmSs`` / ``Ss``."""
    seconds = max(0.0, float(seconds))
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def main() -> int:
    """Print a lock status report. Returns an exit code (see module docstring)."""
    lock_exists = Path(LOCK_PATH).exists()
    meta_path = Path(META_PATH)

    print(f"[e2e-lock] lock file : {LOCK_PATH}")
    print(f"[e2e-lock] exists    : {lock_exists}")
    print(f"[e2e-lock] meta file : {META_PATH}")

    if not meta_path.exists():
        if lock_exists:
            print("[e2e-lock] meta      : MISSING (lock present without meta — "
                  "either pre-acquire window or corrupt state)")
        else:
            print("[e2e-lock] meta      : MISSING (lock is free)")
        return 0

    try:
        meta_raw = meta_path.read_text()
    except OSError as err:
        print(f"[e2e-lock] meta      : UNREADABLE ({err})")
        return 3

    try:
        meta = json.loads(meta_raw)
    except json.JSONDecodeError as err:
        print(f"[e2e-lock] meta      : CORRUPT ({err})")
        print("[e2e-lock] raw:")
        print(meta_raw)
        return 3

    if not isinstance(meta, dict):
        print("[e2e-lock] meta      : CORRUPT (not a JSON object)")
        return 3

    holder_pid = meta.get("pid")
    started_at = meta.get("started_at")
    started_iso = meta.get("started_at_iso") or ""
    suites = meta.get("suite_names") or []

    print(f"[e2e-lock] holder PID: {holder_pid}")
    print(f"[e2e-lock] started  : {started_iso or '<unknown>'}")

    now = time.time()
    if isinstance(started_at, (int, float)):
        elapsed = now - float(started_at)
        print(f"[e2e-lock] elapsed  : {_format_duration(elapsed)} "
              f"({elapsed:.1f}s)")
        if elapsed > HOLD_TIMEOUT_S:
            over = elapsed - HOLD_TIMEOUT_S
            print(f"[e2e-lock] STALE    : held for {_format_duration(over)} "
                  f"beyond the {HOLD_TIMEOUT_S}s cap")
    else:
        print("[e2e-lock] elapsed  : <unknown>")

    if isinstance(suites, list) and suites:
        print(f"[e2e-lock] suites   : {', '.join(str(s) for s in suites)}")
    else:
        print("[e2e-lock] suites   : <none recorded>")

    if isinstance(holder_pid, int):
        alive = _pid_alive(holder_pid)
        print(f"[e2e-lock] holder OK: {alive} ({'alive' if alive else 'DEAD'})")
        if not alive:
            print("[e2e-lock] NOTE    : PID is dead — next pytest run will "
                  "break the lock via conftest._break_stale_lock_if_present.")
            return 2
    else:
        print("[e2e-lock] holder OK: <unknown — missing/non-int pid>")
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
