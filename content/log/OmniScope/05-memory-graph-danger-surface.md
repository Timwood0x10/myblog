+++
title = "MemoryGraph and DangerSurface: From Pointer Facts to Risk Paths"
date = 2026-05-21
description = "Cross-language memory analysis should not only ask whether `malloc` or `free` exists. It should ask whether a pointer crosses FFI, comes from an unsafe region, or propagates through aliases. OmniScope uses `MemoryGraph` and `DangerSurfacePass` to connect these facts."
weight = 20
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# MemoryGraph and DangerSurface: From Pointer Facts to Risk Paths

Cross-language memory analysis should not only ask whether `malloc` or `free` exists. It should ask whether a pointer crosses FFI, comes from an unsafe region, or propagates through aliases. OmniScope uses `MemoryGraph` and `DangerSurfacePass` to connect these facts.

## Start with the problem: memory risk lives on paths, not names

A pointer can start as Rust `Box::into_raw`, become `void*` through a bitcast, pass into C, get stored in a global structure, and later be released by another function. Each step can look like an ordinary IR event. The risk only appears when the path is connected.

This is where simple rule scanning loses information: it can see calls but not pointer families, allocators but not aliases, FFI boundaries but not which pointer actually crossed them.

## OmniScope’s entry point: build MemoryGraph, then narrow with DangerSurface

`MemoryGraph` stores allocations, frees, call arguments, returns, and aliases in one graph. `DangerSurfacePass` starts from FFI/unsafe boundaries and marks the pointers and functions worth deeper analysis. Reports then follow risky paths rather than isolated APIs.

## Role of MemoryGraph

`MemoryGraph` is defined at `src/semantics/memory_graph.zig:160`. It stores memory-related facts: allocations, frees, call arguments, call returns, alias relations, zones, and language sources.

{% mermaid() %}
flowchart TD
    A[trackAlloc] --> M[MemoryGraph]
    B[trackFree] --> M
    C[trackCallArg] --> M
    D[trackCallRet] --> M
    E[alias relation] --> M
    F[Zone / Language] --> M
    M --> G[isOnDangerPath]
{% end %}

The graph does not attempt to model every possible program path. It answers a narrower question: is there enough evidence that this pointer is relevant to an FFI/unsafe risk path?

## Risk-path classification

`MemoryGraph.isOnDangerPath` is implemented around `src/semantics/memory_graph.zig:892`. It may return categories such as `ffi_arg`, `ffi_ret`, and `unsafe_alloc`. `PassContext.isOnDangerPathFull` at `src/pass/pass.zig:866` provides a shared entry point for other passes.

{% mermaid() %}
flowchart LR
    A[ptr_val] --> B[PassContext.isOnDangerPathFull]
    B --> C[MemoryGraph.isOnDangerPath]
    C --> D{DangerPathKind}
    D -->|ffi_arg| E[Pointer passed as FFI argument]
    D -->|ffi_ret| F[Pointer returned from FFI]
    D -->|unsafe_alloc| G[Allocation in unsafe region]
    E --> H[Prioritize analysis]
    F --> H
    G --> H
{% end %}

A shared entry point keeps later passes from inventing inconsistent risk definitions.

## How DangerSurfacePass marks relevant objects

`DangerSurfacePass` starts at `src/pass/analysis/danger_surface.zig:37`. It consumes `cross_lang_edges` and `memory_graph`, then updates `danger_surface_relevant`, `ffi_auto_relevant`, and `relevant_functions`.

{% mermaid() %}
sequenceDiagram
    participant CG as CrossLangEdges
    participant MG as MemoryGraph
    participant DS as DangerSurfacePass
    participant Ctx as PassContext

    DS->>CG: Read FFI callees
    DS->>MG: Inspect call args / returns
    DS->>Ctx: markRelevantAlloc(ptr)
    DS->>Ctx: markFfiRelevant(ptr)
    DS->>DS: traceAliasClosure(ptr)
    DS->>Ctx: markRelevantFunction(func)
{% end %}

Two implementation choices are visible in the source: known FFI arguments and returns can be marked directly, while MemoryGraph nodes already on a risk path can be expanded through alias closure.

## Why alias closure matters

`traceAliasClosure` is at `src/pass/analysis/danger_surface.zig:144`. In LLVM IR, one memory object may appear through several SSA values after bitcasts, loads, stores, parameters, and returns. Marking only the original pointer may miss later uses.

{% mermaid() %}
flowchart TD
    A[ptr0: FFI relevant] --> B[alias set]
    B --> C[ptr1]
    B --> D[ptr2]
    C --> E[markRelevantAlloc]
    D --> E
    E --> F[Recursive alias tracing]
{% end %}

This is not a full alias analysis. It is a focused propagation step for FFI-related pointer families.

## From risk paths to prioritized reporting

Later passes can use `isOnDangerPathFull` or relevance sets to filter findings. A local C allocation/free pair may be lower priority, while a pointer crossing FFI through arguments, returns, or callbacks may require review.

{% mermaid() %}
flowchart LR
    A[Potential memory issue] --> B{On risk path?}
    B -->|No| C[Filter / lower priority / local issue]
    B -->|Yes| D[FFI-relevant issue]
    D --> E[Higher review priority]
{% end %}

## Summary

MemoryGraph stores pointer facts. DangerSurfacePass turns those facts into relevance sets tied to FFI/unsafe paths. This is the layer that connects low-level IR events with higher-level ownership and lifetime checks.

## Source breakdown: `isOnDangerPath` is the central question

`MemoryGraph.isOnDangerPath` lives around `src/semantics/memory_graph.zig:892`. The source comment calls it the ONE question that decides whether a pointer matters. It checks call edges first, allocation-node facts second, and alias closure last.

```zig
pub fn isOnDangerPath(
    graph: *MemoryGraph,
    ptr_val: u64,
    ffi_boundaries: []const MemoryGraph.DangerSurface,
    visited: *std.AutoHashMap(u64, void),
    ffi_set: ?*const std.StringHashMap(void),
) DangerPathKind {
    if (visited.contains(ptr_val)) return .none;
    visited.put(ptr_val, {}) catch return .none;

    const arg_indices = graph.getCallArgsForPtr(ptr_val);
    for (arg_indices) |idx| {
        const arg_edge = &graph.call_args.items[idx];
        if (set.contains(arg_edge.callee_name)) {
            return .ffi_arg;
        }
    }

    const ret_indices = graph.getCallRetsForPtr(ptr_val);
    for (ret_indices) |idx| {
        const ret_edge = &graph.call_rets.items[idx];
        if (set.contains(ret_edge.callee_name)) {
            return .ffi_ret;
        }
    }

    const node = graph.nodes.get(ptr_val) orelse return .none;
    if (node.zone == .unsafe) return .unsafe_alloc;
    if (node.freed and node.alloc_lang != node.free_lang.?) return .cross_lang_lifecycle;
    // alias closure follows...
}
```

The order matters. Call edges must come before allocation nodes because many FFI arguments have no allocation record: they may come from function parameters, external returns, or sources that earlier passes could not recover. Requiring an `AllocNode` first would miss the most important boundary-flow cases.

## Source breakdown: DangerSurfacePass is a pruning pass

`DangerSurfacePass.run` in `src/pass/analysis/danger_surface.zig:37` takes `ctx.getCrossLangEdges()`, extracts FFI boundaries, and marks relevant arguments, returns, functions, and aliases.

```zig
for (ffis) |surface| {
    const arg_indices = mg.getCallArgsForCallee(surface.callee_name);
    for (arg_indices) |arg_idx| {
        const arg_ptr_val = mg.call_args.items[arg_idx].arg_ptr;
        try ctx.markRelevantAlloc(arg_ptr_val);
        try ctx.markFfiRelevant(arg_ptr_val);
        ctx.markFunctionFromInst(mg.call_args.items[arg_idx].caller_inst);
        try traceAliasClosure(mg, arg_ptr_val, ctx, diag, &visited);
    }

    const ret_indices = mg.getCallRetsFromCallee(surface.callee_name);
    for (ret_indices) |ret_idx| {
        const ret_ptr_val = mg.call_rets.items[ret_idx].ret_ptr;
        try ctx.markRelevantAlloc(ret_ptr_val);
        try ctx.markFfiRelevant(ret_ptr_val);
        ctx.markFunctionFromInst(mg.call_rets.items[ret_idx].caller_inst);
        try traceAliasClosure(mg, ret_ptr_val, ctx, diag, &visited);
    }
}
```

It does not emit issues directly. Its output is a set of relevance maps: `danger_surface_relevant`, `ffi_auto_relevant`, and `relevant_functions`. Later passes use those maps to decide whether to run strict checks or filter local noise.

## How it works: build the fact graph first, then define the danger surface

Instead of reporting immediately on malloc/free-like events, OmniScope records allocations, frees, call arguments, call returns, and aliases in `MemoryGraph`. Then it asks which graph nodes are close to FFI or unsafe boundaries.

That gives three benefits: rules reuse one pointer-fact layer, future danger-path kinds can be added centrally, and reports can distinguish local-only issues from boundary-relevant issues. The cost is also clear: the quality of `MemoryGraph` bounds the quality of every downstream pass.
