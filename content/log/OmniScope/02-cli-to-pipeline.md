+++
title = "Lifecycle of an Analysis Run: CLI, IRLoader, Pipeline, and Output"
date = 2026-05-21
description = "This article follows one OmniScope run from command-line arguments to structured findings. The important part is how the code turns user input into a `PassContext`, runs analysis passes, and emits reports."
weight = 17
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# Lifecycle of an Analysis Run: CLI, IRLoader, Pipeline, and Output

This article follows one OmniScope run from command-line arguments to structured findings. The important part is how the code turns user input into a `PassContext`, runs analysis passes, and emits reports.

## Start with the problem: an analyzer run is not one rule execution

A cross-language audit begins at the CLI, but the real job is a sequence: load `.ll` or `.bc`, create an LLVM module, identify languages and boundaries, run multiple passes, collect shared facts, and emit results for a terminal, CI system, or security platform.

If those steps are mixed together, each rule ends up parsing input, scanning calls, and printing reports on its own. OmniScope separates them into CLI parsing, IR loading, Pipeline orchestration, PassManager execution, and output formatting so the whole run becomes traceable.

## OmniScope’s entry point: Pipeline owns the analysis lifecycle

The CLI describes how the user wants to run. IRLoader turns input into a module. Pipeline is where the module, shared context, passes, indexes, and output path are assembled. Later structures such as `PassContext`, `CallSiteIndex`, `MemoryGraph`, and `GlobalAllocTracker` appear naturally from this lifecycle.

## Config defines the external shape of the run

`Config` is defined at `src/main.zig:24`. It stores input files, output format, output path, visualization flag, user-code focus, FFI-only mode, and stdlib inclusion. Argument parsing starts at `src/main.zig:73`.

{% mermaid() %}
flowchart TD
    A[argv] --> B[parseArgs]
    B --> C[Config]
    C --> D[input_files]
    C --> E[output_format: text/json/sarif]
    C --> F[visualize]
    C --> G[focus_user_code / ffi_only / include_stdlib]
{% end %}

One implementation detail matters: the CLI parses analysis intent, but the exact effect depends on individual pass implementations. For example, some noise-reduction options are instantiated inside specific passes.

## `runModulePipeline` is the analysis loop

`runModulePipeline` is located at `src/main.zig:171`. It initializes the Pipeline, attaches the LLVM module, registers passes, runs static analysis, and collects issues.

{% mermaid() %}
sequenceDiagram
    participant Main as main.zig
    participant Loader as IRLoader
    participant Pipe as Pipeline
    participant PM as PassManager

    Main->>Pipe: Pipeline.init(allocator)
    Loader-->>Main: getModule()
    Main->>Pipe: setModule(module_ref)
    Main->>Pipe: registerAllPasses()
    Main->>Pipe: runStaticAnalysis()
    Pipe->>PM: run(ctx, diag)
    PM-->>Pipe: shared facts and issues
    Pipe-->>Main: PipelineResult
{% end %}

Source anchors:

- `src/main.zig:171` initializes `Pipeline`.
- `src/main.zig:173` obtains the module from `IRLoader`.
- `src/main.zig:177` registers passes.
- `src/main.zig:180` runs static analysis.
- `src/main.zig:184` reads issues from the pipeline.

## `registerAllPasses` reveals the analysis sequence

`registerAllPasses` is at `src/main.zig:153`. It registers CallGraph, TaintPropagation, FFI Boundary, FFI Type Mismatch, FFI Body Check, FFI Unsafe, PtrLifetime, DangerSurface, PointerOwnership, CallbackEscape, RustFfiAuditor, ReturnCheck, MemorySafety, FreeValidation, and BufferOverflow.

{% mermaid() %}
flowchart LR
    A[CallGraph] --> B[FFI Boundary]
    B --> C[Type / Body / Unsafe]
    C --> D[PtrLifetime]
    D --> E[DangerSurface]
    E --> F[PointerOwnership]
    F --> G[CallbackEscape / RustFfiAuditor]
    G --> H[MemorySafety / FreeValidation / BufferOverflow]
{% end %}

The registration order is not necessarily the final execution order. The final order is resolved by `PassManager`, with execution starting at `src/pass/manager.zig:193`.

## `Pipeline.run` builds the analysis context

`Pipeline` is defined at `src/pipeline/pipeline.zig:27`. It stores `FactStore`, `QueryEngine`, `DataFlowGraph`, `PassManager`, and the current module. `Pipeline.run` creates the `PassContext` at `src/pipeline/pipeline.zig:66`.

`PassContext` contains shared state such as:

- facts and query engine;
- data-flow graph;
- value-id map;
- registry and zone caches;
- `cross_lang_edges`;
- `global_alloc_tracker`;
- `memory_graph`;
- `danger_surface_relevant`, `ffi_auto_relevant`, and `relevant_functions`.

{% mermaid() %}
flowchart TB
    subgraph Pipeline.run
        A[Clear DataFlowGraph] --> B[Create PassContext]
        B --> C[Attach module]
        B --> D[Initialize caches]
        B --> E[Initialize MemoryGraph]
        B --> F[Initialize CrossLangEdges]
        F --> G[PassManager.run]
    end
{% end %}

## Output is part of the design

`emitOutput` is at `src/main.zig:207`. It branches into JSON, SARIF, or text output. JSON is produced by `formatIssuesAsJson`; SARIF is produced by `SarifOutput`.

{% mermaid() %}
flowchart LR
    A[Issue list] --> B[emitOutput]
    B --> C[JSON: formatIssuesAsJson]
    B --> D[SARIF: SarifOutput]
    B --> E[Text]
    C --> F[stdout / file]
    D --> F
    E --> G[terminal]
{% end %}

## Summary

An OmniScope run follows a clear data path: CLI creates configuration, IRLoader supplies a module, Pipeline creates shared analysis context, PassManager executes passes, and `emitOutput` formats results.

## Source breakdown: why Pipeline builds CallSiteIndex early

`Pipeline.run` performs one important pre-pass optimization: before any analysis pass runs, it walks the LLVM module and indexes callee names to call sites. The code lives around `src/pipeline/pipeline.zig:130`:

```zig
var func = c.LLVMGetFirstFunction(raw_mod);
while (@intFromPtr(func) != 0) : (func = c.LLVMGetNextFunction(func)) {
    if (c.LLVMIsDeclaration(func) != 0) continue;
    const func_ptr = @as(u64, @intFromPtr(func));

    var bb = c.LLVMGetFirstBasicBlock(func);
    while (@intFromPtr(bb) != 0) : (bb = c.LLVMGetNextBasicBlock(bb)) {
        var inst = c.LLVMGetFirstInstruction(bb);
        while (@intFromPtr(inst) != 0) : (inst = c.LLVMGetNextInstruction(inst)) {
            if (@intFromPtr(c.LLVMIsACallInst(inst)) == 0) continue;
            const called_val = c.LLVMGetCalledValue(inst);
            const called_name = std.mem.span(c.LLVMGetValueName(called_val));
            const inst_ptr = @as(u64, @intFromPtr(inst));
            ctx.CallSiteIndex.addCall(self.allocator, called_name, func_ptr, inst_ptr) catch |err| {
                std.log.warn("[WARN] Failed to add call site for '{s}': {}", .{ called_name, err });
            };
        }
    }
}
```

This is more than a micro-optimization. Without this index, every pass that asks "where is this external function called?" would need to rescan functions, basic blocks, and instructions. With `CallSiteIndex`, call-site lookup becomes a shared context query used by FFI boundary detection, danger-surface tracing, and report evidence.

## Pipeline also owns post-pass reduction

After `PassManager.run`, the pipeline scans `GlobalAllocTracker` for unfreed allocations and calls `ctx.isOnDangerPathFull(rec.ptr_id)`. If a leaked pointer reaches an FFI path, severity and confidence are promoted.

This shows that Pipeline is not just a container for passes. It also performs final reduction over facts that only become meaningful after all passes have contributed:

```text
pass phase
  -> collect allocations / frees / aliases / ffi edges
post-pass phase
  -> inspect unfreed allocations
  -> query danger path
  -> convert high-value candidates into issues
```

The design choice is deliberate: a single pass sees local events, while Pipeline can inspect globally accumulated state.

## Engineering trade-off: lifecycle management is part of the architecture

The `Pipeline.run` path contains many `defer` and `errdefer` blocks for `PassContext`, hash maps, `MemoryGraph`, and semantic call graph cleanup. That is not incidental. A Zig-based analyzer processes large IR modules and allocates many maps, lists, and strings. If context ownership is unclear, the analyzer itself becomes unreliable in batch scans and CI.

So the Pipeline has three concrete responsibilities: assemble the shared context, turn expensive repeated scans into indexes, and run post-pass reduction over global facts.
