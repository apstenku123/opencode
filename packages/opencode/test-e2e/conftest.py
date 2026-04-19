"""Pytest fixtures for opencode e2e tests.

Fixtures:
    - ``_e2e_session_lock``          (session-scoped, autouse): cross-process
      mutex. Every pytest invocation under this directory blocks at session
      start until it can acquire ``/tmp/opencode-e2e.lock``. Hard cap: 15 min.
      See :pyfunc:`_e2e_session_lock` for the lock-file semantics.
    - ``opencode_server``            (session-scoped): started ``OpencodeServer``.
    - ``http_client``                (function-scoped): ``OpencodeClient``.
    - ``authenticated_copilot_session`` (function-scoped): thread ID bound to
      the user's real GitHub Copilot account credentials resolved from
      ``~/.local/share/opencode/auth.json``. Skips the test if no Copilot
      OAuth token is on disk.
    - ``copilot_model``              (session-scoped): provider/model pair to
      use for live tests. Overridable via ``OPENCODE_E2E_COPILOT_MODEL``
      (default: ``gpt-4.1``).

Cross-process mutex (``_e2e_session_lock``)
------------------------------------------
Parallel pytest runs — either inside a single agent or across multiple
agents racing on the same workstation — cannot safely share the user's
real Copilot OAuth tokens, the `/tmp/opencode-e2e.lock` inter-process
guards, or the spawned `opencode serve` subprocesses (port allocation is
ephemeral but data dirs and rate-limits are shared). The lock serialises
test sessions:

    - Path: ``/tmp/opencode-e2e.lock`` (POSIX advisory ``flock`` via
      :pymod:`filelock`).
    - Timeout: 900s (15 min). Exceeding it aborts the test session with a
      ``Timeout`` exception.
    - Audit file: ``/tmp/opencode-e2e.lock.meta`` — JSON ``{pid, started_at,
      suite_names}`` written immediately after acquisition. Consumers can
      inspect this to detect stale locks.
    - Stale-lock sweep (pre-acquire): before ``lock.acquire()``, the
      fixture reads the meta file. If ``pid`` is dead OR ``started_at``
      is older than ``E2E_LOCK_TIMEOUT_S``, both files are unlinked so
      the next acquire returns immediately. Covers zombie/SIGKILL holders
      whose ``finally:`` branch never ran.
    - Watchdog (in-process, layer 1): a daemon thread fires at 900s of
      hold time, logs to stderr, sends SIGTERM to the owning process,
      and escalates to SIGKILL after a 30s grace window if SIGTERM was
      swallowed by pytest-timeout / a blocking C extension.
    - Watchdog (kernel, layer 2): ``signal.alarm(1200)`` installs an
      OS-delivered SIGALRM at 20 minutes wall-clock. Survives Python GIL
      stalls, daemon-thread death, and signal masking by subprocesses —
      SIGKILLs the process and relies on kernel fcntl release.
    - Release: ``finally:`` on fixture teardown unlinks both files.

Because the fixture is ``autouse=True``, every pytest invocation under
this directory (``.venv/bin/python -m pytest test_*.py``) picks it up
without any opt-in. Do NOT remove the ``autouse``.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterator

import pytest
from filelock import FileLock, Timeout

# Make ``harness`` importable without installing the package.
_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from harness import (  # noqa: E402
    OpencodeClient,
    OpencodeServer,
    has_copilot_credentials,
    prepare_isolated_home,
    resolve_opencode_binary,
)


# ---------------------------------------------------------------------------
# Cross-process session mutex
# ---------------------------------------------------------------------------

E2E_LOCK_PATH = "/tmp/opencode-e2e.lock"
E2E_LOCK_META_PATH = "/tmp/opencode-e2e.lock.meta"
E2E_LOCK_TIMEOUT_S = 900  # 15 minutes — hard cap for acquisition AND hold-time.
E2E_LOCK_HARD_CEILING_S = 1200  # 20 minutes — last-resort SIGALRM ceiling.


def _write_lock_meta(suite_names: list[str]) -> None:
    """Persist ``{pid, started_at, suite_names}`` next to the lock file.

    Written once per successful acquisition. Stale-lock auditors can
    cross-reference ``pid`` against ``/proc`` / ``ps`` to detect a dead
    holder.
    """
    meta = {
        "pid": os.getpid(),
        "started_at": time.time(),
        "started_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "suite_names": suite_names,
    }
    try:
        Path(E2E_LOCK_META_PATH).write_text(json.dumps(meta, indent=2))
    except OSError:
        # Best-effort — the lock itself holds the mutex, meta is informational.
        pass


def _pid_is_alive(pid: int) -> bool:
    """Return True iff ``pid`` corresponds to a live process.

    ``os.kill(pid, 0)`` raises ``ProcessLookupError`` when the pid is
    dead, ``PermissionError`` when it exists but we can't signal (owned
    by another user — in which case it IS alive), and returns cleanly
    when the pid is alive and signalable.
    """
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we can't signal — still alive.
        return True
    except OSError:
        return False
    return True


def _break_stale_lock_if_present() -> None:
    """Detect and forcibly break a stale ``/tmp/opencode-e2e.lock``.

    Reads ``E2E_LOCK_META_PATH``; if it exists and either:

      - ``pid`` no longer points to a live process, or
      - ``started_at`` is more than ``E2E_LOCK_TIMEOUT_S`` old

    the lock+meta files are unlinked so the next ``lock.acquire()``
    succeeds immediately. Covers the case where a prior pytest session
    died (SIGKILL, power loss, zombie state) without running its
    ``finally:`` branch to release the lock.

    Safe to call unconditionally: if the meta file is absent or the
    holder is healthy, this is a no-op.
    """
    meta_path = Path(E2E_LOCK_META_PATH)
    if not meta_path.exists():
        return
    try:
        meta = json.loads(meta_path.read_text())
    except (OSError, json.JSONDecodeError):
        # Corrupt meta — treat as stale and break.
        meta = None

    holder_pid = None
    started_at = None
    if isinstance(meta, dict):
        if isinstance(meta.get("pid"), int):
            holder_pid = meta["pid"]
        if isinstance(meta.get("started_at"), (int, float)):
            started_at = float(meta["started_at"])

    # Our own pid? Don't break — we hold it.
    if holder_pid == os.getpid():
        return

    now = time.time()
    stale = False
    reason = ""

    if holder_pid is None:
        stale = True
        reason = "missing/corrupt pid in meta"
    elif not _pid_is_alive(holder_pid):
        stale = True
        reason = f"holder pid {holder_pid} is dead"
    elif started_at is not None and (now - started_at) > E2E_LOCK_TIMEOUT_S:
        age_s = now - started_at
        stale = True
        reason = (
            f"holder pid {holder_pid} has held for {age_s:.0f}s "
            f"(> {E2E_LOCK_TIMEOUT_S}s cap)"
        )

    if not stale:
        return

    print(
        f"[e2e-lock] STALE: breaking {E2E_LOCK_PATH} — {reason}",
        file=sys.stderr,
        flush=True,
    )
    try:
        Path(E2E_LOCK_PATH).unlink(missing_ok=True)
    except OSError:
        pass
    try:
        meta_path.unlink(missing_ok=True)
    except OSError:
        pass


@pytest.fixture(scope="session", autouse=True)
def _e2e_session_lock(request) -> Iterator[None]:
    """Session-scoped cross-process mutex. See module docstring for semantics.

    Serialises ALL pytest invocations under this conftest.py. Fires a
    watchdog at 900s that ``SIGTERM``s the current process so the
    ``finally:`` branch below runs — thus releasing the lock even on a
    runaway session.

    NO escape hatch: every pytest invocation under this directory MUST
    block on ``/tmp/opencode-e2e.lock``. Peer agents cannot safely share
    the user's real Copilot OAuth tokens or the spawned ``opencode serve``
    subprocesses, so concurrent pytest runs against this suite are
    always wrong. If you need to bypass the lock for iteration, use
    ``flock -n`` externally and inspect ``/tmp/opencode-e2e.lock.meta``
    to see who is holding.
    """
    # Collect suite names for the audit file. ``request.session.items`` is
    # not yet populated at the point this fixture runs (collection happens
    # after session start); fall back to the items actually passed on the
    # CLI via ``request.config.args``.
    suite_names: list[str] = []
    try:
        suite_names = [str(a) for a in request.config.args]
    except Exception:
        pass

    # Pre-acquire stale-lock sweep: if a prior session died holding the
    # lock (SIGKILL, zombie, 6h+ runaway), its meta file points at a dead
    # pid or an over-aged started_at — in which case we unlink both files
    # so lock.acquire() below returns immediately instead of blocking on
    # a ghost.
    _break_stale_lock_if_present()

    lock = FileLock(E2E_LOCK_PATH, timeout=E2E_LOCK_TIMEOUT_S)
    acquire_start = time.monotonic()
    try:
        print(
            f"[e2e-lock] pid={os.getpid()} acquiring {E2E_LOCK_PATH} "
            f"(timeout={E2E_LOCK_TIMEOUT_S}s)...",
            file=sys.stderr,
            flush=True,
        )
        try:
            lock.acquire(timeout=E2E_LOCK_TIMEOUT_S)
        except Timeout as err:
            raise pytest.UsageError(
                f"[e2e-lock] could not acquire {E2E_LOCK_PATH} within "
                f"{E2E_LOCK_TIMEOUT_S}s — another pytest session is holding "
                "the mutex or the lock is stale. Inspect "
                f"{E2E_LOCK_META_PATH} for the current holder."
            ) from err
    except Exception:
        raise

    wait_s = time.monotonic() - acquire_start
    print(
        f"[e2e-lock] pid={os.getpid()} acquired {E2E_LOCK_PATH} "
        f"after {wait_s:.1f}s",
        file=sys.stderr,
        flush=True,
    )
    _write_lock_meta(suite_names)
    hold_start = time.monotonic()

    # ---- Watchdog layer 1: polling daemon thread ------------------------
    # Fires SIGTERM at hold_start + E2E_LOCK_TIMEOUT_S. Uses a 1s poll so
    # normal teardown exits quickly via watchdog_stop.
    watchdog_stop = threading.Event()

    def _watchdog() -> None:
        while not watchdog_stop.is_set():
            elapsed = time.monotonic() - hold_start
            if elapsed > E2E_LOCK_TIMEOUT_S:
                print(
                    f"[e2e-lock] WATCHDOG: hold time {elapsed:.0f}s exceeded "
                    f"{E2E_LOCK_TIMEOUT_S}s — aborting session "
                    f"(pid={os.getpid()})",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    os.kill(os.getpid(), signal.SIGTERM)
                except OSError:
                    pass
                # Keep polling — if SIGTERM got swallowed, escalate to
                # SIGKILL after a grace period (covers the case where a
                # pytest-timeout handler or C extension eats the signal).
                grace_deadline = time.monotonic() + 30.0
                while not watchdog_stop.is_set() and time.monotonic() < grace_deadline:
                    watchdog_stop.wait(1.0)
                if not watchdog_stop.is_set():
                    print(
                        f"[e2e-lock] WATCHDOG: SIGTERM swallowed — "
                        f"SIGKILL pid={os.getpid()}",
                        file=sys.stderr,
                        flush=True,
                    )
                    try:
                        os.kill(os.getpid(), signal.SIGKILL)
                    except OSError:
                        pass
                return
            watchdog_stop.wait(1.0)

    watchdog = threading.Thread(
        target=_watchdog, name="e2e-lock-watchdog", daemon=True
    )
    watchdog.start()

    # ---- Watchdog layer 2: OS-backed SIGALRM ceiling ---------------------
    # signal.alarm() is kernel-delivered — survives daemon-thread death,
    # Python GIL stalls, and C-extension blocking calls. If the polling
    # watchdog above is killed/swallowed, the kernel still fires SIGALRM
    # at E2E_LOCK_HARD_CEILING_S wall-clock seconds and pytest unwinds
    # via the default SIGALRM handler (raises KeyboardInterrupt-like
    # exit). Only valid in the main thread of the main interpreter.
    prev_alarm_handler = None
    prev_alarm_remaining = 0
    alarm_installed = False
    try:
        def _sigalrm_ceiling(_signo: int, _frame: object) -> None:
            print(
                f"[e2e-lock] SIGALRM CEILING: {E2E_LOCK_HARD_CEILING_S}s "
                f"wall-clock exceeded — SIGKILL pid={os.getpid()}",
                file=sys.stderr,
                flush=True,
            )
            # No finally-release path can be trusted at this depth; just
            # unlink meta and die. The kernel releases fcntl locks on
            # process exit, so the lock file itself is freed.
            try:
                Path(E2E_LOCK_META_PATH).unlink(missing_ok=True)
            except OSError:
                pass
            os.kill(os.getpid(), signal.SIGKILL)

        prev_alarm_handler = signal.signal(signal.SIGALRM, _sigalrm_ceiling)
        prev_alarm_remaining = signal.alarm(E2E_LOCK_HARD_CEILING_S)
        alarm_installed = True
    except (ValueError, OSError):
        # Not the main thread, or platform without SIGALRM. The polling
        # watchdog above is still in play — degrade gracefully.
        pass

    try:
        yield
    finally:
        watchdog_stop.set()
        if alarm_installed:
            try:
                signal.alarm(0)
            except OSError:
                pass
            if prev_alarm_handler is not None:
                try:
                    signal.signal(signal.SIGALRM, prev_alarm_handler)
                except (ValueError, OSError):
                    pass
            if prev_alarm_remaining > 0:
                try:
                    signal.alarm(prev_alarm_remaining)
                except OSError:
                    pass
        held_s = time.monotonic() - hold_start
        try:
            lock.release()
        except Exception:
            pass
        try:
            Path(E2E_LOCK_META_PATH).unlink(missing_ok=True)
        except OSError:
            pass
        print(
            f"[e2e-lock] pid={os.getpid()} released {E2E_LOCK_PATH} "
            f"after {held_s:.1f}s",
            file=sys.stderr,
            flush=True,
        )


def pytest_configure(config) -> None:
    """Register custom pytest markers used by live-LLM tests."""
    config.addinivalue_line(
        "markers",
        "live: live-LLM smoke tests that call a real provider (opt-in: "
        "-m live). Require real Copilot credentials on disk.",
    )


@pytest.fixture(scope="session")
def project_dir() -> Iterator[Path]:
    """Isolated workspace directory for the test session.

    Sent as ``x-opencode-directory`` on every request so the server uses a
    scratch project rather than the harness's own repo.
    """
    with tempfile.TemporaryDirectory(prefix="opencode-e2e-") as d:
        yield Path(d)


@pytest.fixture(scope="session")
def opencode_server(project_dir: Path) -> Iterator[OpencodeServer]:
    """Start one ``opencode serve`` for the whole test session."""
    with OpencodeServer(ready_timeout_s=20.0, cwd=project_dir) as server:
        yield server


@pytest.fixture()
def http_client(
    opencode_server: OpencodeServer,
    project_dir: Path,
) -> Iterator[OpencodeClient]:
    """Fresh HTTP client per test, bound to the shared server.

    timeout_s=300s so live-LLM /session/.../message calls (which block
    for the full assistant turn) don't raise httpx.ReadTimeout on slow
    Copilot plans.
    """
    with OpencodeClient(
        opencode_server.base_url,
        project_directory=str(project_dir),
        timeout_s=300.0,
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Copilot live-account fixtures
# ---------------------------------------------------------------------------


def _copilot_auth_present() -> bool:
    """Return True iff a GitHub Copilot OAuth token is on disk.

    Opencode persists auth at ``~/.local/share/opencode/auth.json`` as::

        { "github-copilot": {"type": "oauth", "refresh": "...", ...} }

    We don't decode the token — the server will refresh it on first use.
    """
    auth_path = Path.home() / ".local/share/opencode/auth.json"
    if not auth_path.exists():
        return False
    try:
        data = json.loads(auth_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    for key, entry in data.items():
        if not key.startswith("github-copilot"):
            continue
        if isinstance(entry, dict) and entry.get("type") == "oauth":
            return True
    return False


@pytest.fixture(scope="session")
def copilot_model() -> dict[str, str]:
    """Provider/model pair for live Copilot tests.

    Defaults to ``github-copilot / gpt-4o`` — swap via
    ``OPENCODE_E2E_COPILOT_MODEL=<modelID>``.
    """
    return {
        "providerID": os.environ.get(
            "OPENCODE_E2E_COPILOT_PROVIDER",
            "github-copilot#edu",
        ),
        "modelID": os.environ.get(
            "OPENCODE_E2E_COPILOT_MODEL",
            "gpt-4.1",
        ),
    }


# ---------------------------------------------------------------------------
# Live Copilot fixtures — isolated home + real multi-account credentials
# ---------------------------------------------------------------------------


def _require_copilot_credentials() -> None:
    """Skip the test when the user's real opencode home has no Copilot creds."""
    if not has_copilot_credentials():
        pytest.skip(
            "No github-copilot OAuth token found at "
            "~/.local/share/opencode/auth.json — skipping live Copilot test."
        )


@pytest.fixture(scope="session")
def isolated_copilot_home() -> Iterator[Path]:
    """Copy the user's real Copilot credentials into a fresh tmpdir.

    Yields the tmpdir root; XDG env vars pointing at it are built via
    ``harness.xdg_env_for(root)``. Session-scoped so all live tests share
    the same isolated home (and therefore the same account discovery
    state, which avoids re-probing for every test).
    """
    _require_copilot_credentials()
    import shutil

    root = prepare_isolated_home(preserve_tokens=True)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="session")
def live_copilot_server(
    isolated_copilot_home: Path,
    project_dir: Path,
) -> Iterator[tuple[OpencodeServer, OpencodeClient]]:
    """Start ``opencode serve`` with XDG env pointing at the isolated home.

    Yields ``(server, client)``. The server is given a longer readiness
    window and stderr capture so tests can scrape per-account discovery
    logs like ``discovered Copilot account API endpoint``.
    """
    server = OpencodeServer(
        data_dir=isolated_copilot_home,
        cwd=project_dir,
        ready_timeout_s=30.0,
        capture_stderr=True,
        env={
            # Opencode checks these for verbose logging; keep the stream
            # chatty enough for account-discovery assertions.
            "OPENCODE_DEBUG_PROVIDERS": "1",
        },
    )
    with server:
        with OpencodeClient(
            server.base_url,
            project_directory=str(project_dir),
            timeout_s=180.0,
        ) as client:
            yield server, client


@pytest.fixture(scope="session")
def live_copilot_model(isolated_copilot_home: Path) -> dict[str, str]:
    """Resolve the model to use for live Copilot turns.

    Precedence:
        1. Explicit ``OPENCODE_E2E_PROVIDER`` + ``OPENCODE_E2E_MODEL`` env.
        2. ``gpt-4.1`` when it's advertised under any ``github-copilot*``
           account's ``discovery.models`` in ``copilot-connections.json`` —
           this is the verified-present model on the ``#edu`` provider and
           is far more widely routed than ``gpt-4o`` on enterprise plans.
        3. Otherwise the first non-``gpt-4o`` model in discovery.models.
        4. Fallback to ``github-copilot / gpt-4.1`` regardless.

    Rationale: ``gpt-4o`` is rejected by the ``#edu`` provider endpoint on
    some enterprise plans (``APIError: The requested model is not
    supported``). ``gpt-4.1`` is verified-present across all accounts in
    the test workstation's ``copilot-connections.json`` discovery output.
    """
    env_provider = os.environ.get("OPENCODE_E2E_PROVIDER")
    env_model = os.environ.get("OPENCODE_E2E_MODEL")
    if env_provider and env_model:
        return {"providerID": env_provider, "modelID": env_model}

    # Inspect the isolated home's copilot-connections.json for a model.
    conn_path = isolated_copilot_home / "data" / "opencode" / "copilot-connections.json"
    try:
        data = json.loads(conn_path.read_text())
    except (OSError, json.JSONDecodeError):
        data = None

    discovered: list[str] = []
    if isinstance(data, dict):
        connections = data.get("connections") or {}
        for conn in connections.values():
            if not isinstance(conn, dict):
                continue
            discovery = conn.get("discovery") or {}
            models = discovery.get("models") if isinstance(discovery, dict) else None
            if isinstance(models, list):
                for candidate in models:
                    if isinstance(candidate, str) and candidate and candidate not in discovered:
                        discovered.append(candidate)

    # Prefer gpt-4.1 (verified present on #edu) over the first-discovered
    # model, which on this workstation is often gpt-4o → provider rejects.
    if "gpt-4.1" in discovered:
        model_id = "gpt-4.1"
    else:
        non_4o = [m for m in discovered if m != "gpt-4o"]
        model_id = non_4o[0] if non_4o else "gpt-4.1"

    return {"providerID": "github-copilot", "modelID": model_id}


@pytest.fixture()
def authenticated_copilot_session(
    http_client: OpencodeClient,
) -> Iterator[str]:
    """Create a thread with Copilot creds verified to be on disk.

    Skips the test when no ``github-copilot`` OAuth token is stored — live
    LLM tests must be opt-in via the user's own credentials. No mocks, no
    fake provider overrides.

    Yields the thread ID. The underlying session is not deleted on teardown
    so post-mortem inspection via ``/session/:id`` remains possible.
    """
    if not _copilot_auth_present():
        pytest.skip(
            "No github-copilot OAuth token found at "
            "~/.local/share/opencode/auth.json — skipping live LLM test."
        )
    thread = http_client.create_thread()
    thread_id = thread["id"]
    yield thread_id
