+++
title = "Zone Classification and Semantic Registry: Avoiding Blacklist-Style Reporting"
date = 2026-05-21
description = "A static analyzer without semantic layers can easily become a dangerous-function list. OmniScope separates region classification from function semantics before deciding whether a path should be analyzed in depth."
weight = 19
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# Zone Classification and Semantic Registry: Avoiding Blacklist-Style Reporting

A static analyzer without semantic layers can easily become a dangerous-function list. OmniScope separates region classification from function semantics before deciding whether a path should be analyzed in depth.

## Start with the problem: the same function name means different things in context

Reporting whenever `free`, `strcpy`, or `dlopen` appears is simple, but it becomes noisy in cross-language auditing. An allocator inside runtime glue may be expected; the same allocator in a user-written FFI wrapper may indicate ownership crossing a language boundary.

The question is not only "is this function dangerous?" It is also: which code region is it in, runtime/internal or user boundary code? Does the function represent allocation, deallocation, borrow escape, or ordinary library behavior in an FFI context?

## OmniScope’s entry point: Zone answers where, Registry answers what

`ZoneClassifier` classifies the region first. `SemanticRegistry` then explains function meaning in cross-language context. Together they provide context to later danger-path checks: the same call can receive different priority depending on its zone and semantic kind.

## ZoneKind classifies code by risk region

`ZoneKind` is defined at `src/semantics/zone_classifier.zig:24`. It includes `safe`, `unsafe`, `ffi`, `runtime_internal`, and `unknown`. The file-level comment states the operating principle: focus where language guarantees stop.

{% mermaid() %}
flowchart TD
    A[Function / Instruction / Debug path] --> B[Zone Classifier]
    B --> C[safe: language guarantees likely apply]
    B --> D[unsafe: explicit escape]
    B --> E[ffi: cross-language boundary]
    B --> F[runtime_internal: stdlib/runtime]
    B --> G[unknown: conservative handling]
{% end %}

This model is not a proof that safe zones are bug-free. It is a prioritization layer. For an FFI-focused analyzer, runtime glue or container internals should usually not have the same weight as user-written unsafe wrappers.

## Multi-language escape triggers

`EscapeTrigger` is defined at `src/semantics/zone_classifier.zig:45`. It represents cross-language escape points across ecosystems: Rust unsafe/extern/raw pointers, Zig pointer casts and C imports, Go cgo and `unsafe.Pointer`, and C++ extern C, reinterpret casts, and manual memory.

{% mermaid() %}
flowchart LR
    A[Rust unsafe / extern C] --> Z[EscapeTrigger]
    B[Zig @ptrCast / @cImport] --> Z
    C[Go cgo / unsafe.Pointer] --> Z
    D[C++ reinterpret_cast / malloc] --> Z
    Z --> E[ZoneKind unsafe or ffi]
{% end %}

This gives the implementation a common vocabulary for multiple language-specific risk boundaries.

## Function-level and LLVM-level classification

The classifier includes both name-based and LLVM-function-based entry points:

- `src/semantics/zone_classifier.zig:347` classifies by function name.
- `src/semantics/zone_classifier.zig:394` classifies LLVM functions using declarations, intrinsics, debug information, and path data when available.

{% mermaid() %}
flowchart TD
    A[LLVMValueRef function] --> B{External declaration?}
    B -->|Yes| C[May be ffi]
    B -->|No| D[Name-based classification]
    D --> E[Path/debug-info classification]
    E --> F[ZoneKind]
{% end %}

These rules are heuristic. Symbol names and debug information quality can affect classification, so Zone should be described as a risk-prioritization mechanism rather than a formal proof.

## Semantic Registry describes function meaning in FFI context

`SemanticRegistry` is defined at `src/registry/semantic_registry.zig:48`; lookup starts at `src/registry/semantic_registry.zig:90`. The registry is layered by ecosystem: C standard library, Rust ownership patterns, Go cgo, Zig, C++, JNI, Python C API, POSIX, and dynamic loading.

{% mermaid() %}
flowchart TD
    A[func_name] --> B[SemanticRegistry.lookup]
    B --> C[Layer1: C stdlib high-risk]
    B --> D[Layer2: Rust ownership]
    B --> E[Layer3: Go cgo]
    B --> F[Layer5: Zig stdlib]
    B --> G[Layer6: C++ stdlib]
    B --> H[JNI / Python C API / POSIX]
    C --> I[FunctionSemantics]
    D --> I
    E --> I
    F --> I
    G --> I
    H --> I
{% end %}

The registry helps interpret calls in context. `Box::into_raw` is not a vulnerability by itself; it changes the ownership protocol. `strcpy` in local C code and `strcpy` at a Rust-to-C boundary may require different review priorities.

## Zone + Registry + Danger Path

Zone and Registry should not produce most findings directly. A more controlled path is: classify the region, look up function semantics, ask whether the pointer or function is on a relevant risk path, then produce an issue if warranted.

{% mermaid() %}
flowchart LR
    A[Call / Function] --> B[Zone]
    A --> C[Registry]
    B --> D[Region risk]
    C --> E[Function semantics]
    D --> F[Danger path]
    E --> F
    F --> G{Report?}
    G -->|Yes| H[Issue]
    G -->|No| I[Filter or lower priority]
{% end %}

## Summary

OmniScope avoids pure blacklist reporting by splitting a finding into three questions: where is the code located, what does the function mean at an FFI boundary, and does the pointer or function participate in a relevant risk path?

## Source breakdown: ZoneClassifier is a priority decision tree

The latter half of `classifyFunction` lives around `src/semantics/zone_classifier.zig:640`. It is not a simple lookup table. The order is C++ unsafe patterns, C++ safe patterns, C escape patterns, extern C, and only then the `SemanticRegistry` fallback.

```zig
for (CPP_ESCAPE_PATTERNS) |pattern| {
    if (std.mem.indexOf(u8, func_name, pattern) != null) {
        return .unsafe;
    }
}

for (CPP_SAFE_PATTERNS) |pattern| {
    if (std.mem.indexOf(u8, func_name, pattern) != null) {
        return .safe;
    }
}

if (SemanticRegistry.lookup(func_name)) |sem| {
    switch (sem.kind) {
        .allocator,
        .deallocator,
        .rust_ownership,
        .borrow_escaped,
        .zig_allocator,
        .cpp_allocator,
        => return .ffi,
        else => return .ffi,
    }
}
```

The important part is ordering. One function name can match multiple weak signals, such as a runtime helper that also contains allocator semantics. Without priority, Zone classification becomes noisy. OmniScope lets strong context decide the zone first and weak semantics fill in the explanation later.

## Source breakdown: SemanticRegistry is a layered semantic library

`SemanticRegistry.lookup` in `src/registry/semantic_registry.zig:90` walks layer1 through layer6, then JNI, Python C API, file I/O, network I/O, signal, thread, process, dynamic loading, and static buffer groups.

```zig
pub fn lookup(func_name: []const u8) ?FunctionSemantics {
    for (layer1) |sem| {
        if (matchesPattern(func_name, sem.pattern, sem.match_type)) return sem;
    }
    for (layer2) |sem| {
        if (matchesPattern(func_name, sem.pattern, sem.match_type)) return sem;
    }
    // ... ecosystem-specific layers ...
    for (dynamic_loading) |sem| {
        if (matchesPattern(func_name, sem.pattern, sem.match_type)) return sem;
    }
    return null;
}

fn matchesPattern(func_name: []const u8, pattern: []const u8, match_type: MatchType) bool {
    return switch (match_type) {
        .exact => std.mem.eql(u8, func_name, pattern),
        .contains => std.mem.indexOf(u8, func_name, pattern) != null,
        .suffix => std.mem.endsWith(u8, func_name, pattern),
    };
}
```

This is more expressive than a dangerous-function list. The registry stores semantic source and match strength. `exact` evidence is stronger than `contains`, and ecosystem-specific meaning is different from a generic libc helper. That difference is what later turns into confidence and reason.

## How it works: Zone reduces noise, Registry explains meaning

Keeping Zone and Registry separate avoids two common mistakes:

- Zone alone tells you where code lives, but not what the function means.
- Registry alone tells you a function looks like an allocator or deallocator, but not whether it sits on a local path or a cross-language path.

OmniScope lets Zone answer "where", Registry answer "what", and MemoryGraph/DangerSurface answer "does it flow into a dangerous path". Once those questions are separated, false-positive control becomes actionable.
