"""Pytest fixtures for opencode e2e tests.

Fixtures:
    - ``opencode_server``  (session-scoped): a started ``OpencodeServer``.
    - ``http_client``      (function-scoped): an ``OpencodeClient`` bound to it.

Tests can also depend on ``opencode_server`` directly if they need multiple
clients or the raw ``base_url``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterator

import pytest

# Make ``harness`` importable without installing the package.
_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from harness import OpencodeClient, OpencodeServer  # noqa: E402


@pytest.fixture(scope="session")
def opencode_server() -> Iterator[OpencodeServer]:
    """Start one ``opencode serve`` for the whole test session."""
    with OpencodeServer(ready_timeout_s=10.0) as server:
        yield server


@pytest.fixture()
def http_client(opencode_server: OpencodeServer) -> Iterator[OpencodeClient]:
    """Fresh HTTP client per test, bound to the shared server."""
    with OpencodeClient(opencode_server.base_url) as client:
        yield client
