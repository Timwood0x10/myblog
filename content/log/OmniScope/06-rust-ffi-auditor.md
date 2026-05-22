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

## Start with the problem: Rust cannot verify what C does later

Inside Rust, `Box`, borrow, and drop have clear semantics. Once `extern "C"` exposes a raw pointer, those semantics become a protocol between two sides. C can store the pointer, release it later, call `free`, or pass it back through a callback. The Rust compiler no longer verifies those actions.

Rust FFI auditing therefore looks past "is there unsafe?" and asks whether the ownership protocol closes: who reclaims an `into_raw` pointer, whether an `as_ptr` borrow escapes, whether a stack address outlives the function, and whether allocation and deallocation use the same protocol.

## OmniScope’s entry point: Rust-specific rules plus universal FFI rules

`RustFfiAuditor` splits its rules into two layers. Rust-specific rules run on Rust modules and recover `into_raw/from_raw`, `as_ptr`, and borrow-dangling semantics. Universal FFI rules run on all modules and catch stack escape or unsafe boundary calls.

## Rule surface

`RustFfiAuditor` is defined at `src/pass/analysis/rust_ffi_auditor.zig:63`. Its function-level logic covers Rust-specific patterns and general FFI boundary checks:

- `into_raw` without a matching `from_raw`;
- `as_ptr` borrow escape;
- Rust allocator and C `free` mismatch;
- ownership-transfer protocol violations;
- dangling `as_ptr` after parent object drop;
- unsafe FFI calls;
- stack address escape to `extern C`.

{% mermaid() %}
flowchart TD
    A[RustFfiAuditor] --> B[Box::into_raw / from_raw]
    A --> C[as_ptr borrow escape]
    A --> D[allocator mismatch]
    A --> E[ownership transfer]
    A --> F[dangling as_ptr]
    A --> G[unsafe FFI call]
    A --> H[stack escape]
{% end %}

## `as_ptr` borrow escape: recovering a lifetime risk from IR calls

`detectAsPtrEscape` is implemented at `src/pass/analysis/rust_ffi_auditor.zig:180`. It iterates LLVM functions, basic blocks, and instructions; handles only `LLVMCall` and `LLVMInvoke`; retrieves the callee from the final operand; reads the callee name; and matches Rust `as_ptr` patterns.

{% mermaid() %}
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
{% end %}

The risk is that `String` or `Vec` `as_ptr` returns a borrowed pointer. If C stores it, the Rust object may be dropped while C still holds the address.

{% mermaid() %}
sequenceDiagram
    participant R as Rust local Vec/String
    participant P as raw pointer from as_ptr
    participant C as C FFI callee
    R->>P: as_ptr()
    P->>C: pass pointer
    R->>R: local value dropped
    C->>P: later use
    P-->>C: dangling pointer risk
{% end %}

At `src/pass/analysis/rust_ffi_auditor.zig:212`, the rule creates a `borrow_escape` issue through `Issue.initWithReason`, with a reason explaining that a local `String/Vec` pointer passed to extern C may dangle.

## `into_raw/from_raw`: ownership transfer should close correctly

`Box::into_raw` converts Rust-managed heap ownership into a raw pointer. The caller must ensure the later deallocation protocol is correct. Missing restoration can leak; double restoration can double free; C-side release can produce allocator mismatch depending on allocation protocol.

{% mermaid() %}
flowchart LR
    A[Box<T>] --> B[Box::into_raw]
    B --> C[*mut T]
    C --> D{Later protocol}
    D -->|from_raw exactly once| E[Ownership restored]
    D -->|Never restored| F[Leak risk]
    D -->|C free + Rust drop| G[Double free / allocator mismatch]
{% end %}

`into_raw` alone is not a vulnerability. The finding depends on the surrounding protocol and subsequent pointer flow.

## Cross-language allocator mismatch

`detectCrossLangMismatch` starts at `src/pass/analysis/rust_ffi_auditor.zig:230`. It iterates call/invoke instructions and attempts to identify Rust allocation paired with C deallocation.

{% mermaid() %}
sequenceDiagram
    participant RA as Rust allocator
    participant IR as LLVM IR pointer
    participant CF as C free
    RA->>IR: allocate / expose pointer
    IR->>CF: pointer crosses ABI
    CF->>CF: free(pointer)
    CF-->>RA: allocator ownership contract may be violated
{% end %}

The accuracy of this kind of check depends on symbol names, preserved call relationships, wrappers, inlining, and custom allocators.

## General FFI checks

The auditor also runs checks that are not Rust-only, such as unsafe FFI call scanning and stack address escape. Stack escape is relevant when a pointer to a local object is passed to C and then stored beyond the call.

{% mermaid() %}
flowchart TD
    A[alloca / local stack object] --> B[Take address]
    B --> C[Pass to extern C]
    C --> D{Does C store it?}
    D -->|Yes| E[Dangling after return]
    D -->|No| F[Depends on call-duration use]
{% end %}

## Summary

`RustFfiAuditor` maps Rust ownership and borrowing concepts onto IR-level call and pointer patterns. It should be described as static protocol recovery and checking, with accuracy bounded by available IR information.

## Source breakdown: Rust rules and universal FFI rules are intentionally separated

`RustFfiAuditor.auditFunction` around `src/pass/analysis/rust_ffi_auditor.zig:120` splits rules into Rust-specific and universal FFI boundary checks.

```zig
fn auditFunction(self: *RustFfiAuditor, func: c.LLVMValueRef, ctx: *PassContext, diag: *DiagnosticWriter) !void {
    const func_name = getFunctionName(func);
    const is_rust = ctx.isRustModule();

    if (is_rust) {
        if (ctx.rust_into_raw_set.contains(@intFromPtr(c.LLVMGetValueName(func)))) {
            if (ctx.rust_from_raw_set.count() == 0) {
                try self.addFinding(.{
                    .issue_type = .unpaired_into_raw,
                    .severity = .high,
                    .confidence = 0.75,
                    .reason = "into_raw() called but no matching from_raw() in module",
                    .location = Location.init(func_name),
                });
            }
        }

        try self.detectAsPtrEscape(func, ctx, diag);
        try self.detectCrossLangMismatch(func, ctx, diag);
        try self.detectOwnershipTransferViolations(func, ctx, diag);
        try self.detectAsPtrDangling(func, ctx, diag);
    }

    try self.detectUnsafeFfiCalls(func);
    try self.detectStackEscapeToFFI(func, ctx, diag);
}
```

This split matters. `as_ptr`, `into_raw`, and `from_raw` are Rust semantics. Forcing those rules onto C or Zig modules would create noise. By contrast, stack-address escape and unsafe FFI calls are cross-language risks and should run on every module.

## How it works: language gating is precision, not conservatism

At LLVM level many values become pointers, but the source-level semantics still differ. OmniScope uses `ctx.isRustModule()` to match rules with semantic origin:

```text
Rust module
  -> ownership transfer / borrow escape / from_raw pairing
Any module
  -> FFI boundary / stack escape / unsafe call surface
```

That is also why `PassContext` stores `module_language`, and why the Pipeline calls `ctx.initModuleLanguage(self.module)` before any pass runs. Language detection is not a UI label; it is a rule selector.

## Evidence chain: a finding is not the final report

`RustFfiAuditor` first produces `RustFfiFinding` records with `func_name`, `issue_type`, `severity`, `confidence`, `reason`, and `location`. That is an internal semantic layer, not the final output. Only later does the unified issue path convert it into the shared `Issue` schema.

That two-stage structure matters because the auditor can keep Rust-specific meaning such as unpaired `into_raw`, borrow escape, or stack escape, while the output layer preserves a consistent schema shared with the rest of OmniScope.

## One concrete rule: unpaired `into_raw`

The problem with `Box::into_raw` is not "raw pointers are dangerous" in the abstract. It is that Rust intentionally gives up automatic drop and transfers release responsibility into an external protocol. A safe recovery path requires a matching `from_raw` or equivalent reclamation.

That is why the code checks for module-level pairing: if `into_raw` semantics exist but no `from_raw` semantics exist anywhere in the module, OmniScope emits `unpaired_into_raw`. It is a protocol-completeness check, not a function blacklist.

The rule still has limits: if the release path lives in another shared library, another module, or a wrapper function, a static module-local check must lower confidence. That is why the code uses `0.75` instead of `1.0`.
