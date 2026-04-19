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
    lock_status.py  # diagnostic: inspect /tmp/opencode-e2e.lock.meta
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

## Concurrency model

This suite is **strictly serialised** via a session-scoped autouse fixture
(`_e2e_session_lock` in `conftest.py`) that acquires a POSIX advisory
file lock at `/tmp/opencode-e2e.lock`. Every pytest invocation under this
directory blocks at session-start until it can acquire the lock.

### Why the lock exists

Every test shares these process-external resources:

- **Copilot OAuth state** — `~/.local/share/opencode/auth.json` and the
  per-account `copilot-connections.json` cache. Two pytest processes
  rotating tokens in parallel would corrupt the file.
- **Rate-state sqlite** — `copilot-rate-state.sqlite` (shared reservation
  ledger across all accounts). Concurrent writers burn tokens racing
  for the same budget.
- **Opencode serve subprocesses** — ports are ephemeral but data dirs
  and per-account rate limits are shared.

Because these are real user credentials and real rate limits, concurrent
pytest runs are **always wrong**. There is no bypass — the previous
`OPENCODE_E2E_SKIP_LOCK=1` escape hatch was removed in `a65910e38`
because peer agents kept using it and triggering contention → false
failures.

### What takes the lock

Every test, via the `_e2e_session_lock` session-scope autouse fixture.
That fixture also:

- Pre-acquire: sweeps stale locks whose holder PID is dead or whose
  `started_at` is older than 15 min (zombie handling).
- Watchdog layer 1: a daemon thread that SIGTERMs itself at 900 s of
  hold time, escalating to SIGKILL after a 30 s grace window.
- Watchdog layer 2: `signal.alarm(1200)` as a kernel-delivered
  last-resort ceiling (survives GIL stalls and C-extension blocking).
- Release: `finally:` unlinks both `/tmp/opencode-e2e.lock` and
  `/tmp/opencode-e2e.lock.meta`.

A secondary **function-scope** lock at
`/tmp/opencode-e2e-auth-hotspot.lock` (`_auth_hotspot_lock` fixture)
serialises tests marked `@pytest.mark.needs_auth_lock` — those are
tests that destructively mutate `auth.json` or the rate-state sqlite.

### pytest-xdist is blocked

`conftest.pytest_configure` detects xdist at collection time and aborts
with a clear `pytest.UsageError` if either:

- `-n N` (or `--numprocesses N`) was passed with N > 1 (or `auto`/`logical`), or
- `PYTEST_XDIST_WORKER_COUNT` in the environment is > 1.

Running under xdist would spawn N workers all racing for the same
file lock; N-1 of them would block for the 900 s timeout and then
fail. Catching the misuse at collection is cheaper than N-1 lock
timeouts.

### Inspecting the lock

From `packages/opencode/test-e2e/` with the venv active:

```sh
python3 -m harness.lock_status
```

Prints:

- Whether `/tmp/opencode-e2e.lock` exists.
- Holder PID from `/tmp/opencode-e2e.lock.meta`.
- Holder test suite names (what was passed on the CLI).
- Wall-clock elapsed time since the holder started.
- Whether the holder PID is still alive (detects zombies).

Exit codes: `0` = healthy (free or live holder), `2` = stale
(PID dead — next pytest run will break it), `3` = corrupt meta.

### Emergency override

The lock is designed so you **don't need** to bypass it — the pre-acquire
stale-lock sweep handles PID-dead holders automatically. If the meta
file is still present but pytest's sweep logic itself is broken, you can:

1. Confirm the holder is dead: `python3 -m harness.lock_status` prints
   `holder OK: False (DEAD)`.
2. Manually unlink both files:
   `rm -f /tmp/opencode-e2e.lock /tmp/opencode-e2e.lock.meta`.
3. Run pytest as normal.

For taking the lock non-blocking from outside pytest (rare — e.g.
debugging a hung subprocess):

```sh
flock -n /tmp/opencode-e2e.lock -c 'your-diagnostic-command'
```

**Warning**: any path that runs `opencode serve` against the user's
real Copilot tokens **burns Copilot rate-limit tokens against the
user's plan**. Do not bypass the lock to run parallel sessions — you
are paying for the contention in real API budget, not just wall-clock.

### Known limitations

- **Session-scope blocks everyone**: one slow test (e.g. a 5-minute
  live-LLM turn) holds the lock for the entire duration, so a peer
  pytest invocation on the same workstation waits for 5 minutes even
  if it only needs to run a 3-second smoke test. Mitigation: most
  live tests now consume the session-shared `long_lived_server`
  fixture and create per-test sessions over it, which keeps per-test
  wall clocks small even inside the shared lock window.
- **No per-test concurrency inside a single pytest**: xdist is blocked
  (see above). If you want concurrency, refactor your tests to share
  `long_lived_server` and batch assertions onto per-test `POST
  /session` threads — that's concurrency *within* a pytest run
  without racing the file lock.
- **Watchdog windows are a hard ceiling**: tests cannot run longer
  than 900 s of lock-hold time (the poll watchdog) or 1200 s of
  wall-clock (the `SIGALRM` ceiling). Anything above that is a bug
  in the test, not the lock.

## CI setup

A sample CI runner (GitHub Actions syntax — adapt for other runners):

```yaml
name: opencode-e2e

on:
  push:
    branches: [dev, main]
  pull_request:

jobs:
  e2e:
    runs-on: ubuntu-latest
    concurrency:
      # Serialise across jobs on this runner — matches the file-lock model.
      group: opencode-e2e-${{ github.ref }}
      cancel-in-progress: false
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Pre-clean stale e2e lock
        # Ensures a crashed prior job can't block this one. Safe because
        # the lock is host-local and a fresh CI runner has no other
        # pytest process to race against.
        run: |
          rm -f /tmp/opencode-e2e.lock /tmp/opencode-e2e.lock.meta

      - name: Install Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Seed Copilot OAuth from CI secret
        env:
          COPILOT_AUTH_JSON: ${{ secrets.COPILOT_AUTH_JSON }}
        run: |
          mkdir -p "$HOME/.local/share/opencode"
          printf '%s' "$COPILOT_AUTH_JSON" > "$HOME/.local/share/opencode/auth.json"
          chmod 600 "$HOME/.local/share/opencode/auth.json"

      - name: Install harness requirements
        working-directory: packages/opencode/test-e2e
        run: |
          python -m venv .venv
          .venv/bin/pip install -r requirements.txt

      - name: Build opencode binary
        # Whatever your repo uses. The harness needs an opencode-unify
        # binary — either on PATH or at $OPENCODE_BINARY.
        run: |
          # e.g. bun install && bun run build:opencode-unify
          echo "build step goes here"

      - name: Run e2e tests
        working-directory: packages/opencode/test-e2e
        env:
          OPENCODE_BINARY: ${{ github.workspace }}/dist/opencode-unify
        run: |
          .venv/bin/python -m pytest test-e2e/ -v --tb=line \
            2>&1 | tee e2e-output.log

      - name: Collect lock diagnostics on failure
        if: failure()
        working-directory: packages/opencode/test-e2e
        run: |
          # Snapshot the lock meta + holder status so uploaded artifacts
          # answer "who was holding the lock when we timed out?".
          .venv/bin/python -m harness.lock_status > lock-status.txt 2>&1 || true
          cp /tmp/opencode-e2e.lock.meta lock.meta 2>/dev/null || true

      - name: Upload failure artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-diagnostics
          path: |
            packages/opencode/test-e2e/e2e-output.log
            packages/opencode/test-e2e/lock-status.txt
            packages/opencode/test-e2e/lock.meta
          if-no-files-found: ignore
          retention-days: 7
```

Notes:

- The `concurrency:` block serialises CI jobs the same way the file
  lock serialises local pytest runs — essential because the Copilot
  tokens are per-account, not per-runner.
- `rm -f /tmp/opencode-e2e.lock*` at job start is safe on a single-use
  CI VM and guards against a crashed prior job's stale lock.
- Never run `pytest -n N` in CI — the xdist guard in `conftest.py`
  will abort with `pytest.UsageError` at collection.
- The Copilot OAuth JSON secret should be a full `auth.json`
  (`{"github-copilot": {"type": "oauth", "refresh": "...", ...}}`)
  stored in the runner's secret store. Rotate when the refresh token
  rotates.
