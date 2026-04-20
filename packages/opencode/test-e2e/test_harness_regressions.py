from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import bench_retry_race
import httpx

from harness.events import _iter_sse
from harness.sgr import run_sgr_turn


class _FakeResponse:
    def __init__(self, lines, error=None):
        self._lines = lines
        self._error = error

    def iter_lines(self):
        for line in self._lines:
            yield line
        if self._error:
            raise self._error


def test_iter_sse_flushes_final_buffered_event_on_eof() -> None:
    response = _FakeResponse([
        'data: {"type":"done","properties":{"ok":true}}',
    ])
    events = list(_iter_sse(response))
    assert len(events) == 1
    assert events[0].type == "done"
    assert events[0].properties == {"ok": True}


def test_iter_sse_flushes_buffered_event_on_remote_protocol_error() -> None:
    response = _FakeResponse(
        ['data: {"type":"done","properties":{"ok":true}}'],
        error=httpx.RemoteProtocolError("boom"),
    )
    events = list(_iter_sse(response))
    assert len(events) == 1
    assert events[0].type == "done"


def test_summarize_keeps_empty_runs_as_no_data() -> None:
    summary = bench_retry_race.summarize("race-off", [])
    assert summary["n"] == 0.0
    assert str(summary["p99"]) == "nan"
    assert str(summary["mean"]) == "nan"


class _FakeOpencodeClient:
    def __init__(self, base_url, project_directory=None, timeout_s=None):
        self.base_url = base_url
        self.project_directory = project_directory
        self.timeout_s = timeout_s
        self.start_calls = []
        self.closed = False
        self.start_delay_s = 0.0

    def start_turn(self, thread_id, prompt, model, format):
        self.start_calls.append(
            {
                "thread_id": thread_id,
                "prompt": prompt,
                "model": model,
                "format": format,
            }
        )
        time.sleep(self.start_delay_s)

    def close(self):
        self.closed = True


class _PollingClient:
    def __init__(self, batches):
        self.base_url = "http://example.test"
        self.project_directory = None
        self._batches = list(batches)
        self._index = 0

    def get_messages(self, thread_id):
        if self._index >= len(self._batches):
            return self._batches[-1] if self._batches else []
        batch = self._batches[self._index]
        self._index += 1
        return batch


def test_run_sgr_turn_ignores_structured_messages_from_previous_turn(monkeypatch) -> None:
    driver = _FakeOpencodeClient("http://example.test")

    monkeypatch.setattr("harness.sgr.OpencodeClient", lambda *args, **kwargs: driver)

    stale_message = {
        "id": "old-assistant",
        "info": {"role": "assistant", "structured": {"stale": True}},
    }
    fresh_message = {
        "id": "new-assistant",
        "info": {"role": "assistant", "structured": {"fresh": True}},
    }
    client = _PollingClient([
        [stale_message],
        [stale_message, fresh_message],
    ])

    structured, message = run_sgr_turn(
        client,
        model={"providerID": "test", "modelID": "model"},
        prompt="emit",
        schema={"type": "object"},
        thread_id="thread-1",
        poll_timeout_s=0.5,
        poll_interval_s=0.01,
    )

    assert structured == {"fresh": True}
    assert message == fresh_message
    assert driver.closed is True


def test_run_sgr_turn_closes_driver_client_on_timeout(monkeypatch) -> None:
    driver = _FakeOpencodeClient("http://example.test")
    driver.start_delay_s = 0.2
    monkeypatch.setattr("harness.sgr.OpencodeClient", lambda *args, **kwargs: driver)

    client = _PollingClient([[]])
    before = threading.active_count()
    structured, message = run_sgr_turn(
        client,
        model={"providerID": "test", "modelID": "model"},
        prompt="emit",
        schema={"type": "object"},
        thread_id="thread-timeout",
        poll_timeout_s=0.01,
        poll_interval_s=0.005,
    )
    after = threading.active_count()

    assert structured is None
    assert message is None
    assert driver.closed is True
    assert after <= before + 1
