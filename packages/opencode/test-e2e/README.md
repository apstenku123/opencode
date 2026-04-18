# opencode e2e test harness

Python harness that drives a real `opencode serve` subprocess over HTTP + SSE,
modelled on codex's `app_server_binary.py` pattern (which drives
`codex-up-app-server` over JSON-RPC).

## Layout

```
test-e2e/
  harness/
    __init__.py     # resolve_opencode_binary, re-exports
    server.py       # OpencodeServer: spawn / healthcheck / stop
    client.py       # OpencodeClient: thread/turn/session/autobest wrappers
    events.py       # EventStream: SSE parser over GET /event
  conftest.py       # pytest fixtures: opencode_server, http_client
  requirements.txt  # httpx, pytest, pytest-timeout
  test_smoke.py     # smoke test: server starts, thread round-trips
```

## Binary resolution

The harness picks the opencode binary in this order:

1. `$OPENCODE_BINARY` (if set)
2. `opencode-unify` on `$PATH`
3. `/Users/dave/.local/bin/opencode-unify` (default fallback)

## Running

### With `uv`

```sh
cd packages/opencode/test-e2e
uv run --with-requirements requirements.txt pytest -v
```

### With `pip` + `venv`

```sh
cd packages/opencode/test-e2e
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pytest -v
```

### Overriding the binary

```sh
OPENCODE_BINARY=/path/to/opencode pytest -v
```

## Writing a test

```python
def test_create_thread(http_client):
    thread = http_client.create_thread()
    assert "id" in thread

    threads = http_client.list_threads()
    assert any(t["id"] == thread["id"] for t in threads)
```

For event-driven tests use the SSE stream:

```python
def test_start_turn(http_client):
    thread = http_client.create_thread()
    http_client.start_turn(thread["id"], "hello")
    with http_client.events(timeout_s=60) as stream:
        for ev in stream:
            if ev.type == "session.idle":
                break
```

## Requirements

- Python 3.11+
- A built `opencode-unify` binary at one of the paths above.
- Network access if your test actually drives a model — the smoke test does not.
