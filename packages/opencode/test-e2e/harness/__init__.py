"""opencode e2e test harness.

Python library that drives ``opencode serve`` via HTTP + SSE, modeled after
codex's ``app_server_binary.py`` pattern (which drives ``codex-up-app-server``
over JSON-RPC).

Public API:

    from harness import OpencodeServer, OpencodeClient, resolve_opencode_binary

    with OpencodeServer() as server:
        client = OpencodeClient(server.base_url)
        thread = client.create_thread()
        ...
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .client import OpencodeClient
from .events import EventStream, SSEEvent
from .server import OpencodeServer

DEFAULT_BINARY_PATH = "/Users/dave/.local/bin/opencode-unify"
OPENCODE_BINARY_ENV_VAR = "OPENCODE_BINARY"


def resolve_opencode_binary() -> str:
    """Resolve opencode binary path.

    Precedence:
        1. ``OPENCODE_BINARY`` env var (if set).
        2. ``opencode-unify`` on PATH.
        3. ``/Users/dave/.local/bin/opencode-unify`` (fallback default).
    """
    override = os.environ.get(OPENCODE_BINARY_ENV_VAR)
    if override:
        return str(Path(override).expanduser())
    on_path = shutil.which("opencode-unify")
    if on_path:
        return on_path
    return DEFAULT_BINARY_PATH


__all__ = [
    "DEFAULT_BINARY_PATH",
    "OPENCODE_BINARY_ENV_VAR",
    "EventStream",
    "OpencodeClient",
    "OpencodeServer",
    "SSEEvent",
    "resolve_opencode_binary",
]
