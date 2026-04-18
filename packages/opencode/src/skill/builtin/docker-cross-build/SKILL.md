---
name: docker-cross-build
description: Cross-platform build rules using Docker with zig CC wrappers for musl targets
version: 1
tags: [docker, build, cross-compile, musl, zig, boring-sys, aarch64, x86_64]
execution_mode: knowledge
dependencies: [docker]
---

# Docker Cross-Platform Build

## When to use
When building Codex binaries for Linux targets (musl) or when the build
fails with boring-sys2 / libcap linker errors.

## CRITICAL RULE
**NEVER build natively on host for cross-platform targets.** All cross-platform
builds MUST run inside a Docker container. Native builds will produce binaries
linked against the wrong libc or missing system libraries.

## Target triples
- `x86_64-unknown-linux-musl` — standard Linux x86-64 static binary
- `aarch64-unknown-linux-musl` — ARM64 Linux static binary

## Docker container setup
The container must have:
1. Rust toolchain with the target triple installed
2. Zig compiler (used as CC/CXX wrapper for musl cross-compilation)
3. musl-tools
4. cmake (for boring-sys2)

## Zig CC wrappers for musl
Zig is used as the C/C++ compiler for cross-compilation because it handles
musl sysroot paths correctly and produces static binaries without glibc
dependencies.

Create wrapper scripts:

**zig-cc (for CC):**
```bash
#!/bin/bash
exec zig cc -target x86_64-linux-musl "$@"
```

**zig-cxx (for CXX):**
```bash
#!/bin/bash
exec zig c++ -target x86_64-linux-musl "$@"
```

For aarch64, replace `x86_64-linux-musl` with `aarch64-linux-musl`.

Set environment:
```bash
export CC_x86_64_unknown_linux_musl=/path/to/zig-cc
export CXX_x86_64_unknown_linux_musl=/path/to/zig-cxx
```

## boring-sys2 fix
boring-sys2 (BoringSSL Rust bindings) requires special handling for musl:

1. Set `BORING_BSSL_PATH` to point to a pre-built BoringSSL for the target:
   ```bash
   export BORING_BSSL_PATH=/opt/boringssl-musl
   ```

2. If building BoringSSL from source, it needs cmake and the zig CC wrappers.

3. The build will fail without this — you get linker errors about missing
   `libssl` / `libcrypto` symbols.

## LIBRARY_PATH for libcap
Static linking against libcap requires:
```bash
export LIBRARY_PATH=/usr/lib/x86_64-linux-musl
```
Without this, the linker cannot find `-lcap` and the build fails with
`cannot find -lcap`.

## Build command
```bash
cargo build --release --target x86_64-unknown-linux-musl
```

## Full Docker build invocation example
```bash
docker run --rm \
  -v "$(pwd):/workspace" \
  -w /workspace \
  -e CC_x86_64_unknown_linux_musl=/workspace/zig-cc \
  -e CXX_x86_64_unknown_linux_musl=/workspace/zig-cxx \
  -e BORING_BSSL_PATH=/opt/boringssl-musl \
  -e LIBRARY_PATH=/usr/lib/x86_64-linux-musl \
  our-build-image:latest \
  cargo build --release --target x86_64-unknown-linux-musl
```

## Common errors and fixes

### `cannot find -lcap`
Missing `LIBRARY_PATH`. Set it to the musl lib directory.

### `failed to run custom build command for boring-sys2`
Missing `BORING_BSSL_PATH` or the pre-built BoringSSL is for the wrong target.

### `undefined reference to __stack_chk_fail`
The CC wrapper is not targeting musl. Check the zig target triple.

### `error: linker cc not found`
The CC environment variable is not set for the target triple. Use the
target-specific form: `CC_x86_64_unknown_linux_musl`.

## Key rules
- NEVER build natively on host for cross-platform — always Docker
- Always set BORING_BSSL_PATH for musl builds
- Always set LIBRARY_PATH for libcap
- Use zig CC wrappers, not system gcc
- Test the resulting binary with `ldd` — it should show "not a dynamic executable"
  (fully static)
