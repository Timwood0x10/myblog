+++
title = "Rust FFI Auditor: Reconstructing and Checking Cross-Language Ownership Protocols"
date = 2026-05-21
description = "Rust FFI risk often appears when Rust’s ownership and borrowing protocols cross an ABI boundary. `RustFfiAuditor` maps those protocols back onto LLVM IR patterns that can be inspected statically."
weight = 21
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# Rust FFI Auditor: Reconstructing and Checking Cross-Language Ownership Protocols

Rust FFI risk often appears when Rust’s ownership and borrowing protocols cross an ABI boundary. `RustFfiAuditor` maps those protocols back onto LLVM IR patterns that can be inspected statically.

## Rule surface

`RustFfiAuditor` is defined at `src/pass/analysis/rust_ffi_auditor.zig:63`. Its function-level logic covers Rust-specific patterns and general FFI boundary checks:

- `into_raw` without a matching `from_raw`;
- `as_ptr` borrow escape;
- Rust allocator and C `free` mismatch;
- ownership-transfer protocol violations;
- dangling `as_ptr` after parent object drop;
- unsafe FFI calls;
- stack address escape to `extern C`.

```mermaid
flowchart TD
    A[RustFfiAuditor] --> B[Box::into_raw / from_raw]
    A --> C[as_ptr borrow escape]
    A --> D[allocator mismatch]
    A --> E[ownership transfer]
    A --> F[dangling as_ptr]
    A --> G[unsafe FFI call]
    A --> H[stack escape]
```

## `as_ptr` borrow escape: recovering a lifetime risk from IR calls

`detectAsPtrEscape` is implemented at `src/pass/analysis/rust_ffi_auditor.zig:180`. It iterates LLVM functions, basic blocks, and instructions; handles only `LLVMCall` and `LLVMInvoke`; retrieves the callee from the final operand; reads the callee name; and matches Rust `as_ptr` patterns.

```mermaid
flowchart TD
    A[LLVM Function] --> B[BasicBlock iterator]
    B --> C[Instruction iterator]
    C --> D{opcode == call/invoke?}
    D -->|No| C
    D -->|Yes| E[Read callee operand]
    E --> F[LLVMGetValueName]
    F --> G{isRustAsPtrCall?}
    G -->|No| C
    G -->|Yes| H[addFinding + ctx.addIssue]
```

The risk is that `String` or `Vec` `as_ptr` returns a borrowed pointer. If C stores it, the Rust object may be dropped while C still holds the address.

```mermaid
sequenceDiagram
    participant R as Rust local Vec/String
    participant P as raw pointer from as_ptr
    participant C as C FFI callee
    R->>P: as_ptr()
    P->>C: pass pointer
    R->>R: local value dropped
    C->>P: later use
    P-->>C: dangling pointer risk
```

At `src/pass/analysis/rust_ffi_auditor.zig:212`, the rule creates a `borrow_escape` issue through `Issue.initWithReason`, with a reason explaining that a local `String/Vec` pointer passed to extern C may dangle.

## `into_raw/from_raw`: ownership transfer should close correctly

`Box::into_raw` converts Rust-managed heap ownership into a raw pointer. The caller must ensure the later deallocation protocol is correct. Missing restoration can leak; double restoration can double free; C-side release can produce allocator mismatch depending on allocation protocol.

```mermaid
flowchart LR
    A[Box<T>] --> B[Box::into_raw]
    B --> C[*mut T]
    C --> D{Later protocol}
    D -->|from_raw exactly once| E[Ownership restored]
    D -->|Never restored| F[Leak risk]
    D -->|C free + Rust drop| G[Double free / allocator mismatch]
```

`into_raw` alone is not a vulnerability. The finding depends on the surrounding protocol and subsequent pointer flow.

## Cross-language allocator mismatch

`detectCrossLangMismatch` starts at `src/pass/analysis/rust_ffi_auditor.zig:230`. It iterates call/invoke instructions and attempts to identify Rust allocation paired with C deallocation.

```mermaid
sequenceDiagram
    participant RA as Rust allocator
    participant IR as LLVM IR pointer
    participant CF as C free
    RA->>IR: allocate / expose pointer
    IR->>CF: pointer crosses ABI
    CF->>CF: free(pointer)
    CF-->>RA: allocator ownership contract may be violated
```

The accuracy of this kind of check depends on symbol names, preserved call relationships, wrappers, inlining, and custom allocators.

## General FFI checks

The auditor also runs checks that are not Rust-only, such as unsafe FFI call scanning and stack address escape. Stack escape is relevant when a pointer to a local object is passed to C and then stored beyond the call.

```mermaid
flowchart TD
    A[alloca / local stack object] --> B[Take address]
    B --> C[Pass to extern C]
    C --> D{Does C store it?}
    D -->|Yes| E[Dangling after return]
    D -->|No| F[Depends on call-duration use]
```

## Summary

`RustFfiAuditor` maps Rust ownership and borrowing concepts onto IR-level call and pointer patterns. It should be described as static protocol recovery and checking, with accuracy bounded by available IR information.
