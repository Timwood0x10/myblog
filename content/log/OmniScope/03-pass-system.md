+++
title = "Inside the Pass System: Dependency Ordering, Shared Context, and Graceful Degradation"
date = 2026-05-21
description = "OmniScope organizes analysis logic as passes rather than one large procedure. The relevant implementation questions are how passes share facts, how execution order is resolved, and how the system behaves when one pass fails."
weight = 18
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# Inside the Pass System: Dependency Ordering, Shared Context, and Graceful Degradation

OmniScope organizes analysis logic as passes rather than one large procedure. The relevant implementation questions are how passes share facts, how execution order is resolved, and how the system behaves when one pass fails.

## Start with the problem: static analysis is not linear

Cross-language findings rarely come from one rule alone. A call graph pass finds boundaries, a lifetime pass contributes pointer facts, DangerSurfacePass narrows the relevant objects, and ownership or memory passes then decide what is worth reporting. The key is not just having many passes; it is the dependencies and fact exchange between them.

Without orchestration, a pass can run before its inputs exist. Without shared context, every pass rescans the IR. Without graceful degradation, one unfamiliar IR pattern can stop an entire audit run. OmniScope’s pass system addresses those three problems.

## OmniScope’s entry point: PassManager orders work, PassContext carries facts

`PassManager` registers, sorts, and executes passes. `PassContext` carries facts across them. This lets call relationships, MemoryGraph state, danger surfaces, and issues move through one analysis context instead of being trapped inside individual rules.

## What PassManager owns

`PassManager` is defined at `src/pass/manager.zig:23`. It stores registered passes, a name-to-index map, resolved execution order, and cached execution names. Registration starts at `src/pass/manager.zig:61`.

{% mermaid() %}
flowchart TD
    A[registerPass] --> B[passes ArrayList]
    A --> C[pass_map]
    B --> D[resolveDependencies]
    C --> D
    D --> E[resolved_order]
    E --> F[run]
{% end %}

This keeps scheduling separate from the CLI and from each individual pass.

## Dependency resolution uses Kahn topological sorting

The dependency resolver builds an adjacency list and in-degree table. Passes with zero in-degree enter the queue. Each popped node reduces the in-degree of its successors. If the final result contains fewer nodes than the registered pass count, a cycle is reported.

{% mermaid() %}
flowchart TD
    A[Passes + dependencies] --> B[Build adjacency / in_degree]
    B --> C[Queue zero in-degree nodes]
    C --> D[Pop node]
    D --> E[Reduce successor in-degree]
    E --> F{Successor reaches zero?}
    F -->|Yes| C
    F -->|No| G[Continue]
    G --> H{All passes resolved?}
    H -->|Yes| I[resolved_order]
    H -->|No| J[CycleDetected]
{% end %}

This matters because later passes may consume facts produced by earlier passes: risk-path checks need cross-language edges and memory facts; ownership checks need allocation and call information.

## Graceful degradation is deliberate

The run loop starts at `src/pass/manager.zig:193`. If a pass fails, the manager logs a warning, increments a failure counter, and continues executing later passes.

{% mermaid() %}
flowchart TD
    A[Run pass] --> B{run_fn succeeds?}
    B -->|Yes| C[Record timing]
    B -->|No| D[warn + pass_failures++]
    C --> E{More passes?}
    D --> E
    E -->|Yes| A
    E -->|No| F[Finish analysis]
{% end %}

This is useful for real-world IR, which may come from different compilers, optimization levels, or link configurations. A failure in one analysis stage should not necessarily discard unrelated findings.

## PassContext is the fact bus

`PassContext` is defined at `src/pass/pass.zig:192`. It is the shared state through which passes exchange information. CallGraphPass may write `cross_lang_edges`; PtrLifetimePass may write `memory_graph`; DangerSurfacePass may write relevance sets; issue-producing passes read those facts.

{% mermaid() %}
flowchart LR
    A[CallGraphPass] -->|writes| X[PassContext.cross_lang_edges]
    B[PtrLifetimePass] -->|writes| Y[PassContext.memory_graph]
    C[DangerSurfacePass] -->|reads X/Y, writes| Z[relevant sets]
    D[FFI / Ownership / Memory passes] -->|read Z/Y| E[Issue]
{% end %}

## DiagnosticWriter and structured issues

Passes receive both `PassContext` and `DiagnosticWriter`. `DiagnosticWriter` handles logs and diagnostics. Structured findings are added through `ctx.addIssue`, whose entry point is at `src/pass/pass.zig:458`.

{% mermaid() %}
flowchart TD
    A[Pass detects finding] --> B{Diagnostic only?}
    B -->|Yes| C[DiagnosticWriter]
    B -->|No| D[Issue.init / initWithReason]
    D --> E[ctx.addIssue]
    E --> F[DataFlowGraph issues]
    F --> G[Pipeline.getIssues]
{% end %}

## Summary

The pass system provides registration, dependency ordering, shared state, graceful degradation, and structured issue collection. The later MemoryGraph, Zone, and Registry mechanisms rely on this shared execution model.

## Source breakdown: dependency ordering is a runtime constraint

`PassManager.resolveDependencies` uses Kahn’s algorithm to topologically sort passes. The implementation in `src/pass/manager.zig:86` to `src/pass/manager.zig:180` builds the graph from `pass.deps`, tracks in-degrees, and computes `resolved_order`.

```zig
for (0..num_passes) |i| {
    const pass = self.passes.items[i];
    for (pass.deps) |dep_name| {
        const dep_idx = self.pass_map.get(dep_name) orelse {
            return error.MissingDependency;
        };
        try adjacency.items[dep_idx].append(self.allocator, i);
        in_degree[i] += 1;
    }
}

while (queue.items.len > 0) {
    const node = queue.swapRemove(0);
    try result.append(self.allocator, node);

    for (adjacency.items[node].items) |neighbor| {
        in_degree[neighbor] -= 1;
        if (in_degree[neighbor] == 0) {
            try queue.append(self.allocator, neighbor);
        }
    }
}
```

Two design signals stand out. First, a missing dependency returns `MissingDependency` immediately, because a wrong pass order does not just break configuration — it can produce wrong facts. Second, the queue uses `swapRemove(0)` instead of `orderedRemove(0)` to avoid O(N) cost. The exact order of equal-ready passes does not matter as long as dependency constraints are satisfied.

## Graceful degradation: one failed pass must not blind the tool

`PassManager.run` executes each pass independently, logs failures, and keeps going.

```zig
for (self.resolved_order.?) |idx| {
    const pass_name = self.passes.items[idx].name;
    const t0 = std.time.nanoTimestamp();
    self.passes.items[idx].run_fn(ctx, diag) catch |err| {
        diag.warn("PassManager: pass '{s}' failed with error: {any}, degrading gracefully", .{ pass_name, err });
        pass_failures += 1;
    };
    const elapsed_ns = @max(@as(i128, 0), std.time.nanoTimestamp() - t0);
    const elapsed_ms = @as(f64, @floatFromInt(elapsed_ns)) / 1_000_000.0;
    if (elapsed_ms > 10) {
        diag.info("[PERF] Pass '{s}: {d} ms", .{ pass_name, @as(u32, @intFromFloat(elapsed_ms)) });
    }
}
```

This is not just error swallowing. Real-world IR is messy: incomplete linking, different optimization levels, missing debug info, and compiler differences can make one pass hit an unexpected pattern. OmniScope preserves independent evidence instead of letting one failure zero out the whole run.

## `addIssue` is a normalization layer

Passes do not print findings directly. They create an `Issue` and send it through `ctx.addIssue` in `src/pass/pass.zig:458`. That function deduplicates, enriches classification, handles ownership, and then forwards the result to the data flow graph or issue store.

```text
pass-local finding
  -> Issue.init / Issue.initWithReason
  -> PassContext.addIssue
  -> dedup / confidence / classification / ownership handling
  -> DataFlowGraph issue store
  -> output formatter
```

That is why `Issue` carries `confidence`, `reason`, `ffi_boundary`, `trace`, and `classification`. The pass only needs to say what it found; the context decides how that finding enters the global reporting system.

## How it works: passes produce evidence, not reports

The pass system defines a hard boundary: passes create facts and issues, but do not decide final presentation. That gives OmniScope a few important properties:

- The same finding can be rendered as text, JSON, or SARIF.
- Output schemas can evolve without changing every analysis pass.
- `DangerSurface` can populate relevance sets without emitting findings directly.
- Rust FFI, memory safety, and return-check passes can all share the same fact layer.

That is a better fit for a source-level audit tool than printing findings immediately, because what matters is not the individual rule but whether rules can exchange evidence.
