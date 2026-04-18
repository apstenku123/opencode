"""OpencodeServer — spawn and manage an ``opencode serve`` subprocess.

Supports two drivers selected automatically:

  * ``binary`` — an already-built native binary (e.g. ``opencode-unify``).
  * ``source`` — ``bun run --conditions=browser packages/opencode/src/index.ts``
    for tests that need to pick up uncommitted source edits without
    rebuilding the binary. Activated when ``OPENCODE_E2E_FROM_SOURCE=1``
    or when the harness is instantiated with ``from_source=True``.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
from contextlib import closing
from pathlib import Path
from typing import Optional

import httpx


def _pick_free_port() -> int:
    """Ask the OS for an ephemeral port, close it, and return the number.

    Racy by definition, but acceptable for test bootstrap — ``opencode serve``
    will fail fast if the port is already taken by the time we spawn.
    """
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _default_package_dir() -> Path:
    """Resolve ``packages/opencode`` from this file's location (works
    both in-repo and in worktrees).
    """
    # __file__ = .../packages/opencode/test-e2e/harness/server.py
    return Path(__file__).resolve().parents[2]


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
        from_source: Optional[bool] = None,
        package_dir: Optional[str | Path] = None,
    ) -> None:
        from . import resolve_opencode_binary

        if from_source is None:
            from_source = os.environ.get("OPENCODE_E2E_FROM_SOURCE") == "1"
        self.from_source = from_source
        self.package_dir = Path(package_dir) if package_dir is not None else _default_package_dir()

        self.binary = binary or resolve_opencode_binary()
        self.port = port if port is not None else _pick_free_port()
        self.hostname = hostname
        self.extra_args = list(extra_args or [])
        self.env = env
        self.cwd = str(cwd) if cwd is not None else None
        self.ready_timeout_s = ready_timeout_s
        self.print_logs = print_logs

        self._proc: Optional[subprocess.Popen[bytes]] = None

    # --- lifecycle -----------------------------------------------------

    @property
    def base_url(self) -> str:
        return f"http://{self.hostname}:{self.port}"

    def start(self) -> "OpencodeServer":
        if self._proc is not None:
            raise RuntimeError("OpencodeServer already started")

        if self.from_source:
            entry = self.package_dir / "src" / "index.ts"
            if not entry.exists():
                raise FileNotFoundError(f"opencode source entry not found: {entry}")
            cmd = [
                "bun",
                "run",
                "--conditions=browser",
                str(entry),
                "serve",
                "--port",
                str(self.port),
                "--hostname",
                self.hostname,
            ]
        else:
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
        if self.env:
            env.update(self.env)

        stdout = None if self.print_logs else subprocess.DEVNULL
        stderr = None if self.print_logs else subprocess.DEVNULL

        self._proc = subprocess.Popen(
            cmd,
            stdout=stdout,
            stderr=stderr,
            env=env,
            cwd=self.cwd,
            start_new_session=True,
        )

        try:
            self._wait_for_ready()
        except Exception:
            self.stop()
            raise

        return self

    def stop(self, timeout_s: float = 5.0) -> None:
        proc = self._proc
        if proc is None:
            return
        self._proc = None

        if proc.poll() is not None:
            return

        try:
            # Kill the entire process group — serve may spawn child plugins.
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.terminate()

        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            proc.wait(timeout=timeout_s)

    # --- readiness -----------------------------------------------------

    def _wait_for_ready(self) -> None:
        """Poll GET /global/health until 200 or timeout.

        Falls back to the legacy ``/health`` path on older binaries that
        exposed the unprefixed route.
        """
        deadline = time.monotonic() + self.ready_timeout_s
        urls = [f"{self.base_url}/global/health", f"{self.base_url}/health"]
        last_err: Optional[BaseException] = None
        with httpx.Client(timeout=2.0) as http:
            while time.monotonic() < deadline:
                # Die fast if the subprocess already exited.
                if self._proc is not None and self._proc.poll() is not None:
                    raise RuntimeError(
                        f"opencode serve exited early with code {self._proc.returncode}"
                    )
                for url in urls:
                    try:
                        r = http.get(url)
                        if r.status_code == 200:
                            try:
                                if r.json().get("healthy") is True:
                                    return
                            except (ValueError, TypeError):
                                # Older /health served HTML; skip.
                                pass
                    except httpx.HTTPError as e:
                        last_err = e
                time.sleep(0.2)
        raise TimeoutError(
            f"opencode serve did not become ready at {urls[0]} within "
            f"{self.ready_timeout_s:.1f}s (last error: {last_err!r})"
        )

    # --- context manager ----------------------------------------------

    def __enter__(self) -> "OpencodeServer":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()
