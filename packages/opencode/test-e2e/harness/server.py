"""OpencodeServer — spawn and manage an ``opencode serve`` subprocess."""

from __future__ import annotations

import fcntl
import os
import select
import socket
import subprocess
import threading
import time
from contextlib import closing
from pathlib import Path
from typing import Optional

import httpx

from .home import xdg_env_for


def _pick_free_port() -> int:
    """Ask the OS for an ephemeral port, close it, and return the number.

    Racy by definition, but acceptable for test bootstrap — ``opencode serve``
    will fail fast if the port is already taken by the time we spawn.
    """
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class OpencodeServer:
    """Spawns ``opencode serve --port N`` and exposes its HTTP base URL.

    Usage::

        with OpencodeServer() as server:
            print(server.base_url)   # e.g. http://127.0.0.1:54321

    The server is killed (SIGTERM, then SIGKILL) on context exit or ``stop()``.
    """

    def __init__(
        self,
        binary: Optional[str] = None,
        *,
        port: Optional[int] = None,
        hostname: str = "127.0.0.1",
        extra_args: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
        cwd: Optional[str | Path] = None,
        ready_timeout_s: float = 10.0,
        print_logs: bool = False,
        data_dir: Optional[str | Path] = None,
        capture_stderr: bool = False,
    ) -> None:
        from . import resolve_opencode_binary

        self.binary = binary or resolve_opencode_binary()
        self.port = port if port is not None else _pick_free_port()
        self.hostname = hostname
        self.extra_args = list(extra_args or [])
        self.env = env
        self.cwd = str(cwd) if cwd is not None else None
        self.ready_timeout_s = ready_timeout_s
        self.print_logs = print_logs
        # ``data_dir`` is the root produced by ``isolated_opencode_home`` —
        # i.e. ``<root>/data/opencode`` holds ``auth.json`` etc. We translate
        # it into XDG env vars when spawning the subprocess.
        self.data_dir: Optional[Path] = Path(data_dir) if data_dir is not None else None
        # When ``capture_stderr`` is True (or ``data_dir`` is set — the live
        # Copilot tests need stderr for account-discovery log scraping) we
        # append stderr to an internal buffer readable via ``stderr_text``.
        self.capture_stderr = capture_stderr or self.data_dir is not None

        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._stderr_buf: list[bytes] = []
        self._stderr_lock = threading.Lock()
        self._stderr_thread: Optional[threading.Thread] = None

    # --- lifecycle -----------------------------------------------------

    @property
    def base_url(self) -> str:
        return f"http://{self.hostname}:{self.port}"

    def start(self) -> "OpencodeServer":
        if self._proc is not None:
            raise RuntimeError("OpencodeServer already started")

        if not Path(self.binary).exists():
            raise FileNotFoundError(f"opencode binary not found: {self.binary}")

        cmd = [
            self.binary,
            "serve",
            "--port",
            str(self.port),
            "--hostname",
            self.hostname,
        ]
        if self.print_logs:
            cmd.append("--print-logs")
        cmd.extend(self.extra_args)

        env = dict(os.environ)
        # XDG env vars come first so caller-provided ``env`` can still
        # override individual entries (e.g. override HOME or add a debug
        # flag). This is how we isolate opencode's data dir for live tests.
        if self.data_dir is not None:
            # Ensure the subdirs exist — ``xdg-basedir`` reads the env vars
            # verbatim and opencode will ``mkdir -p`` them on start, but we
            # pre-create so ``auth.json`` is already present at the right path.
            for sub in ("data", "cache", "config", "state"):
                (self.data_dir / sub / "opencode").mkdir(parents=True, exist_ok=True)
            env.update(xdg_env_for(self.data_dir))
        if self.env:
            env.update(self.env)

        stdout = None if self.print_logs else subprocess.DEVNULL
        # When capturing stderr for log inspection we pipe it through a
        # reader thread; otherwise we pass it through or drop it.
        if self.capture_stderr:
            stderr = subprocess.PIPE
        else:
            stderr = None if self.print_logs else subprocess.DEVNULL

        # NOTE: we intentionally do NOT use ``start_new_session=True`` here.
        # On macOS the opencode single-exec bundle interacts poorly with a
        # detached session and can be killed by the kernel (SIGKILL/-9)
        # before it finishes initialising. Keeping it in the parent session
        # works reliably; to still kill the whole tree on teardown we track
        # the pid and fall back to ``terminate()/kill()``.
        self._proc = subprocess.Popen(
            cmd,
            stdout=stdout,
            stderr=stderr,
            env=env,
            cwd=self.cwd,
        )

        if self.capture_stderr and self._proc.stderr is not None:
            self._stderr_thread = threading.Thread(
                target=self._drain_stderr,
                args=(self._proc.stderr,),
                daemon=True,
            )
            self._stderr_thread.start()

        try:
            self._wait_for_ready()
        except Exception:
            self.stop()
            raise

        return self

    def _drain_stderr(self, stream) -> None:
        """Background reader that appends stderr chunks to ``self._stderr_buf``.

        Uses ``fcntl`` to put the stream fd into non-blocking mode and
        ``select.select`` with a short timeout so the reader thread can
        exit promptly when ``stop()`` closes the pipe. Previously this
        looped on ``stream.read(4096)`` which blocks indefinitely until
        the kernel returns data — that caused per-test 120s hangs when
        the subprocess exited cleanly but stderr pipe shutdown lagged
        (e.g. test_memory.py::test_phase1_extracts_sextuples).

        Also mirrors to the parent process's stderr when ``print_logs`` is
        set, so pytest ``-s`` still shows logs interactively.
        """
        try:
            fd = stream.fileno()
        except (AttributeError, OSError):
            # Fallback to the old blocking path if we can't get an fd.
            self._drain_stderr_blocking(stream)
            return

        # Put fd into non-blocking mode.
        try:
            flags = fcntl.fcntl(fd, fcntl.F_GETFL)
            fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        except OSError:
            self._drain_stderr_blocking(stream)
            return

        try:
            while True:
                # Short select timeout — allows prompt exit when the pipe
                # closes during stop().
                try:
                    ready, _, _ = select.select([fd], [], [], 0.5)
                except (OSError, ValueError):
                    return
                if not ready:
                    # Peek at proc status — if the child is gone and the
                    # pipe buffer is drained, bail out.
                    if self._proc is not None and self._proc.poll() is not None:
                        # One final non-blocking read to pick up the tail.
                        try:
                            chunk = os.read(fd, 4096)
                            if chunk:
                                self._record_stderr_chunk(chunk)
                        except (BlockingIOError, OSError):
                            pass
                        return
                    continue
                try:
                    chunk = os.read(fd, 4096)
                except BlockingIOError:
                    continue
                except OSError:
                    return
                if not chunk:
                    # EOF — pipe closed.
                    return
                self._record_stderr_chunk(chunk)
        except Exception:
            # Reader threads must never bubble exceptions — the test will
            # see the missing data via empty ``stderr_text()``.
            pass

    def _drain_stderr_blocking(self, stream) -> None:
        """Fallback blocking drain when fcntl/select isn't available.

        Kept only for platform/pipe objects that don't expose a real fd;
        in the common ``subprocess.Popen(..., stderr=PIPE)`` case this is
        never reached.
        """
        try:
            for chunk in iter(lambda: stream.read(4096), b""):
                if not chunk:
                    break
                self._record_stderr_chunk(chunk)
        except Exception:
            pass

    def _record_stderr_chunk(self, chunk: bytes) -> None:
        with self._stderr_lock:
            self._stderr_buf.append(chunk)
        if self.print_logs:
            try:
                os.write(2, chunk)
            except OSError:
                pass

    def stderr_text(self) -> str:
        """Return the captured stderr so far as a UTF-8 string.

        Only populated when the server was constructed with
        ``capture_stderr=True`` (implicit when ``data_dir`` is set).
        """
        with self._stderr_lock:
            return b"".join(self._stderr_buf).decode("utf-8", errors="replace")

    def stop(self, timeout_s: float = 5.0) -> None:
        proc = self._proc
        stderr_thread = self._stderr_thread
        if proc is None:
            return
        self._proc = None

        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=timeout_s)

        # Close stderr pipe so the non-blocking drain loop sees EOF and
        # exits without waiting for the 0.5s select tick.
        try:
            if proc.stderr is not None:
                proc.stderr.close()
        except OSError:
            pass

        # Join the drain thread with a short timeout — prevents a dangling
        # thread from blocking the pytest session teardown (root cause of
        # the 120s hang in test_memory.py::test_phase1_extracts_sextuples).
        if stderr_thread is not None and stderr_thread.is_alive():
            stderr_thread.join(timeout=2.0)
        self._stderr_thread = None

    # --- readiness -----------------------------------------------------

    def _wait_for_ready(self) -> None:
        """Poll GET /global/health until 200 or timeout."""
        deadline = time.monotonic() + self.ready_timeout_s
        url = f"{self.base_url}/global/health"
        last_err: Optional[BaseException] = None
        with httpx.Client(timeout=1.0) as http:
            while time.monotonic() < deadline:
                # Die fast if the subprocess already exited.
                if self._proc is not None and self._proc.poll() is not None:
                    raise RuntimeError(
                        f"opencode serve exited early with code {self._proc.returncode}"
                    )
                try:
                    r = http.get(url)
                    if r.status_code == 200 and r.json().get("healthy") is True:
                        return
                except httpx.HTTPError as e:
                    last_err = e
                time.sleep(0.1)
        raise TimeoutError(
            f"opencode serve did not become ready at {url} within "
            f"{self.ready_timeout_s:.1f}s (last error: {last_err!r})"
        )

    # --- context manager ----------------------------------------------

    def __enter__(self) -> "OpencodeServer":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()
