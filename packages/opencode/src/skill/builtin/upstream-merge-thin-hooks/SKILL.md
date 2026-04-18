---
name: upstream-merge-thin-hooks
description: Our fork merge workflow using thin hooks and _fork.rs files to minimize upstream conflicts
version: 1
tags: [git, merge, upstream, fork, thin-hooks, cargo, insta]
execution_mode: knowledge
dependencies: [git, cargo]
---

# Upstream Merge — Thin Hooks Workflow

## When to use
When pulling latest upstream changes into our fork (codex_git_upstream_sync_thin
branch) and resolving the resulting compilation errors.

## Architecture: thin hooks
Our fork strategy keeps upstream files as close to unmodified as possible:

1. **Fork-specific code lives in `*_fork.rs` files.** All substantial custom
   logic goes here. These files are 100% ours — upstream never touches them.

2. **Thin hooks in shared files.** In upstream-owned files, our changes are
   limited to:
   - Import statements (`use crate::some_fork_module;`)
   - 1-2 line function calls (`fork_module::hook_function(args);`)
   - No inline logic modifications to upstream code.

3. **Never modify upstream logic inline.** If upstream restructures a function,
   our thin hook call just needs to be re-inserted at the right place.

## Merge procedure

### Step 1: Pull latest upstream
```bash
git fetch upstream
git merge upstream/main --no-commit
```

### Step 2: Resolve conflicts
For each conflicted file:
- If it is a `*_fork.rs` file: keep OURS entirely.
- If it is an upstream file with thin hooks: take THEIRS, then re-add our
  import + hook call lines.
- Read surrounding context to understand if upstream moved code around.

### Step 3: Fix compilation errors
Run `cargo check` once (after all edits). The most common errors after a merge:

- **E0063 (missing field):** Upstream added a field to a struct. Find the struct
  definition, add the new field with a default value to every constructor site.
- **E0433 (unresolved import):** Upstream renamed or moved a module/type. Update
  the import paths in our fork files.
- **E0616 (private field):** Upstream made a field private. Add `pub(crate)`.
- **E0599 (method not found):** Upstream changed a method signature. Update the
  call site.

### Step 4: Accept snapshot tests
If there are insta snapshot test changes:
```bash
cargo insta review
# or accept all:
cargo insta accept
```

### Step 5: Verify
```bash
cargo check
cargo test  # if time permits
```

## Common pitfalls
- **Do not re-add hooks that upstream deleted context around.** If the function
  that held our hook was removed, the hook needs a new home.
- **Watch for struct field ordering.** Some structs have `..Default::default()`
  at the end — adding a field before that suffix still triggers E0063 if the
  field is not `Default`.
- **Module declarations.** If we added `mod foo_fork;` to a `mod.rs` and
  upstream restructured `mod.rs`, re-add our module declaration.

## File layout conventions
```
codex-rs/core/src/
  some_feature.rs           ← upstream owned
  some_feature_fork.rs      ← our additions (100% ours)
  mod.rs                    ← upstream owned, we add `mod some_feature_fork;`
```
