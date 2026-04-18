---
name: copilot-rate-limit-tuning
description: Rate limit strategy for Copilot accounts with conservative retries and per-account RPM tracking
version: 1
tags: [copilot, rate-limit, 429, retry, rpm, premium, sliding-window, tuning]
execution_mode: knowledge
dependencies: []
---

# Copilot Rate Limit Tuning

## When to use
When tuning rate limit parameters, debugging 429 storms, or understanding
why agents are being throttled.

## Reference files
- `codex-rs/core/src/account_pool.rs` — per-account cooldowns and recovery
- `codex-rs/core/src/client.rs` — 429 handling, premium tracking

## Real Copilot rate limits (empirical)
- **Safe sustained rate:** 2 RPM per account
- **Burst capacity:** ~10 RPM (will trigger 429 quickly)
- **Retry-After behavior:** Server returns header with seconds to wait
- **Model multipliers:** Some models consume more quota (e.g., Opus 4.6
  uses more than GPT-5.4)

## Conservative retry strategy
Our thin branch uses fail-fast with account failover instead of long waits:

1. **4 retries maximum** per request (across all retry-eligible errors)
2. **60s base delay** for rate-limit retries (when no Retry-After header)
3. **Always respect Retry-After** — if the header says 120s, wait 120s
4. **Never retry on 429 immediately** — even a 1-second delay is mandatory

## CopilotRateLimiter (sliding window)
Per-account RPM tracking uses a sliding window:
- Window size matches the provider's rate limit period
- Tracks request timestamps within the window
- When the window is full, new requests must wait

## Per-account recovery (from account_pool.rs)
After a 429, the account enters a cooldown with staged recovery:

| Time after 429 | Max agents | Request interval |
|-----------------|-----------|-----------------|
| 0 - 5 min      | 1         | 30s             |
| 5 - 10 min     | 2         | 12s             |
| 10 - 15 min    | 3 (full)  | 7.5s            |

## Headerless 429 handling
When no Retry-After header is present (rare but happens):
- 1st occurrence: 11 minute cooldown
- 2nd occurrence: 21 minute cooldown
- 3rd occurrence: 41 minute cooldown

The thin branch records these but does NOT block — it returns false and lets
the caller decide what to do.

## Premium request tracking
Each Copilot account gets exactly 1 premium request per session (or per turn,
if per-turn billing is enabled):

```
copilot_premium_sent_models: Arc<StdMutex<HashSet<String>>>
```

- First request to each model: `x-initiator: "user"` (premium, billed)
- All subsequent requests to same model: `x-initiator: "agent"` (free)
- Parent and sub-agents share the same tracker via `Arc` — prevents each
  sub-agent from making its own premium request
- `/noprem` command or `--noprem` flag forces the next request to be non-premium

## Account-level RPM budget
With `MAX_AGENTS_PER_ACCOUNT = 3` and 7 accounts:
- Total capacity: 21 sub-agents + 1 main
- At 2 RPM safe rate: ~14 RPM total across all accounts
- At burst: ~70 RPM briefly, then 429 storm

## Tuning guidelines

### For stability (production)
- Keep `MAX_AGENTS_PER_ACCOUNT` at 3
- Use all available backup accounts
- Let recovery timers run their full course
- Monitor `/status` for 429 frequency

### For speed (development)
- Accept higher 429 rate
- Use `reserve_failover_token` for sub-agents (prevents oversubscription)
- Monitor RPM per account — if consistently >2 RPM, add more accounts

### For debugging 429 storms
1. Check `/status` — which accounts are rate-limited?
2. Check `headerless_429_count` — are we getting headerless 429s?
3. Check `active_leases` per account — is one account overloaded?
4. Check premium tracking — is each model getting only 1 premium request?

## Key rules
- NEVER retry on 429 immediately — always respect retry-after
- NEVER add inline wait-and-retry to the client layer (use hooks instead)
- Premium tracking is 1 per account per session per model
- The thin branch returns false on unrecoverable 429 (fail-fast)
- Account rotation is the primary recovery mechanism, not waiting
