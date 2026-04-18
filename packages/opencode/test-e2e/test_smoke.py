"""Smoke tests for the harness.

What this file verifies (things the harness itself must get right):

* ``OpencodeServer`` can spawn the binary, wait for readiness, and clean up.
* ``OpencodeClient`` can talk to the running server.
* The health endpoint, OpenAPI doc endpoint, and SSE event stream work.
* Basic thread round-trip (create + list) works now that
  ``WorkspaceRouterMiddleware`` is wired into ``InstanceRoutes`` in
  ``src/server/server.ts``.
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.timeout(30)


def test_server_starts_and_health(http_client, opencode_server):
    """Server came up and the health route answers."""
    assert opencode_server.base_url.startswith("http://")

    h = http_client.health()
    assert h.get("healthy") is True
    assert isinstance(h.get("version"), str) and h["version"]


def test_openapi_doc_served(opencode_server):
    """The binary publishes an OpenAPI 3.1 document at /doc."""
    r = httpx.get(f"{opencode_server.base_url}/doc", timeout=5.0)
    r.raise_for_status()
    doc = r.json()
    assert doc.get("openapi", "").startswith("3.")
    assert "/global/health" in doc.get("paths", {})


def test_event_stream_emits_connected(http_client):
    """GET /global/event yields a ``server.connected`` frame immediately."""
    with http_client.events(timeout_s=5.0, global_stream=True) as stream:
        first = next(iter(stream))
        assert first.type == "server.connected"


def test_create_thread_round_trip(http_client):
    thread = http_client.create_thread()
    assert isinstance(thread, dict)
    thread_id = thread.get("id")
    assert isinstance(thread_id, str) and thread_id

    threads = http_client.list_threads()
    ids = {t.get("id") for t in threads}
    assert thread_id in ids


def test_create_thread_then_messages(http_client):
    thread = http_client.create_thread()
    msgs = http_client.get_messages(thread["id"])
    assert isinstance(msgs, list)
