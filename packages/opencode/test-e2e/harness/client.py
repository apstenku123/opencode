"""OpencodeClient — thin HTTP wrapper around opencode's REST routes."""

from __future__ import annotations

import time
from typing import Any, Optional

import httpx

from .events import EventStream, SSEEvent


class OpencodeClient:
    """HTTP client for a running ``opencode serve`` instance.

    Routes covered:
        - ``GET  /health``
        - ``POST /thread/start``                    -> create_thread
        - ``GET  /thread``                          -> list_threads
        - ``GET  /thread/:id``                      -> get_thread
        - ``POST /turn/start``                      -> start_turn
        - ``POST /turn/interrupt``                  -> interrupt_turn
        - ``POST /turn/steer``                      -> steer_turn
        - ``GET  /session``                         -> list_sessions
        - ``GET  /session/:id``                     -> get_session
        - ``GET  /session/:id/message``             -> get_messages
        - ``GET  /session/:id/autobest``            -> get_autobest
        - ``POST /thread/:id/autobest/setActive``   -> set_autobest
        - ``GET  /event``                           -> events() (SSE)
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float = 30.0,
        directory: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # ``directory`` is auto-appended as a query-string argument on every
        # request, satisfying the server's ``WorkspaceRouterMiddleware``
        # which needs a path to bind the Instance context to.
        headers = {}
        if directory is not None:
            headers["x-opencode-directory"] = directory
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout_s, headers=headers)
        self.directory = directory

    # --- lifecycle -----------------------------------------------------

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "OpencodeClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # --- low-level -----------------------------------------------------

    def _get(self, path: str, **kwargs: Any) -> Any:
        r = self._http.get(path, **kwargs)
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, *, json: Any = None, **kwargs: Any) -> Any:
        if json is None:
            json = {}
        r = self._http.post(path, json=json, **kwargs)
        r.raise_for_status()
        return r.json()

    # --- health --------------------------------------------------------

    def health(self) -> dict[str, Any]:
        return self._get("/global/health")

    # --- threads -------------------------------------------------------

    def create_thread(self, **body: Any) -> dict[str, Any]:
        """POST /thread/start. Body is Session.CreateInput (all optional)."""
        return self._post("/thread/start", json=body)

    def list_threads(
        self,
        *,
        directory: Optional[str] = None,
        roots: Optional[bool] = None,
        start: Optional[int] = None,
        search: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if directory is not None:
            params["directory"] = directory
        if roots is not None:
            params["roots"] = "true" if roots else "false"
        if start is not None:
            params["start"] = start
        if search is not None:
            params["search"] = search
        if limit is not None:
            params["limit"] = limit
        return self._get("/thread", params=params or None)

    def get_thread(self, thread_id: str) -> dict[str, Any]:
        return self._get(f"/thread/{thread_id}")

    # --- turns ---------------------------------------------------------

    def start_turn(
        self,
        thread_id: str,
        text: str,
        *,
        agent: Optional[str] = None,
        model: Optional[dict[str, str]] = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """POST /turn/start.

        ``text`` is wrapped in a single TextPart. ``extra`` is merged into the
        request body verbatim for advanced use (format, system, variant, tools).
        """
        body: dict[str, Any] = {
            "sessionID": thread_id,
            "parts": [{"type": "text", "text": text}],
        }
        if agent is not None:
            body["agent"] = agent
        if model is not None:
            body["model"] = model
        body.update(extra)
        return self._post("/turn/start", json=body)

    def interrupt_turn(self, thread_id: str) -> Any:
        return self._post("/turn/interrupt", json={"sessionID": thread_id})

    def steer_turn(
        self,
        thread_id: str,
        text: str,
        **extra: Any,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "sessionID": thread_id,
            "parts": [{"type": "text", "text": text}],
        }
        body.update(extra)
        return self._post("/turn/steer", json=body)

    def wait_for_turn_complete(
        self,
        thread_id: str,
        timeout_s: float = 60.0,
        *,
        poll_interval_s: float = 0.5,
    ) -> dict[str, Any]:
        """Poll ``GET /session/:id`` until ``idle`` is set on its ``time``.

        Returns the final session info. Raises ``TimeoutError`` if the turn
        does not complete within ``timeout_s``.

        This is a coarse signal — for fine-grained tracking use
        :meth:`events` and watch for ``session.idle``.
        """
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            session = self.get_session(thread_id)
            time_info = session.get("time") or {}
            if time_info.get("idle") is not None:
                return session
            time.sleep(poll_interval_s)
        raise TimeoutError(
            f"turn on thread {thread_id} did not complete within {timeout_s:.1f}s"
        )

    # --- sessions ------------------------------------------------------

    def list_sessions(
        self,
        *,
        directory: Optional[str] = None,
        roots: Optional[bool] = None,
        start: Optional[int] = None,
        search: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        """GET /session — list sessions in the server's current project."""
        params: dict[str, Any] = {}
        if directory is not None:
            params["directory"] = directory
        if roots is not None:
            params["roots"] = "true" if roots else "false"
        if start is not None:
            params["start"] = start
        if search is not None:
            params["search"] = search
        if limit is not None:
            params["limit"] = limit
        return self._get("/session", params=params or None)

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._get(f"/session/{session_id}")

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        """GET /session/:id/message — list all messages on a session."""
        return self._get(f"/session/{session_id}/message")

    # --- autobest ------------------------------------------------------

    def get_autobest(self, thread_id: str) -> dict[str, Any]:
        """GET /session/:id/autobest — history-backed autobest state."""
        return self._get(f"/session/{thread_id}/autobest")

    def set_autobest(
        self,
        thread_id: str,
        enabled: bool,
        *,
        ts: Optional[float] = None,
    ) -> dict[str, Any]:
        """POST /thread/:id/autobest/setActive."""
        body: dict[str, Any] = {"enabled": enabled}
        if ts is not None:
            body["ts"] = ts
        return self._post(f"/thread/{thread_id}/autobest/setActive", json=body)

    # --- events --------------------------------------------------------

    def events(self, *, timeout_s: Optional[float] = None) -> EventStream:
        """Open an SSE connection to ``GET /event``.

        Use as a context manager::

            with client.events() as stream:
                for ev in stream:
                    ...
        """
        return EventStream(self.base_url, timeout_s=timeout_s, directory=self.directory)

    def wait_for_event(
        self,
        predicate,
        *,
        timeout_s: float = 30.0,
    ) -> SSEEvent:
        """Block until an event matching ``predicate(SSEEvent) -> bool`` arrives.

        Opens a short-lived SSE connection for the wait.
        """
        deadline = time.monotonic() + timeout_s
        with self.events(timeout_s=timeout_s) as stream:
            for ev in stream:
                if predicate(ev):
                    return ev
                if time.monotonic() >= deadline:
                    break
        raise TimeoutError(
            f"no matching event received within {timeout_s:.1f}s"
        )
