"""SSE parser for opencode's ``GET /event`` stream.

Each ``data:`` line is a JSON object of shape::

    {"type": "<event.name>", "properties": {...}}

This module provides ``SSEEvent`` (a typed NamedTuple-like dataclass) and
``EventStream`` (an iterable context manager over the SSE connection).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterator, Optional

import httpx


@dataclass(frozen=True)
class SSEEvent:
    """One parsed SSE message."""

    type: str
    properties: dict[str, Any]
    raw: str

    @classmethod
    def from_json(cls, data: str) -> "SSEEvent":
        obj = json.loads(data)
        # Control-plane (/global/event) wraps events as ``{"payload": {...}}``;
        # instance routes (/event) emit the payload at root. Normalise both.
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else obj
        return cls(
            type=payload.get("type", ""),
            properties=payload.get("properties", {}) or {},
            raw=data,
        )


class EventStream:
    """Iterable context manager over ``GET /event``.

    Example::

        with EventStream(base_url) as events:
            for ev in events:
                if ev.type == "session.idle":
                    break
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: Optional[float] = None,
        path: str = "/event",
        headers: Optional[dict[str, str]] = None,
    ) -> None:
        """Open an SSE stream.

        ``path`` defaults to ``/event`` (the project-instance event bus). Pass
        ``/global/event`` to subscribe to the control-plane stream, which does
        not require an instance context.
        """
        self.base_url = base_url.rstrip("/")
        self.path = path
        self.headers = dict(headers or {})
        # None read-timeout keeps the SSE connection open across heartbeats.
        self._timeout = httpx.Timeout(
            connect=5.0,
            read=None,
            write=5.0,
            pool=5.0,
        ) if timeout_s is None else httpx.Timeout(timeout_s)
        self._client: Optional[httpx.Client] = None
        self._response: Optional[httpx.Response] = None
        self._stream_ctx = None

    def __enter__(self) -> "EventStream":
        self._client = httpx.Client(timeout=self._timeout, headers=self.headers)
        self._stream_ctx = self._client.stream("GET", f"{self.base_url}{self.path}")
        self._response = self._stream_ctx.__enter__()
        self._response.raise_for_status()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self._stream_ctx is not None:
                try:
                    self._stream_ctx.__exit__(exc_type, exc, tb)
                except (httpx.RemoteProtocolError, httpx.ReadError):
                    # Server tore down mid-stream — nothing for us to clean up.
                    pass
        finally:
            self._stream_ctx = None
            self._response = None
            if self._client is not None:
                self._client.close()
                self._client = None

    def __iter__(self) -> Iterator[SSEEvent]:
        if self._response is None:
            raise RuntimeError("EventStream used outside its context manager")
        yield from _iter_sse(self._response)


def _iter_sse(response: httpx.Response) -> Iterator[SSEEvent]:
    """Parse SSE frames from an httpx streaming response.

    Follows the basic ``data: ...\\n\\n`` framing. Multiple data lines in one
    frame are concatenated with newlines (per the SSE spec).

    A mid-stream connection drop (server restart, instance tear-down, or the
    socket being reset when the turn completes) is treated as a clean
    end-of-stream — we simply stop yielding events rather than propagating
    ``httpx.RemoteProtocolError`` into the caller. Tests decide what to do
    with the events they *did* receive.
    """
    buf: list[str] = []
    for line in _safe_iter_lines(response):
        # httpx yields already-decoded str lines (no CR/LF).
        if line == "":
            if buf:
                data = "\n".join(buf)
                buf = []
                try:
                    yield SSEEvent.from_json(data)
                except json.JSONDecodeError:
                    # Skip non-JSON frames rather than crashing the test.
                    continue
            continue
        if line.startswith(":"):
            # SSE comment — heartbeat or keepalive, skip.
            continue
        if line.startswith("data:"):
            # Per spec: one optional space after the colon.
            payload = line[5:]
            if payload.startswith(" "):
                payload = payload[1:]
            buf.append(payload)
        # Other SSE fields (event:, id:, retry:) are ignored — opencode doesn't use them.
    if not buf:
        return
    try:
        yield SSEEvent.from_json("\n".join(buf))
    except json.JSONDecodeError:
        return


def _safe_iter_lines(response: httpx.Response) -> Iterator[str]:
    """Wrap ``response.iter_lines()`` so an abrupt server disconnect doesn't
    propagate as ``httpx.RemoteProtocolError`` — we treat it as EOF.
    """
    try:
        for line in response.iter_lines():
            yield line
    except httpx.RemoteProtocolError:
        return
    except httpx.ReadError:
        return
