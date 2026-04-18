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

from harness import OpencodeClient, OpencodeServer  # noqa: E402


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
            "github-copilot",
        ),
        "modelID": os.environ.get(
            "OPENCODE_E2E_COPILOT_MODEL",
            "gpt-4o",
        ),
    }


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
