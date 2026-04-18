"""Isolated opencode home directory for live-LLM tests.

Mirrors the codex-rs test pattern (``test_e2e_proxy_multi_account.py``):
copy the user's real ``auth.json`` + ``copilot-connections.json`` into a
fresh tmpdir, then point the server at it via XDG env vars.

The returned directory has the layout opencode's ``Global`` module expects::

    <tmpdir>/
      data/opencode/auth.json              (copy of user's)
      data/opencode/copilot-connections.json
      cache/opencode/
      config/opencode/
      state/opencode/

Driver code then sets:

    XDG_DATA_HOME=<tmpdir>/data
    XDG_CACHE_HOME=<tmpdir>/cache
    XDG_CONFIG_HOME=<tmpdir>/config
    XDG_STATE_HOME=<tmpdir>/state

...when spawning ``opencode serve``. See ``OpencodeServer.__init__``.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional


# Files we copy verbatim from the real opencode data home into the isolated
# one. Credentials first, then connection / routing state so multi-account
# discovery + proxy config survives into the isolated server.
_COPY_FILES = (
    "auth.json",
    "copilot-connections.json",
    "copilot-rate-state.sqlite",
)


def _default_src_data_home() -> Path:
    """Resolve the user's real opencode data dir.

    Honours ``XDG_DATA_HOME`` (the same env var opencode itself reads via
    ``xdg-basedir``) before falling back to the Linux/macOS default.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "opencode"
    return Path.home() / ".local" / "share" / "opencode"


def prepare_isolated_home(
    src_data_home: Optional[Path] = None,
    *,
    preserve_tokens: bool = True,
) -> Path:
    """Create an isolated opencode home under ``/tmp`` and copy creds into it.

    Returns the tmpdir root. Callers are responsible for cleanup.
    Use :func:`isolated_opencode_home` if you want a context manager that
    handles teardown for you.

    ``preserve_tokens=False`` matches the Rust test's ``strip refresh_token``
    behaviour — handy when you want opencode to re-acquire access tokens
    from the OAuth refresh flow rather than reuse a cached access token.
    In practice opencode stores ``refresh`` + ``access`` separately; with
    ``preserve_tokens=False`` we drop the ``access``/``expires`` fields but
    keep ``refresh`` so re-auth still works.
    """
    import json

    src = (src_data_home or _default_src_data_home()).expanduser()

    root = Path(tempfile.gettempdir()) / f"opencode-e2e-{uuid.uuid4().hex[:8]}"
    for sub in ("data", "cache", "config", "state"):
        (root / sub / "opencode").mkdir(parents=True, exist_ok=True)

    dst_data = root / "data" / "opencode"

    if not src.exists():
        return root

    for name in _COPY_FILES:
        s = src / name
        if not s.exists():
            continue
        d = dst_data / name
        try:
            shutil.copy2(s, d)
        except OSError:
            # SQLite WAL companions are best-effort; missing one is not fatal.
            continue

    # Also copy sqlite WAL/SHM companions if present so the rate-state DB is
    # consistent. Missing files are silently skipped.
    for suffix in ("-shm", "-wal"):
        s = src / f"copilot-rate-state.sqlite{suffix}"
        if s.exists():
            try:
                shutil.copy2(s, dst_data / s.name)
            except OSError:
                pass

    if not preserve_tokens:
        auth_path = dst_data / "auth.json"
        if auth_path.exists():
            try:
                data = json.loads(auth_path.read_text())
            except (OSError, json.JSONDecodeError):
                data = None
            if isinstance(data, dict):
                for key, entry in list(data.items()):
                    if not isinstance(entry, dict):
                        continue
                    entry.pop("access", None)
                    entry.pop("expires", None)
                auth_path.write_text(json.dumps(data))

    return root


@contextmanager
def isolated_opencode_home(
    src_home: Optional[Path] = None,
    *,
    preserve_tokens: bool = True,
) -> Iterator[Path]:
    """Context-manager wrapper around :func:`prepare_isolated_home`.

    Creates the tmpdir, copies creds in, yields the root, cleans up on exit.

    ``src_home`` may point at either the user's *home* (``~``) — we resolve
    ``<home>/.local/share/opencode`` underneath — or directly at the
    opencode data subdir. We detect by checking for a nested
    ``.local/share/opencode`` folder.
    """
    src_data_home: Optional[Path] = None
    if src_home is not None:
        candidate = src_home.expanduser()
        nested = candidate / ".local" / "share" / "opencode"
        if nested.exists():
            src_data_home = nested
        else:
            src_data_home = candidate
    root = prepare_isolated_home(src_data_home, preserve_tokens=preserve_tokens)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def xdg_env_for(root: Path) -> dict[str, str]:
    """Build the XDG env-var dict that points opencode at ``root``.

    ``HOME`` is intentionally *not* overridden here — overriding it on macOS
    breaks ``os.homedir()`` calls elsewhere in the node runtime. The XDG
    vars alone are enough: ``src/global/index.ts`` resolves every data path
    through ``xdg-basedir``, which honours these vars when set.
    """
    return {
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_STATE_HOME": str(root / "state"),
    }


def has_copilot_credentials(root: Path | None = None) -> bool:
    """Return True iff ``auth.json`` exists and contains a ``github-copilot*``
    OAuth entry.

    ``root`` may be either an opencode data dir (``.../opencode``) or an
    isolated home root (``.../data/opencode`` subdir). Pass ``None`` to
    probe the user's real home.
    """
    import json

    if root is None:
        data_home = _default_src_data_home()
    elif (root / "data" / "opencode" / "auth.json").exists():
        data_home = root / "data" / "opencode"
    else:
        data_home = root

    auth_path = data_home / "auth.json"
    if not auth_path.exists():
        return False
    try:
        data = json.loads(auth_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    for key, entry in data.items():
        if not isinstance(key, str) or not key.startswith("github-copilot"):
            continue
        if isinstance(entry, dict) and entry.get("type") == "oauth":
            return True
    return False
