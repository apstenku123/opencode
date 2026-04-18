---
name: fix-rust-compilation
description: Diagnose and fix Rust compilation errors using patterns from our codex_git codebase
version: 2
tags: [rust, compilation, debugging, cargo, E0063, E0616, E0282, E0252, E0308]
execution_mode: knowledge
dependencies: []
---

# Fix Rust Compilation Errors

## When to use
When `cargo check` or `cargo build` fails with compilation errors. This skill
encodes patterns we encounter repeatedly in our Codex fork when merging upstream
changes or adding new features.

## Critical rule
NEVER run `cargo check` or `cargo build` mid-fix. Finish ALL code edits first,
then build once at the end. This avoids wasting time on cascading intermediate
errors.

## Triage strategy
1. Capture ALL error output from the failed build.
2. Count total errors. If >10, focus on the FIRST error only (cascade effect
   means later errors are usually caused by the first).
3. Identify the error code (E0063, E0616, etc.) and apply the matching pattern
   below.
4. After fixing ALL identified errors in one pass, run `cargo check` once.

## Error patterns

### E0063 — missing field in struct literal
**Symptom:** `missing field 'foo' in initializer of 'Bar'`
**Fix:** Find the struct definition, add the missing field with its `Default`
value or a sensible zero-value.

**Real example (thread_history.rs — memory_citation):**
After upstream added a `memory_citation: Option<String>` field to a response
struct, every constructor site broke. Fix: add `memory_citation: None` to every
struct literal.

**Pattern:**
```rust
// Before (fails E0063):
SomeStruct { existing_field: value }
// After:
SomeStruct { existing_field: value, new_field: Default::default() }
```

When the struct has many fields and you only added one, use `..Default::default()`
if the struct implements `Default`.

### E0616 — field is private
**Symptom:** `field 'foo' of struct 'Bar' is private`
**Fix:** Add `pub(crate)` to the field declaration in the struct definition.
Only use `pub` if the field must be visible outside the crate.

```rust
// In the struct definition:
pub(crate) field_name: FieldType,
```

### E0282 — type annotations needed
**Symptom:** `type annotations needed` or `cannot infer type`
**Fix:** Add an explicit type annotation. Common in turbofish scenarios or
when collecting iterators.

```rust
// Before:
let items = vec.iter().collect();
// After:
let items: Vec<&str> = vec.iter().collect();
```

### E0252 — duplicate import / name collision
**Symptom:** `the name 'Foo' is defined multiple times`
**Fix:** Remove the duplicate import, or alias one with `as`. In our fork
files (*_fork.rs), check that both the fork and the main file do not import
the same symbol.

### E0308 — mismatched types
**Symptom:** `expected 'A', found 'B'`
**Fix:** Check the function signature. Common patterns:

**Real example (cloud-requirements — Ok(_) fix):**
A function returned `Result<(), Error>` but the call site used `Ok(response)`
instead of `Ok(())`. Fix: change the return to `Ok(())` and handle the response
value before the return.

```rust
// Before (fails E0308):
Ok(response)  // where fn returns Result<(), Error>
// After:
drop(response);
Ok(())
```

Also watch for `Ok(())` vs `Ok(value)` when the return type wraps a value.

### E0277 — trait not implemented
**Fix:** Add `#[derive(Debug, Clone)]` or implement the trait manually. In our
codebase, `Send + Sync` bounds are common — make sure inner types are `Send`.

### E0433 — unresolved import
**Fix:** Check module path, add missing `use` statement, or check that the
module is declared in `mod.rs` / `lib.rs`.

### E0382 — use after move
**Fix:** Add `.clone()` before the move, or restructure to borrow. In async
code, `Arc::clone(&val)` is the usual pattern.

## Our codebase conventions
- Fork-specific code lives in `*_fork.rs` files.
- Thin hooks in shared files: only imports + 1-2 line function calls.
- After upstream merges, the most common errors are E0063 (missing fields) and
  E0433 (changed import paths).
- Always check if `Default` is derived before using `..Default::default()`.
