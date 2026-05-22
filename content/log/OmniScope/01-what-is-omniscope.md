+++
title = "Why OmniScope Analyzes Cross-Language Safety at the LLVM IR Layer"
date = 2026-05-21
description = "Rust ownership, Zig allocators, Go GC, and C++ RAII are language-level safety models. Across FFI, those models are lowered into ABI-level facts: functions, pointers, integers, layouts, and calling conventions. OmniScope works at this layer because many cross-language issues are difficult to cover from a single language AST alone."
weight = 16
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# Why OmniScope Analyzes Cross-Language Safety at the LLVM IR Layer

Rust ownership, Zig allocators, Go GC, and C++ RAII are language-level safety models. Across FFI, those models are lowered into ABI-level facts: functions, pointers, integers, layouts, and calling conventions. OmniScope works at this layer because many cross-language issues are difficult to cover from a single language AST alone.

## Start with the problem: language guarantees stop at the boundary

Inside one language, many guarantees come from the compiler or runtime: Rust tracks ownership, Go runs a GC, Zig exposes allocators explicitly, and C++ relies on RAII. Across FFI, those guarantees do not travel as-is. What remains at the boundary is usually a symbol, a few raw pointers, and a calling convention.

That creates the audit problem: the risky part is often a broken protocol, not a single dangerous API. After Rust turns a `Box` into a raw pointer, does C store it? Who releases it? Is the same allocator family used? Looking at only one side often cannot answer the full question.

## Where common approaches fall short

Single-language AST tools understand their own syntax but cannot see the full protocol on the other side. Dangerous-function lists can find `free` or `memcpy`, but they do not know where a pointer came from or where it flows. A call graph can show an edge, but not whether that edge carries ownership, a borrow, or ordinary data.

OmniScope’s choice follows from that gap: move down to LLVM IR, the layer where many languages meet, then reconstruct part of the missing semantics from symbols, calls, pointer flow, allocation/free events, and FFI boundaries.

## The issue is not `free`; it is the lost deallocation protocol

A common Rust/C boundary pattern is: Rust exposes a pointer through `Box::into_raw`, then C stores or releases that pointer. In Rust, `into_raw` is an explicit ownership transfer. In C, `free(ptr)` is an ordinary deallocation. The problem is that no single compiler verifies the full protocol across both sides.

{% mermaid() %}
sequenceDiagram
    participant R as Rust ownership model
    participant ABI as C ABI / LLVM IR
    participant C as C manual memory
    R->>ABI: Box::into_raw becomes a raw pointer
    ABI->>C: extern C argument passing
    C->>C: store / free / callback use
    C-->>R: Rust cannot verify the C-side protocol
{% end %}

At the IR layer, source syntax is gone, but external declarations, call/invoke instructions, allocas, loads/stores, bitcasts, symbol names, and some debug information may remain. The analyzer tries to recover enough ownership and lifetime semantics from these facts.

## What OmniScope actually analyzes

OmniScope’s entry point consumes LLVM IR files such as `.ll` and `.bc`, not source directories. Argument parsing starts at `src/main.zig:73`, the main entry is `src/main.zig:567`, and single-module analysis is driven by `runModulePipeline` at `src/main.zig:171`.

{% mermaid() %}
flowchart TD
    A[Source languages: Rust / C / Zig / Go / C++] --> B[Compiler emits LLVM IR]
    B --> C[IRLoader obtains ModuleRef]
    C --> D[Pipeline.setModule]
    D --> E[PassContext.module]
    E --> F[Passes iterate functions, blocks, instructions]
{% end %}

This also defines the limits. OmniScope can inspect facts that remain in IR and can use symbols and debug information when available. Heavy optimization, missing symbols, or wrapper-heavy code may reduce the amount of recoverable semantics.

## It is not a dangerous-function blacklist

`src/registry/semantic_registry.zig:3` describes the registry as a function-semantics knowledge base for FFI boundary analysis, not a simple blacklist. `src/registry/semantic_registry.zig:8` also notes that the same function may carry different risk depending on context.

For example:

- A local C `free` may be a normal lifetime endpoint.
- A Rust `Box` pointer released by C may indicate allocator mismatch or ownership protocol breakage.
- Rust `as_ptr` used locally may be benign, while passing it to FFI and storing it may create a dangling pointer.

{% mermaid() %}
flowchart LR
    A[Function call] --> B{Crosses language boundary?}
    B -->|No| C[Local semantics]
    B -->|Yes| D[FFI semantics]
    C --> E[May be lower priority]
    D --> F[Check ownership / lifetime / allocator context]
{% end %}

## Main source-level pillars

The implementation is organized around shared analysis structures:

- `PassContext`: shared state for passes, defined at `src/pass/pass.zig:192`.
- `cross_lang_edges`: cross-language call edges.
- `MemoryGraph`: memory objects, frees, call arguments, returns, and alias relations.
- `ZoneKind`: `safe`, `unsafe`, `ffi`, `runtime_internal`, and `unknown`, defined at `src/semantics/zone_classifier.zig:24`.
- `SemanticRegistry`: layered function semantics, looked up through `src/registry/semantic_registry.zig:90`.

{% mermaid() %}
flowchart TB
    A[LLVM IR facts] --> B[PassContext]
    B --> C[CrossLangEdge]
    B --> D[MemoryGraph]
    B --> E[Zone cache]
    B --> F[Registry cache]
    C --> G[DangerSurface]
    D --> G
    E --> G
    F --> G
    G --> H[Issue]
{% end %}

## Practical limits

OmniScope performs static recovery and risk classification; it is not a runtime proof system. It depends on:

- Enough call and symbol information remaining in IR.
- Recognizable cross-language declarations and call sites.
- MemoryGraph coverage for relevant pointer flows.
- Zone and Registry rules that cover the project’s FFI patterns.

A careful description should avoid absolute detection claims. A more accurate framing is: OmniScope reconstructs queryable facts about ownership, lifetime, and allocator protocols at language boundaries, then uses risk-path filtering to prioritize findings.

## Source-level view: OmniScope analyzes facts, not text

From the code, OmniScope does not treat the source language as the primary abstraction. `Pipeline.run` builds a `PassContext` that holds the module, fact store, query engine, data flow graph, memory graph, cross-language edges, registry cache, and zone cache. Source code is first reduced to LLVM IR, then lifted back into analysis facts.

The core initialization lives around `src/pipeline/pipeline.zig:66`:

```zig
var ctx = PassContext{
    .allocator = self.allocator,
    .module = self.module,
    .fact_store = self.fact_store,
    .query_engine = self.query_engine,
    .data_flow_graph = &self.data_flow_graph,
    .cross_lang_edges = std.ArrayList(CrossLangEdge).empty,
    .global_alloc_tracker = GlobalAllocTracker.init(self.allocator),
    .memory_graph = try MemoryGraph.init(self.allocator),
    .danger_surface_relevant = std.AutoHashMap(u64, void).init(self.allocator),
    .ffi_auto_relevant = std.AutoHashMap(u64, void).init(self.allocator),
    .relevant_functions = std.AutoHashMap(u64, void).init(self.allocator),
    .CallSiteIndex = CallSiteIndex.init(self.allocator),
};
```

That snippet shows the real design center: OmniScope does not let each pass rescan IR and rediscover the same facts. It establishes a shared fact space first. `cross_lang_edges` models language boundaries, `memory_graph` models pointer facts, `danger_surface_relevant` narrows the analysis to risk paths, and `CallSiteIndex` turns repeated module scans into indexed lookups.

## How it works: recover enough semantics after the language model is gone

LLVM IR does not preserve Rust’s borrow checker, Zig’s allocator types, or C++ RAII as language constructs. OmniScope does not pretend otherwise. Instead, it uses a layered recovery model:

```text
IR facts
  -> function / call / load / store / alloca / return / bitcast
name and debug hints
  -> Rust mangling / allocator names / extern patterns / registry patterns
semantic facts
  -> zone / function semantics / cross-lang edge / memory graph node
audit facts
  -> danger path / ownership mismatch / borrow escape / issue
```

This is a pragmatic static analysis design. It does not aim for formal proof; it aims to extract high-value signals reliably from real-world IR. That is why the code keeps `confidence`, `reason`, and `classification` fields. They are not UI decoration. They acknowledge that analysis facts have different strengths.

## The line between OmniScope and blacklist scanners

A blacklist scanner can only say "this dangerous API appears". OmniScope asks a narrower question: does this pointer cross an FFI boundary, come from unsafe code, violate ownership across languages, or flow through alias paths to a boundary?

That is why `MemoryGraph.isOnDangerPath` becomes the core question in later articles. It changes the unit of analysis from "dangerous function present" to "pointer on a dangerous path". That is the fundamental difference between OmniScope and a rule list.
