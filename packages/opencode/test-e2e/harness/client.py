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
        timeout_s: float = 180.0,
        project_directory: Optional[str] = None,
    ) -> None:
        """Construct a client.

        ``project_directory`` is sent as the ``x-opencode-directory`` header on
        every request, which selects the project/instance context used by
        routes under ``/thread``, ``/turn``, and ``/session``. Defaults to the
        current process cwd — opencode itself falls back to ``process.cwd()``
        when the header is absent, but being explicit avoids surprises when
        tests run from different directories.
        """
        import os as _os

        self.base_url = base_url.rstrip("/")
        self.project_directory = project_directory or _os.getcwd()
        headers = {"x-opencode-directory": self.project_directory}
        self._http = httpx.Client(
            base_url=self.base_url,
            timeout=timeout_s,
            headers=headers,
        )

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

    def fork_thread(
        self,
        thread_id: str,
        *,
        messageID: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST /thread/:id/fork — fork a thread at an optional message boundary."""
        body: dict[str, Any] = {}
        if messageID is not None:
            body["messageID"] = messageID
        return self._post(f"/thread/{thread_id}/fork", json=body)

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

    def get_session_children(self, session_id: str) -> list[dict[str, Any]]:
        """GET /session/:id/children — list child sessions of a parent.

        Returns the list of child session dicts (each with ``id``,
        ``parentID``, ``title``, etc.). Used by the SGR subagent tests to
        verify that an auto-dispatched ``task`` call created a child
        session even when the downstream dispatcher errors out (e.g.
        because the auto-dispatch context lacks ``promptOps``).
        """
        return self._get(f"/session/{session_id}/children")

    def create_session(self, **body: Any) -> dict[str, Any]:
        """POST /session — create a session directly (fires SessionStart)."""
        return self._post("/session", json=body)

    def delete_session(self, session_id: str) -> bool:
        """DELETE /session/:id — delete a session (fires SessionEnd)."""
        r = self._http.delete(f"/session/{session_id}")
        r.raise_for_status()
        return bool(r.json())

    def summarize(
        self,
        session_id: str,
        *,
        providerID: str,
        modelID: str,
        auto: bool = False,
    ) -> bool:
        """POST /session/:id/summarize — run compaction (PreCompact/PostCompact)."""
        return self._post(
            f"/session/{session_id}/summarize",
            json={"providerID": providerID, "modelID": modelID, "auto": auto},
        )

    def send_message(
        self,
        session_id: str,
        text: str,
        *,
        providerID: str,
        modelID: str,
        agent: Optional[str] = None,
        timeout: Optional[float] = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """POST /session/:id/message — send a prompt synchronously.

        ``timeout`` overrides the client-level timeout for this single
        request (in seconds). Useful when a caller wants to fail fast on
        a slow upstream rather than waiting for the client-wide default.
        """
        body: dict[str, Any] = {
            "parts": [{"type": "text", "text": text}],
            "model": {"providerID": providerID, "modelID": modelID},
        }
        if agent is not None:
            body["agent"] = agent
        body.update(extra)
        post_kwargs: dict[str, Any] = {"json": body}
        if timeout is not None:
            post_kwargs["timeout"] = timeout
        return self._post(f"/session/{session_id}/message", **post_kwargs)

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

    def set_autobest_enabled(
        self,
        thread_id: str,
        enabled: bool,
        *,
        ts: Optional[float] = None,
    ) -> dict[str, Any]:
        """POST /thread/:id/autobest/enabled."""
        body: dict[str, Any] = {"enabled": enabled}
        if ts is not None:
            body["ts"] = ts
        return self._post(f"/thread/{thread_id}/autobest/enabled", json=body)

    def get_autobest_by_thread(self, thread_id: str) -> dict[str, Any]:
        """GET /thread/:id/autobest — thread-scoped alias for get_autobest."""
        return self._get(f"/thread/{thread_id}/autobest")

    # --- events --------------------------------------------------------

    def events(
        self,
        *,
        timeout_s: Optional[float] = None,
        global_stream: bool = False,
    ) -> EventStream:
        """Open an SSE connection.

        Default target is ``GET /event`` (instance event bus — requires an
        Instance context to be wired on the server). Set ``global_stream=True``
        to subscribe to ``GET /global/event`` instead; the control-plane stream
        is always available and emits events wrapped as ``{"payload": {...}}``
        (the harness unwraps them transparently).

        Use as a context manager::

            with client.events() as stream:
                for ev in stream:
                    ...
        """
        path = "/global/event" if global_stream else "/event"
        headers = {"x-opencode-directory": self.project_directory}
        return EventStream(
            self.base_url,
            timeout_s=timeout_s,
            path=path,
            headers=headers,
        )

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
