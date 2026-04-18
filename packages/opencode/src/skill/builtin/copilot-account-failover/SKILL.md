---
name: copilot-account-failover
description: How our Copilot account pool handles 429 rate limits and failover between accounts
version: 1
tags: [copilot, account, failover, 429, rate-limit, pool, token]
execution_mode: knowledge
dependencies: []
---

# Copilot Account Failover

## When to use
When debugging 429 errors, account rotation issues, or sub-agent starvation
in our multi-account Copilot setup.

## Architecture overview

Reference files:
- `codex-rs/core/src/account_pool.rs` — pool, slots, leases, failover
- `codex-rs/core/src/client.rs` — 429 detection, `record_rate_limit_429`, `handle_rate_limit_recovery`

### Account pool structure
- **Primary account:** Always used by the main (root) agent. No lease needed.
- **Backup accounts:** Used by sub-agents when the primary is at capacity.
- **MAX_AGENTS_PER_ACCOUNT = 3:** With 7 accounts, supports 21 sub-agents + 1 main.
- Pool is `Arc<AccountPoolInner>` with `Notify` for wake-on-release.

### AccountSlot
Each account has:
- `key` — connection identifier (e.g. "github-copilot", "backup-1")
- `label` — display name for UI
- `token` — bearer token for API calls
- `active_leases` — AtomicU32 tracking concurrent agents

### AccountLease (RAII)
Returned by `pool.acquire()`. Dropping the lease:
1. Calls `slot.release()` (atomic decrement)
2. Calls `pool.notify.notify_waiters()` to wake blocked acquires
Supports `reassign(new_key, new_token)` for runtime failover without releasing.

## 429 detection and failover flow

### Step 1: Detect 429
```
is_api_error_429(err) → true
```

### Step 2: Record the rate limit
```
record_rate_limit_429(state, err)
  → extract retry-after from API error headers
  → pool.record_429(key, retry_after, retry_delay)
  → invoke AccountRateLimitHook if registered
```

### Step 3: Attempt failover
```
handle_rate_limit_recovery(client, err, model_id, transport)
  → record_rate_limit_429(...)
  → if sub-agent: pool.reserve_failover_token(current_key)
    else:         pool.failover_token(current_key)
  → if Some((new_key, new_token)):
      activate_account_with_hook(new_key, new_token)
      lease.reassign(new_key, new_token)
      return true  // retry
  → return false   // no recovery possible
```

### failover_token vs reserve_failover_token
- `failover_token()` — used by main agent. Returns best available account
  without consuming a concurrency slot.
- `reserve_failover_token()` — used by sub-agents. Atomically acquires a
  concurrency slot on the destination to prevent oversubscription.

### Account selection (select_best_account_slot)
Picks the best account by:
1. Skip current account (the one that got 429'd)
2. Skip accounts in 429 cooldown window
3. Skip accounts at MAX_AGENTS_PER_ACCOUNT
4. Skip accounts still pacing their request stream
5. Among remaining, prefer account with fewest active leases

## Recovery timing
After a 429, an account recovers in stages:
- **0-5 min:** Only 1 agent allowed (PARTIAL_REQUEST_RECOVERY_DELAY)
- **5-10 min:** 2 agents allowed (SECOND_AGENT_RECOVERY_DELAY)
- **10-15 min:** Full parallelism restored (FULL_AGENT_RECOVERY_DELAY)

Request pacing intervals:
- **Just 429'd:** 30s between requests (INITIAL_REQUEST_INTERVAL)
- **Partial recovery:** 20s (PARTIAL_REQUEST_INTERVAL)
- **Second agent:** 12s (SECOND_REQUEST_INTERVAL)
- **Healthy:** 7.5s (HEALTHY_REQUEST_INTERVAL)

## Headerless 429 fallback
When no Retry-After header is present, escalating delays:
- 1st: 11 minutes
- 2nd: 21 minutes
- 3rd: 41 minutes

## Thin branch architecture (fail-fast)
This branch does NOT implement the headerless wait-and-retry ladder from the
main fork. Instead:
1. Account failover — try another account
2. Hook validation — call activate_account_with_hook
3. Return false — signal caller that recovery failed

This prevents silent multi-hour hangs. All retry policy is delegated to hooks.

## Monitoring
- Use `/status` command in the TUI to see per-account state
- Check `pool.stats` for RPM counters
- Premium tracking: `copilot_premium_sent_models` (1 per account per session)

## Key rules
- NEVER retry on 429 immediately — always respect retry-after
- NEVER add headerless wait tiers back to the client layer
- Account activation hooks must validate before committing the switch
- Sub-agents inherit their parent's account (sub-sub-agents do not re-acquire)
