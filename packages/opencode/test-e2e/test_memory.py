"""End-to-end tests for the MemCoder-style memory subsystem.

These tests exercise the `opencode memory` CLI surface with a real LLM for
Phase-1 extraction and commit-crawler polishing. They isolate the on-disk
footprint (XDG_* dirs) into per-test tempdirs so they can run side-by-side
with a user's real opencode state.

Requirements:
  - `github-copilot` auth must be present in `~/.local/share/opencode/auth.json`
    (we copy it into the sandbox XDG_DATA_HOME so the Provider layer can
    resolve `github-copilot#edu/gpt-4.1`).
  - `bun` on PATH. The CLI is invoked directly from source via
    `bun run --conditions=browser .../packages/opencode/src/index.ts` so we
    don't depend on a pre-built `opencode-unify` binary — this keeps the
    fix-loop tight (edit TS → re-run test immediately).

Run with:
  cd packages/opencode/test-e2e
  pytest -xvs test_memory.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any, Iterable

import pytest


# ---------------------------------------------------------------------------
# Constants + helpers
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
OPENCODE_PKG_DIR = REPO_ROOT / "packages" / "opencode"
OPENCODE_ENTRY = OPENCODE_PKG_DIR / "src" / "index.ts"

# Real LLM — github-copilot is the most likely-configured provider in this
# workspace. Tests that need LLM extraction skip themselves if auth is
# unavailable rather than failing noisily.
MODEL = os.environ.get("OPENCODE_TEST_MODEL", "github-copilot#edu/gpt-4.1")

# Larger timeouts for LLM-backed subcommands.
CLI_TIMEOUT = int(os.environ.get("OPENCODE_E2E_CLI_TIMEOUT", "300"))


def _user_auth_path() -> Path | None:
    home = Path(os.path.expanduser("~"))
    for p in (
        home / ".local" / "share" / "opencode" / "auth.json",
        home / "Library" / "Application Support" / "opencode" / "auth.json",
    ):
        if p.exists():
            return p
    return None


def _require_llm_auth() -> Path:
    auth = _user_auth_path()
    if not auth:
        pytest.skip("no real opencode auth.json found; skipping real-LLM e2e")
    return auth


def _write_config(config_dir: Path, *, memories: dict[str, Any] | None = None) -> None:
    """Write a minimal opencode.json into `config_dir/opencode` so the
    config loader picks it up via $XDG_CONFIG_HOME."""
    target = config_dir / "opencode"
    target.mkdir(parents=True, exist_ok=True)
    data: dict[str, Any] = {
        "$schema": "https://opencode.ai/config.json",
        "model": MODEL,
    }
    if memories is not None:
        data["memories"] = memories
    (target / "opencode.json").write_text(json.dumps(data, indent=2))


def _make_sandbox(tmp_path: Path) -> dict[str, str]:
    """Build an isolated XDG layout rooted at `tmp_path` and copy the
    user's auth.json into it so the provider layer can authenticate."""
    home = tmp_path / "home"
    data = home / "share"
    cache = home / "cache"
    config = home / "config"
    state = home / "state"
    for d in (data / "opencode", cache, config, state):
        d.mkdir(parents=True, exist_ok=True)
    auth = _user_auth_path()
    if auth:
        shutil.copy2(auth, data / "opencode" / "auth.json")
    env = os.environ.copy()
    env.update(
        {
            "XDG_DATA_HOME": str(data),
            "XDG_CACHE_HOME": str(cache),
            "XDG_CONFIG_HOME": str(config),
            "XDG_STATE_HOME": str(state),
            "OPENCODE_TEST_HOME": str(home),
        }
    )
    # Silence the clack prompts in tests — we always pass --json anyway.
    env.pop("OPENCODE_CONFIG", None)
    env.pop("OPENCODE_CONFIG_DIR", None)
    return env


def _run_cli(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int = CLI_TIMEOUT,
) -> tuple[int, str, str]:
    """Run `opencode <args>` via `bun run --conditions=browser src/index.ts`.

    Returns (returncode, stdout, stderr). Never raises on non-zero — tests
    assert on the exit code explicitly."""
    cmd = [
        "bun",
        "run",
        "--conditions=browser",
        str(OPENCODE_ENTRY),
        *args,
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _extract_json_tail(stdout: str) -> dict[str, Any]:
    """CLI prints a migration banner on first run before the JSON payload.
    Grab the last `{...}` block and parse it."""
    # Find the last top-level JSON object by bracket balancing.
    opens = [i for i, ch in enumerate(stdout) if ch == "{"]
    closes = [i for i, ch in enumerate(stdout) if ch == "}"]
    if not opens or not closes:
        raise AssertionError(f"no JSON found in stdout:\n{stdout}")
    # Simple: last '{' that has a matching '}' after it.
    start = opens[0]
    # Prefer the LAST balanced block by scanning for the final '}' and
    # walking back to the matching '{'.
    end = closes[-1]
    depth = 0
    for i in range(end, -1, -1):
        if stdout[i] == "}":
            depth += 1
        elif stdout[i] == "{":
            depth -= 1
            if depth == 0:
                start = i
                break
    snippet = stdout[start : end + 1]
    return json.loads(snippet)


def _make_git_repo(path: Path, commits: Iterable[tuple[str, str]]) -> None:
    """Initialise a git repo at `path` and create one commit per
    `(filename, message)` tuple."""
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@test.invalid"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    for filename, message in commits:
        (path / filename).write_text(f"content for {filename}\n")
        subprocess.run(["git", "add", filename], cwd=path, check=True)
        subprocess.run(["git", "commit", "-q", "-m", message], cwd=path, check=True)


def _make_claude_session(
    projects_dir: Path,
    project_key: str,
    session_id: str,
    cwd: str,
    turns: list[tuple[str, str]],
) -> Path:
    """Write a synthetic Claude Code JSONL session file. Each turn is a
    (user_text, assistant_text) pair."""
    proj = projects_dir / project_key
    proj.mkdir(parents=True, exist_ok=True)
    session_path = proj / f"{session_id}.jsonl"
    lines: list[str] = []
    ts = 1_700_000_000
    for user_text, assistant_text in turns:
        lines.append(
            json.dumps(
                {
                    "type": "user",
                    "cwd": cwd,
                    "entrypoint": "cli",
                    "timestamp": f"2024-01-01T10:{ts % 60:02d}:00Z",
                    "message": {"role": "user", "content": user_text},
                }
            )
        )
        ts += 1
        lines.append(
            json.dumps(
                {
                    "type": "assistant",
                    "timestamp": f"2024-01-01T10:{ts % 60:02d}:00Z",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": assistant_text}],
                    },
                }
            )
        )
        ts += 1
    session_path.write_text("\n".join(lines) + "\n")
    return session_path


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def auth() -> Path:
    """Skip the whole module unless we have real auth for a real LLM."""
    return _require_llm_auth()


@pytest.fixture
def sandbox(tmp_path: Path, auth: Path) -> dict[str, Any]:
    """Build an isolated XDG sandbox + worktree per test."""
    env = _make_sandbox(tmp_path)
    worktree = tmp_path / "repo"
    # Always need a git repo as cwd so `Instance.worktree` resolves.
    _make_git_repo(
        worktree,
        [
            ("README.md", "chore: initial commit\n\nseed repo"),
        ],
    )
    return {
        "env": env,
        "home": tmp_path / "home",
        "config_dir": Path(env["XDG_CONFIG_HOME"]),
        "data_dir": Path(env["XDG_DATA_HOME"]) / "opencode",
        "worktree": worktree,
        "tmp": tmp_path,
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestMemoryStatus:
    def test_status_empty_on_fresh_sandbox(self, sandbox: dict[str, Any]) -> None:
        _write_config(sandbox["config_dir"], memories={"enabled": True})
        rc, out, err = _run_cli(
            ["memory", "status", "--json"],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0, f"status failed: {err}\n{out}"
        status = _extract_json_tail(out)
        assert status["sextupleCount"] == 0
        assert status["embeddedCount"] == 0
        assert status["foreignIngest"] == []


class TestMemoryIngestWithLlmExtraction:
    """Test #1 from the plan — enable memories, ingest 3 synthetic
    defect-resolution sessions, verify sextupleCount > 0 after the
    real-LLM Phase-1 extraction runs."""

    def test_ingest_claude_sessions_produces_sextuples(
        self, sandbox: dict[str, Any]
    ) -> None:
        _write_config(
            sandbox["config_dir"],
            memories={
                "enabled": True,
                "extractionModel": MODEL,
            },
        )

        projects_dir = sandbox["tmp"] / "fake-claude-projects"
        cwd = str(sandbox["worktree"])

        # 3 sessions each describing a distinct defect + fix.
        _make_claude_session(
            projects_dir,
            "proj-a",
            "sess-react-loop",
            cwd,
            turns=[
                (
                    "The React app crashes with 'Maximum update depth exceeded' "
                    "when clicking the save button. How do I fix it?",
                    "This is caused by setState being called inside the render "
                    "path or useEffect without proper dependencies. Move the "
                    "update into an event handler or add a dependency array.",
                ),
                (
                    "Wrapping setState in useCallback fixed it. Test passed!",
                    "Great — glad that worked.",
                ),
            ],
        )
        _make_claude_session(
            projects_dir,
            "proj-b",
            "sess-sql-injection",
            cwd,
            turns=[
                (
                    "Our /api/users endpoint is vulnerable to SQL injection because "
                    "we interpolate the username directly into the query string.",
                    "Replace the string interpolation with parameterised queries "
                    "(prepared statements). Every popular driver supports them.",
                ),
                (
                    "Refactored to use prepared statements and the security tests "
                    "now all pass.",
                    "Perfect — prepared statements are the canonical fix.",
                ),
            ],
        )
        _make_claude_session(
            projects_dir,
            "proj-c",
            "sess-race-socket",
            cwd,
            turns=[
                (
                    "Our socket writer drops messages when two coroutines call "
                    "write() concurrently. This is a race condition.",
                    "Add a mutex (or asyncio.Lock) around the write queue so "
                    "only one coroutine can append at a time.",
                ),
                (
                    "Added the lock and the message-drop test is now green. Fixed.",
                    "Nice — that's the classic fix for this kind of race.",
                ),
            ],
        )

        rc, out, err = _run_cli(
            [
                "memory",
                "ingest",
                "--tool",
                "claude",
                "--path",
                str(projects_dir),
                "--extract",
                "--json",
            ],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0, f"ingest failed: {err}\n{out}"
        stats = _extract_json_tail(out)
        assert stats["discovered"] == 3
        assert stats["parseFailed"] == 0
        assert stats["inserted"] >= 1, (
            f"expected ≥1 sextuples extracted, got {stats}. "
            "(Real-LLM extraction can occasionally produce zero valid "
            "sextuples for a trivial transcript — bump the MODEL if this "
            "is consistently zero.)"
        )

        # Status must reflect the insert.
        rc, out, _ = _run_cli(
            ["memory", "status", "--json"],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0
        status = _extract_json_tail(out)
        assert status["sextupleCount"] > 0
        # The `claude` adapter labels sessions as `claude_code` (entrypoint=cli).
        tools = {row["tool"]: row["count"] for row in status["foreignIngest"]}
        assert tools.get("claude_code", 0) == 3


class TestMemoryReset:
    """Test #3 — `memory reset` drops sextuple count back to 0."""

    def test_reset_clears_sextuples(self, sandbox: dict[str, Any]) -> None:
        _write_config(
            sandbox["config_dir"],
            memories={"enabled": True, "extractionModel": MODEL},
        )
        # Seed the store via a single-session ingest with --extract.
        projects_dir = sandbox["tmp"] / "fake-claude-projects"
        _make_claude_session(
            projects_dir,
            "proj-seed",
            "sess-seed",
            str(sandbox["worktree"]),
            turns=[
                (
                    "Our CSV parser crashes on empty input files with an "
                    "IndexError. How do I fix it?",
                    "Check `len(rows) > 0` before indexing — an empty CSV "
                    "produces a zero-length list.",
                ),
                (
                    "Added the length guard and the test is green. Fixed.",
                    "Good — defensive boundary checks are the right call.",
                ),
            ],
        )
        rc, _, err = _run_cli(
            [
                "memory",
                "ingest",
                "--tool",
                "claude",
                "--path",
                str(projects_dir),
                "--extract",
                "--json",
            ],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0, err

        rc, out, _ = _run_cli(
            ["memory", "status", "--json"],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        seeded = _extract_json_tail(out)
        # Real LLM may occasionally produce zero. If so, the reset assertion
        # below is still valid — we just can't prove the drop was meaningful.
        initial = seeded["sextupleCount"]

        rc, out, err = _run_cli(
            ["memory", "reset", "--yes", "--json"],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0, f"reset failed: {err}\n{out}"
        result = _extract_json_tail(out)
        assert result["deletedSextuples"] == initial
        assert result["deletedCheckpoints"] >= 1  # ingest checkpoint row

        rc, out, _ = _run_cli(
            ["memory", "status", "--json"],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        status = _extract_json_tail(out)
        assert status["sextupleCount"] == 0
        assert status["foreignIngest"] == []


class TestForeignIngestCheckpoint:
    """Test #5 — `memory ingest` records a checkpoint so re-running
    marks the session as already-done."""

    def test_checkpoint_prevents_reingest(self, sandbox: dict[str, Any]) -> None:
        _write_config(
            sandbox["config_dir"],
            memories={"enabled": True},
        )
        projects_dir = sandbox["tmp"] / "fake-claude-projects"
        _make_claude_session(
            projects_dir,
            "proj-check",
            "sess-check",
            str(sandbox["worktree"]),
            turns=[
                (
                    "Fix: null pointer in parser on empty token list.",
                    "Added a len() guard before indexing.",
                ),
            ],
        )

        # First ingest (no --extract — we only care about the checkpoint).
        rc, out, err = _run_cli(
            [
                "memory",
                "ingest",
                "--tool",
                "claude",
                "--path",
                str(projects_dir),
                "--json",
            ],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0, f"first ingest failed: {err}\n{out}"
        first = _extract_json_tail(out)
        assert first["discovered"] == 1
        assert first["skippedDone"] == 0

        # Second ingest — same session; must be skipped via checkpoint.
        rc, out, err = _run_cli(
            [
                "memory",
                "ingest",
                "--tool",
                "claude",
                "--path",
                str(projects_dir),
                "--json",
            ],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        assert rc == 0, f"second ingest failed: {err}\n{out}"
        second = _extract_json_tail(out)
        assert second["discovered"] == 1
        assert second["skippedDone"] == 1
        assert second["parseFailed"] == 0

        # Status must show the checkpoint count.
        rc, out, _ = _run_cli(
            ["memory", "status", "--json"],
            cwd=sandbox["worktree"],
            env=sandbox["env"],
        )
        status = _extract_json_tail(out)
        tools = {row["tool"]: row["count"] for row in status["foreignIngest"]}
        assert tools.get("claude_code", 0) == 1


class TestCommitCrawler:
    """Test #6 — `memory crawl --polish` walks recent commits and emits a
    JSONL cache of polished sextuples."""

    def test_crawl_emits_jsonl_with_real_llm_polisher(
        self, sandbox: dict[str, Any]
    ) -> None:
        _write_config(
            sandbox["config_dir"],
            memories={
                "enabled": True,
                "polishModel": MODEL,
            },
        )
        # Tight, defect-resolution-flavoured commits to give the LLM
        # something substantive to polish.
        repo = sandbox["tmp"] / "crawl-repo"
        _make_git_repo(
            repo,
            [
                (
                    "parser.py",
                    textwrap.dedent(
                        """
                        fix: null pointer crash in parser on empty input

                        The parser previously dereferenced a null pointer when
                        the input string was empty. Guard with a length check
                        before the dereference.
                        """
                    ).strip(),
                ),
                (
                    "socket.py",
                    textwrap.dedent(
                        """
                        fix: race condition in socket writer causing dropped messages

                        Added a mutex around the write queue to prevent
                        simultaneous writes from two coroutines clobbering
                        each other.
                        """
                    ).strip(),
                ),
            ],
        )

        rc, out, err = _run_cli(
            [
                "memory",
                "crawl",
                "--polish",
                "--json",
            ],
            cwd=repo,
            env=sandbox["env"],
        )
        assert rc == 0, f"crawl failed: {err}\n{out}"
        stats = _extract_json_tail(out)
        assert stats["commitsWalked"] >= 2
        # The real LLM polisher should distill at least one of the two
        # defect-fix commits into a valid sextuple.
        assert stats["sextuplesEmitted"] >= 1, (
            f"expected ≥1 sextuple emitted with --polish, got {stats}"
        )
        assert stats["errors"] == 0

        # JSONL file should exist under <data>/memory/commit_memory/<hash>.jsonl
        commit_mem = sandbox["data_dir"] / "memory" / "commit_memory"
        assert commit_mem.is_dir(), f"commit_memory dir missing: {commit_mem}"
        jsonls = list(commit_mem.glob("*.jsonl"))
        assert len(jsonls) == 1, f"expected 1 jsonl, got {jsonls}"
        lines = [
            ln for ln in jsonls[0].read_text().splitlines() if ln.strip()
        ]
        assert len(lines) >= 1
        parsed = json.loads(lines[0])
        # Schema assertions mirroring the Rust format.
        for field in ("keywords", "problem", "root_cause", "solution", "source"):
            assert field in parsed, f"missing {field} in {parsed}"
        assert parsed["source"]["type"] == "commit"
        assert len(parsed["problem"]) >= 20


HELPER_DIR = Path(__file__).resolve().parent / "helpers"


def _run_helper(
    script_name: str,
    *,
    env: dict[str, str],
    timeout: int = CLI_TIMEOUT,
) -> subprocess.CompletedProcess[str]:
    """Invoke one of the `helpers/*.ts` bun scripts from inside the
    opencode package so `node_modules/effect@4.x` resolves correctly."""
    script = HELPER_DIR / script_name
    cmd = [
        "bun",
        "run",
        "--conditions=browser",
        str(script),
        env["XDG_DATA_HOME"],
        env["XDG_CACHE_HOME"],
        env["XDG_CONFIG_HOME"],
        env["XDG_STATE_HOME"],
    ]
    return subprocess.run(
        cmd,
        cwd=str(OPENCODE_PKG_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class TestRetrievalModes:
    """Test #4 — `memories.retrieval.mode` of `cosine` vs `bm25` vs
    `hybrid` produces different candidate orderings for the same query.

    This test exercises the retrieval pipeline directly via a small bun
    helper (the CLI has no `memory search` subcommand). The helper seeds
    a handful of sextuples with deliberately-divergent lexical vs.
    semantic overlap so each ranker picks a different top hit."""

    def test_retrieval_modes_produce_distinct_orderings(
        self, sandbox: dict[str, Any]
    ) -> None:
        _write_config(sandbox["config_dir"], memories={"enabled": True})
        proc = _run_helper("retrieve-modes.ts", env=sandbox["env"])
        assert proc.returncode == 0, (
            f"retrieval-modes helper failed: {proc.stderr}\n{proc.stdout}"
        )
        payload = _extract_json_tail(proc.stdout)
        cosine_ids = [h["hashId"] for h in payload["cosine"]]
        bm25_ids = [h["hashId"] for h in payload["bm25"]]
        hybrid_ids = [h["hashId"] for h in payload["hybrid"]]
        # All three modes must produce ≥1 candidate.
        assert cosine_ids and bm25_ids and hybrid_ids, payload
        # At least one pair of modes must differ on ordering or on membership.
        # (Identical rankings across every mode defeats the hybrid design.)
        distinct = {
            tuple(cosine_ids),
            tuple(bm25_ids),
            tuple(hybrid_ids),
        }
        assert len(distinct) > 1, (
            f"expected at least one mode to differ from the others; "
            f"got cosine={cosine_ids} bm25={bm25_ids} hybrid={hybrid_ids}"
        )


class TestEnrichPromptInjection:
    """Test #2 — new session with a query related to a past defect sees a
    `<similar_past_problems>` block prepended via `Memory.enrichPrompt`.

    Like test #4, this drives the Memory facade directly from a bun helper
    because there's no CLI surface for ad-hoc prompt enrichment."""

    def test_enrich_prompt_injects_similar_past_problems(
        self, sandbox: dict[str, Any]
    ) -> None:
        _write_config(sandbox["config_dir"], memories={"enabled": True})
        proc = _run_helper("enrich-prompt.ts", env=sandbox["env"])
        assert proc.returncode == 0, (
            f"enrich-prompt helper failed: {proc.stderr}\n{proc.stdout}"
        )
        payload = _extract_json_tail(proc.stdout)
        # `block` carries the `<similar_past_problems>` block when there's a hit;
        # `null` when the retrieval came up empty.
        block = payload.get("block")
        assert block, f"expected a non-empty injected block; got {payload}"
        assert "<similar_past_problems>" in block
        assert "</similar_past_problems>" in block
        # The single seeded defect's problem text must appear verbatim-ish.
        assert "React" in block or "useEffect" in block
