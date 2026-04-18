"""Pytest fixtures for opencode e2e tests.

Fixtures:
    - ``opencode_server``            (session-scoped): started ``OpencodeServer``.
    - ``http_client``                (function-scoped): ``OpencodeClient``.
    - ``authenticated_copilot_session`` (function-scoped): thread ID bound to
      the user's real GitHub Copilot account credentials resolved from
      ``~/.local/share/opencode/auth.json``. Skips the test if no Copilot
      OAuth token is on disk.
    - ``copilot_model``              (session-scoped): provider/model pair to
      use for live tests. Overridable via ``OPENCODE_E2E_COPILOT_MODEL``
      (default: ``gpt-4o``).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Iterator

import pytest

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
    """Fresh HTTP client per test, bound to the shared server."""
    with OpencodeClient(
        opencode_server.base_url,
        project_directory=str(project_dir),
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
        2. First model listed under any ``github-copilot*`` account's
           ``discovery.models`` in ``copilot-connections.json``.
        3. Fallback to ``github-copilot / gpt-4.1``.
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

    model_id = "gpt-4.1"
    if isinstance(data, dict):
        connections = data.get("connections") or {}
        for conn in connections.values():
            if not isinstance(conn, dict):
                continue
            discovery = conn.get("discovery") or {}
            models = discovery.get("models") if isinstance(discovery, dict) else None
            if isinstance(models, list) and models:
                for candidate in models:
                    if isinstance(candidate, str) and candidate:
                        model_id = candidate
                        break
                if model_id != "gpt-4.1":
                    break
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
