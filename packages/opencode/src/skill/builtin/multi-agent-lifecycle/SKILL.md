---
name: multi-agent-lifecycle
description: Sub-agent spawn, wait, close, resume lifecycle and account lease management
version: 1
tags: [agent, sub-agent, spawn, wait, close, resume, lifecycle, collab, lease]
execution_mode: knowledge
dependencies: []
---

# Multi-Agent Lifecycle

## When to use
When working with the collaboration tool surface (spawn_agent, wait_agent,
close_agent, resume_agent, list_agents) or debugging sub-agent behavior.

## Reference file
`codex-rs/core/src/tools/handlers/multi_agents.rs`

## Tool surface
The model calls these tools to manage sub-agents:
- `spawn_agent` — create and start a new sub-agent
- `send_input` — send a message to a running agent
- `wait_agent` — wait for agent(s) to produce output
- `close_agent` — terminate an agent
- `resume_agent` — restart a closed agent within its shutdown window
- `list_agents` — list all agents with status and available actions

## Lifecycle flow

### spawn_agent
1. Check thread spawn depth limit (prevents infinite nesting)
2. Acquire an account lease from the `AccountPool`
3. Configure the sub-agent:
   - Inherit parent's effective config (provider, approval policy, sandbox, cwd)
   - Layer role-specific config on top (model, reasoning effort, etc.)
   - Inherit runtime state (copilot premium tracking is `Arc`-shared)
4. Build a knowledge base for the sub-agent:
   - `KnowledgeBaseBuilder::new(kb_config)` extracts from session events
5. Start the agent
6. Emit `CollabAgentSpawnBeginEvent` / `CollabAgentSpawnEndEvent`

### wait_agent
- Waits for ALL specified agents (does NOT break on first completion)
- Timeout bounds: MIN = 10s, DEFAULT = 30s, MAX = 1 hour
- Returns status for each agent when all complete or timeout expires
- Emits `CollabWaitingBeginEvent` / `CollabWaitingEndEvent`

### close_agent
- Terminates the agent and releases its account lease
- For already-archived agents: returns the cached final status immediately
  without re-terminating (idempotent)
- Emits `CollabCloseBeginEvent` / `CollabCloseEndEvent`

### resume_agent
- Restarts a previously closed agent within a 30-second shutdown window
- After 30s the agent is fully archived and cannot be resumed
- The agent retains its original account lease
- Emits `CollabResumeBeginEvent` / `CollabResumeEndEvent`

### list_agents
- Returns all agents with their current status
- Includes `actions` metadata per agent (which tools can be called next)
- Shows: id, status, model, role, last activity timestamp
- Hides agents that have been fully archived (auto-purged)

## Account lease lifecycle
```
spawn_agent
  → pool.acquire()           ← blocks if all accounts are full/rate-limited
  → AccountLease (RAII)      ← lease lives as long as the agent

close_agent
  → drop(AccountLease)       ← releases slot, wakes waiters

resume_agent (within 30s)
  → reuses existing lease    ← no re-acquire needed
```

Sub-sub-agents inherit their parent sub-agent's account (no nested acquire).

## Event flow
Each lifecycle operation emits begin/end event pairs:
- `CollabAgentSpawnBegin` → spawn → `CollabAgentSpawnEnd`
- `CollabWaitingBegin` → wait → `CollabWaitingEnd`
- `CollabCloseBegin` → close → `CollabCloseEnd`
- `CollabResumeBegin` → resume → `CollabResumeEnd`

These events are forwarded to the parent session for UI rendering and
guardian review routing.

## Key rules
- wait_agent waits for ALL agents, not just the first to finish
- close_agent returns cached status for already-archived agents (idempotent)
- resume_agent only works within the 30s shutdown window
- Sub-agents inherit parent's provider, sandbox, and approval policy
- Account leases are RAII — always released on agent drop
- Premium request tracking is shared via Arc between parent and sub-agents
