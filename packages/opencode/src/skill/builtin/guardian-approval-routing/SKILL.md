---
name: guardian-approval-routing
description: How the guardian review system intercepts and approves sub-agent actions
version: 1
tags: [guardian, approval, review, mcp, delegate, security, cancel-token]
execution_mode: knowledge
dependencies: []
---

# Guardian Approval Routing

## When to use
When debugging guardian approval flows, understanding why a sub-agent action was
approved/denied, or modifying the approval pipeline.

## Architecture overview

Reference files:
- `codex-rs/core/src/codex_delegate_guardian.rs` — routing helpers
- `codex-rs/core/src/guardian.rs` — review logic, `routes_approval_to_guardian()`

## Flow: delegated approval

### Step 1: Check if guardian is active
```rust
if !routes_approval_to_guardian(parent_ctx.as_ref()) {
    return None;  // no guardian — surface to user
}
```
`routes_approval_to_guardian()` checks the `TurnContext` for guardian enablement.

### Step 2: Build the review request
For each approval type, a `GuardianApprovalRequest` variant is constructed:

- **Shell exec:** `GuardianApprovalRequest::Shell { id, command, cwd, sandbox_permissions, ... }`
- **Apply patch:** `GuardianApprovalRequest::ApplyPatch { id, cwd, files, change_count, patch }`
- **MCP tool call:** `GuardianApprovalRequest::McpToolCall { id, server, tool_name, arguments, annotations, ... }`
- **Elicitation:** `GuardianApprovalRequest::Elicitation { ... }`

### Step 3: Spawn guardian review on a separate OS thread
```rust
pub(crate) fn spawn_guardian_review(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
    cancel_token: CancellationToken,
) -> oneshot::Receiver<ReviewDecision>
```

**Why a separate OS thread?** The guardian review runs its own tokio
`current_thread` runtime so it cannot deadlock the parent session's executor.
This is critical for `Send` safety — `Session` and `TurnContext` are `Arc`'d
and passed across thread boundaries.

```rust
std::thread::spawn(move || {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let decision = runtime.block_on(review_approval_request_with_cancel(...));
    let _ = tx.send(decision);
});
```

### Step 4: Wait for decision with cancel support
```rust
async fn await_guardian_review(...) -> ReviewDecision {
    if cancel_token.is_cancelled() {
        return ReviewDecision::Abort;
    }
    let review_cancel = cancel_token.child_token();
    let decision_rx = spawn_guardian_review(..., review_cancel.clone());
    wait_for_guardian_review(decision_rx, cancel_token, review_cancel).await
}
```

Cancel token propagation: parent cancel token creates a child token for the
review. If the parent is cancelled, the review is aborted.

### Step 5: Map decision to action
`ReviewDecision` variants:
- `Approved` — allow the action
- `ApprovedForSession` — allow and do not ask again this session
- `ApprovedExecpolicyAmendment` — allow with policy change
- `NetworkPolicyAmendment` — allow with network policy change
- `Denied` — block the action
- `Abort` — cancel (from cancel token)

## MCP tool approval special handling

### Cached invocations
MCP tool calls use a legacy `RequestUserInput` compatibility path. The call
metadata is cached in `pending_mcp_invocations: Arc<Mutex<HashMap<String, McpInvocation>>>`.

When a `RequestUserInput` event arrives:
1. Check if the question ID starts with `MCP_TOOL_APPROVAL_QUESTION_ID_PREFIX`
2. Look up the cached `McpInvocation` by `call_id`
3. Fetch tool metadata (annotations, description) from the MCP connection manager
4. Build `GuardianApprovalRequest::McpToolCall` and run the review

### MCP approval labels
- `MCP_TOOL_APPROVAL_ACCEPT` = "Allow"
- `MCP_TOOL_APPROVAL_ACCEPT_FOR_SESSION` = "Allow for this session"
- `MCP_TOOL_APPROVAL_DECLINE_SYNTHETIC` = "Cancel" (synthetic label for denials)

## ReviewCancelGuard (RAII)
A guard that cancels its token on drop (unless `disarm()` is called). Ensures
cleanup if the review future is dropped unexpectedly.

## Key rules
- Guardian reviews MUST run on a separate OS thread (not a tokio task)
- Always check `routes_approval_to_guardian()` before building a review request
- Cancel token must propagate parent cancellation to review
- MCP invocations must be cached in `pending_mcp_invocations` before the
  approval event arrives
