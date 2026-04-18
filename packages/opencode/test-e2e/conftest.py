"""Pytest fixtures for opencode e2e tests.

Fixtures:
    - ``opencode_server``  (session-scoped): a started ``OpencodeServer``.
    - ``http_client``      (function-scoped): an ``OpencodeClient`` bound to it.

Tests can also depend on ``opencode_server`` directly if they need multiple
clients or the raw ``base_url``.
"""

from __future__ import annotations

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
    with OpencodeServer(ready_timeout_s=10.0, cwd=project_dir) as server:
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
