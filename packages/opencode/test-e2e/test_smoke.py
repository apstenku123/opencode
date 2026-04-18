"""Smoke test: server starts, create thread, verify listed."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.timeout(60)


def test_health(http_client):
    h = http_client.health()
    assert h.get("healthy") is True
    assert isinstance(h.get("version"), str) and h["version"]


def test_create_thread_and_list(http_client):
    thread = http_client.create_thread()
    assert isinstance(thread, dict), f"expected dict, got {thread!r}"
    thread_id = thread.get("id")
    assert isinstance(thread_id, str) and thread_id, f"no thread id: {thread!r}"

    # The new thread should appear in /thread list.
    threads = http_client.list_threads()
    assert isinstance(threads, list)
    ids = {t.get("id") for t in threads}
    assert thread_id in ids, (
        f"created thread {thread_id} not in listing of {len(threads)} threads"
    )

    # And in /session list (same underlying store).
    sessions = http_client.list_sessions()
    sess_ids = {s.get("id") for s in sessions}
    assert thread_id in sess_ids, (
        f"created thread {thread_id} not in session listing "
        f"({len(sessions)} sessions)"
    )


def test_get_thread_by_id(http_client):
    thread = http_client.create_thread()
    thread_id = thread["id"]

    got = http_client.get_thread(thread_id)
    assert got.get("id") == thread_id


def test_messages_empty_for_new_thread(http_client):
    thread = http_client.create_thread()
    msgs = http_client.get_messages(thread["id"])
    assert isinstance(msgs, list)
    # Newly-created thread may or may not have system messages — just verify shape.
    for m in msgs:
        assert isinstance(m, dict)
