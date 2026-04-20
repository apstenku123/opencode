"""Unit tests for the cross-process session mutex declared in conftest.py.

Validates the :pyfunc:`conftest._e2e_session_lock` contract:

    - Path: ``/tmp/opencode-e2e.lock``
    - Acquire via ``filelock.FileLock(path, timeout=900)``
    - Second process blocks until the first releases
    - Timeout raises ``filelock.Timeout`` cleanly

The tests exercise the lock from subprocesses (not from the pytest
session itself — that one already holds the lock via the autouse
fixture). We use an *alternate* lock path for these tests so they don't
deadlock against the parent session's held ``/tmp/opencode-e2e.lock``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


import conftest


_HELPER_SCRIPT = """\
import sys
import time
from filelock import FileLock, Timeout

path = sys.argv[1]
hold_s = float(sys.argv[2])
acquire_timeout = float(sys.argv[3])

lock = FileLock(path, timeout=acquire_timeout)
try:
    t0 = time.monotonic()
    lock.acquire(timeout=acquire_timeout)
    waited = time.monotonic() - t0
    print(f"ACQUIRED waited={waited:.2f}", flush=True)
    time.sleep(hold_s)
    lock.release()
    print("RELEASED", flush=True)
    sys.exit(0)
except Timeout:
    print("TIMEOUT", flush=True)
    sys.exit(2)
"""


def _run_child(
    lock_path: str,
    hold_s: float,
    acquire_timeout: float,
) -> subprocess.Popen[str]:
    """Spawn a Python subprocess that acquires ``lock_path`` for ``hold_s``."""
    return subprocess.Popen(
        [sys.executable, "-c", _HELPER_SCRIPT, lock_path, str(hold_s), str(acquire_timeout)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def test_session_lock_blocks_second_process_until_first_releases(
    tmp_path: Path,
) -> None:
    """Second subprocess must wait for first to release, then acquire."""
    lock_path = str(tmp_path / "test-session.lock")

    # Process A: acquires for ~1.5s
    a = _run_child(lock_path, hold_s=1.5, acquire_timeout=10.0)
    # Give A a moment to acquire before B races in.
    # Poll its stdout for the ACQUIRED line.
    deadline = time.monotonic() + 5.0
    acquired = False
    while time.monotonic() < deadline:
        if a.stdout is not None:
            # Non-blocking-ish read via poll: use a tiny sleep + check whether
            # the process has emitted its first line.
            time.sleep(0.05)
            # Re-use os.read on the fd so we don't block on readline.
            try:
                import fcntl
                import os as _os
                flags = fcntl.fcntl(a.stdout.fileno(), fcntl.F_GETFL)
                fcntl.fcntl(a.stdout.fileno(), fcntl.F_SETFL, flags | _os.O_NONBLOCK)
                try:
                    data = _os.read(a.stdout.fileno(), 4096)
                    if b"ACQUIRED" in data:
                        acquired = True
                        break
                except BlockingIOError:
                    pass
            except Exception:
                break
    assert acquired, "process A never logged ACQUIRED within 5s"

    # Process B: now tries to acquire — must block and wait for A to release.
    t_b_start = time.monotonic()
    b = _run_child(lock_path, hold_s=0.1, acquire_timeout=10.0)
    b_out, b_err = b.communicate(timeout=10.0)
    t_b_wait = time.monotonic() - t_b_start

    # B had to wait for A to finish its hold (~1.5s).
    assert b.returncode == 0, f"B failed: rc={b.returncode} stdout={b_out!r} stderr={b_err!r}"
    assert "ACQUIRED" in b_out, f"B never acquired: {b_out!r}"
    # B should have waited at least ~0.5s (A's remaining hold time).
    assert t_b_wait >= 0.5, (
        f"B didn't block — wait={t_b_wait:.2f}s, expected >=0.5s. stdout={b_out!r}"
    )

    # Drain A.
    a.wait(timeout=5.0)
    assert a.returncode == 0


def test_session_lock_timeout_raises(tmp_path: Path) -> None:
    """When a process holds longer than the second's timeout, the second
    gets a ``Timeout`` exit (rc=2 per the helper contract)."""
    lock_path = str(tmp_path / "test-timeout.lock")

    # A holds for 3 seconds.
    a = _run_child(lock_path, hold_s=3.0, acquire_timeout=10.0)
    # Wait briefly for A to acquire.
    time.sleep(0.3)

    # B has a 0.5s acquire timeout — should time out.
    t0 = time.monotonic()
    b = _run_child(lock_path, hold_s=0.1, acquire_timeout=0.5)
    b_out, _ = b.communicate(timeout=5.0)
    elapsed = time.monotonic() - t0

    assert b.returncode == 2, f"B should have timed out, got rc={b.returncode}: {b_out!r}"
    assert "TIMEOUT" in b_out
    # Timed out within its acquire window — allow wide slack for CI jitter.
    assert elapsed < 3.0, f"B took {elapsed:.2f}s to time out — too slow"

    a.wait(timeout=5.0)


def test_session_lock_meta_file_is_written_by_parent_fixture() -> None:
    """The autouse fixture writes ``/tmp/opencode-e2e.lock.meta`` on acquire.

    The parent pytest process holds the lock for this test, so the meta
    file must exist and carry our pid.
    """
    import json

    meta_path = Path("/tmp/opencode-e2e.lock.meta")
    assert meta_path.exists(), "meta file not written by autouse fixture"
    meta = json.loads(meta_path.read_text())
    assert meta.get("pid") == os.getpid(), (
        f"meta pid {meta.get('pid')!r} != our pid {os.getpid()}"
    )
    assert isinstance(meta.get("started_at"), (int, float))
    assert isinstance(meta.get("suite_names"), list)


def test_break_stale_lock_does_not_evict_live_holder_based_on_age(tmp_path: Path) -> None:
    """A live holder older than the timeout must still keep the lock path intact."""
    lock_path = tmp_path / "live-holder.lock"
    meta_path = tmp_path / "live-holder.lock.meta"

    lock_path.write_text("held")
    meta_path.write_text(
        __import__("json").dumps(
            {
                "pid": os.getpid(),
                "started_at": time.time() - (conftest.E2E_LOCK_TIMEOUT_S + 60),
                "suite_names": ["test_break_stale_lock_does_not_evict_live_holder_based_on_age"],
            }
        )
    )

    original_lock = conftest.E2E_LOCK_PATH
    original_meta = conftest.E2E_LOCK_META_PATH
    try:
        conftest.E2E_LOCK_PATH = str(lock_path)
        conftest.E2E_LOCK_META_PATH = str(meta_path)
        conftest._break_stale_lock_if_present()
    finally:
        conftest.E2E_LOCK_PATH = original_lock
        conftest.E2E_LOCK_META_PATH = original_meta

    assert lock_path.exists(), "live holder lock path was incorrectly removed"
    assert meta_path.exists(), "live holder meta path was incorrectly removed"
