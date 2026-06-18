+++
title = "OmniScope-rs 05: Contract Graph — Building the Resource Flow Picture"
date = 2026-06-16
description = "Part 5 of the OmniScope-rs series: how Zig and Rust connect allocation sites to releases across function boundaries."
weight = 5
[taxonomies]
tags = ["Rust", "Zig", "Graph Analysis", "FFI", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 5: Contract Graph — Building the Resource Flow Picture

## Connecting the Dots

So far, we've learned how OmniScope:

1. **Loads LLVM IR** into an analyzable form
2. **Classifies functions** into resource families (malloc → c_heap, free → c_heap, etc.)
3. **Tracks ownership states** (owned, borrowed, released, etc.) for each resource

But ownership tracking per-instance only gets us so far. The real power comes when we **connect allocation sites to their corresponding releases across function boundaries**.

Consider this C code:

```c
void foo() {
    int *p = malloc(100);    // Allocation site #1
    bar(p);                  // Pass p to bar()
    // Is p leaked? It depends on what bar() does!
}

void bar(int *ptr) {
    // Does bar() free ptr? Store it? Return it?
    process(ptr);            // Maybe just reads it?
    // ...
}
```

To determine if `foo()` leaks `p`, we need to know what `bar()` does with it. Does `bar()` call `free(ptr)`? Does it store `ptr` in a global? Does it return `ptr` to its own caller?

This is the **cross-function resource flow** problem. And the solution is a **contract graph** — a data structure that captures every operation on every resource instance and connects them into a directed graph.

---

## Think About It

What would a resource flow graph look like?

Each **resource instance** (one allocation) would be a node in the graph. Each **operation** on that resource (free, store, return, escape, retain) would be an edge.

For a simple case like:

```c
void example() {
    int *p = malloc(100);   // Node: instance #1, c_heap
    free(p);                // Edge: release
}
```

The graph would be: `Instance #1 --[release]--> (terminal)`

For a more complex case with cross-function flow:

```c
void example() {
    int *p = malloc(100);   // Node: instance #1, c_heap
    helper(p);              // Edge: transfer to helper
}

void helper(int *ptr) {
    free(ptr);              // Edge: release
}
```

The graph would be: `Instance #1 --[transfer]--> Instance #1 (in helper) --[release]--> (terminal)`

Now, what if there are multiple paths?

```c
void example(int cond) {
    int *p = malloc(100);   // Node: instance #1
    if (cond) {
        free(p);            // Edge: release (path A)
    }
    // No free on path B — possible leak
}
```

Here the graph needs to track that there are **two paths**: one where the resource is released, and one where it's not. This is where **path-sensitive analysis** (our next post) comes in.

First, we need the graph itself.

---

## Zig's Approach: ResourceContractGraph

### The Building Blocks

The Zig version defines `ResourceInstance` as a node in the graph:

```zig
pub const ResourceInstance = struct {
    id: u32,
    alloc_inst_addr: u64,         // Which LLVM instruction allocated this
    family: ?FamilyId,            // c_heap, python_object, etc.
    state: PointerContract,       // Current ownership state
    alloc_func_name: ?[]const u8, // Which function did the allocation
    edges: std.ArrayList(ContractEdge),  // All operations on this resource
    escapes: ?*escape_mod.EscapeList,    // Escape records
    evidence: ?[]const u8,                // Why this classification
    confidence: f32,                      // How sure we are
};
```

And `ContractEdge` as a directed edge between instances:

```zig
pub const ContractEdge = struct {
    from_id: u32,             // Source instance
    to_id: u32,               // Target instance (same as from_id for single-instance ops)
    effect: Effect,           // What kind of operation
    inst_addr: u64,           // Where in the LLVM IR this happens
    bb_id: u32,               // Which basic block
    callee_name: ?[]const u8, // Function called (if applicable)
    confidence: f32,          // How sure we are
    is_ffi_boundary: bool,    // Does this cross an FFI boundary?
    ffi_boundary_distance: u8, // How far from FFI boundary
};
```

### How the Graph is Built

The graph is built by `contract_graph_builder.zig` during the analysis pipeline. It:

1. Walks all allocation sites in the IR (using `MemoryGraph` and `SummaryStore`)
2. Creates a `ResourceInstance` for each unique allocation site
3. Walks all operations on each resource and creates `ContractEdge` entries
4. Deduplicates by pointer value — one instance per allocation

The graph is **read-only after construction**. All downstream passes query the same graph rather than building their own.

### Graph Traversal

The `PathAnalyzer` (which we'll cover in depth next post) traverses the graph by walking `inst.edges` — all edges for a given instance:

```zig
pub fn analyzeInstance(self: *PathAnalyzer, inst: *ResourceInstance) ?LeakCandidate {
    const edges = inst.edges.items;
    if (edges.len == 0) return null;

    var total_paths: u32 = 0;
    var release_count: u32 = 0;
    var escape_count: u32 = 0;
    var has_cleanup: bool = false;

    for (edges) |edge| {
        total_paths += 1;
        switch (edge.effect) {
            .releases => release_count += 1,
            .conditional_release => release_count += 1,
            .returns_owned, .transfers, .consumes_arg => escape_count += 1,
            .stores_arg_to_owner, .stores_arg_to_global => escape_count += 1,
            .initializes_out_param => escape_count += 1,
            .escapes_to_callback => escape_count += 1,
            else => {},
        }
        if (isCleanupEdge(&edge)) has_cleanup = true;
    }
    // ... classify paths
}
```

The graph is simple — edges are attached to instances. Path analysis is a matter of counting edges of each type.

---

## Rust's Approach: ContractGraph with Pass-Based Architecture

### The Building Blocks

The Rust version defines `ContractGraph` as a standalone data structure:

```rust
pub struct ContractGraph {
    pub edges: Vec<ContractEdge>,
    next_instance_id: u64,
    pub ffi_boundaries: HashMap<String, FFIBoundary>,
}
```

With edges defined as:

```rust
pub struct ContractEdge {
    pub source: u64,
    pub target: u64,
    pub effect: Effect,
    pub function: FunctionId,
    pub function_name: String,
    pub caller_name: String,
    pub family: Option<FamilyId>,
    pub boundary_evidence: Option<Vec<BoundaryEvidence>>,
}
```

### The Pass-Based Architecture

The key difference from Zig: **the Rust version uses dedicated passes with explicit dependencies**.

The `ContractGraphBuilderPass` is a `Pass` that:

1. **Declares dependencies** on earlier passes (e.g., `RawFactCollector`, `CallGraphPass`)
2. **Runs as part of the pass pipeline** with explicit ordering
3. **Stores its output** in `PassContext` for downstream consumers

Here's the `ContractGraphBuilderPass`:

```rust
impl Pass for ContractGraphBuilderPass {
    fn name(&self) -> &'static str { "ContractGraphBuilder" }
    fn kind(&self) -> PassKind { PassKind::Analysis }
    fn dependencies(&self) -> Vec<&'static str> {
        vec!["RawFactCollector", "CallGraph", "SurfaceClassifier"]
    }

    fn run(&self, ctx: &mut PassContext) -> Result<PassResult> {
        // 1. Retrieve raw facts from context
        let raw_facts: Vec<RawResourceFact> = ctx.get("raw_facts").unwrap_or_default();

        // 2. Retrieve summary store
        let summary_store: SummaryStore = ctx.get("summary_store").unwrap_or_default();

        // 3. Build the contract graph
        let mut graph = ContractGraph::new();

        for fact in &raw_facts {
            // Create resource instance for each unique allocation
            let instance_id = graph.alloc_instance();

            // Add edges based on raw fact effects
            for effect in &fact.effects {
                let edge = ContractEdge {
                    source: instance_id,
                    target: instance_id,
                    effect: effect.clone(),
                    function: fact.function_id,
                    // ...
                };
                graph.add_edge(edge);
            }
        }

        // 4. Store graph in context for downstream passes
        ctx.set("contract_graph", graph);

        Ok(PassResult::new(self.name())
            .with_nodes(raw_facts.len() as u64)
            .with_duration(...))
    }
}
```

### The OwnershipSolverPass

The Rust version also has a separate `OwnershipSolverPass` that reads the `ContractGraph` and propagates ownership states:

```rust
pub struct OwnershipSolverPass;

impl Pass for OwnershipSolverPass {
    fn name(&self) -> &'static str { "OwnershipSolver" }
    fn dependencies(&self) -> Vec<&'static str> {
        vec!["ContractGraphBuilder", "SummaryBuilder"]
    }

    fn run(&self, ctx: &mut PassContext) -> Result<PassResult> {
        let graph: ContractGraph = ctx.get("contract_graph").ok_or("missing graph")?;
        let mut state_map = PointerStateMap::new();

        // For each edge in the graph, transition the state
        for edge in &graph.edges {
            let current_state = state_map.get_state(edge.source);
            let new_state = transition_state(current_state, &edge);
            state_map.set_state(edge.source, new_state);
        }

        ctx.set("pointer_state_map", state_map);
        Ok(PassResult { ... })
    }
}
```

This separation — `ContractGraphBuilderPass` builds the graph, `OwnershipSolverPass` runs the state machine — is a classic Rust architectural choice. Each pass has a single responsibility and clearly declared inputs/outputs.

---

## Comparison: Ad-Hoc vs. Formalized

| Aspect | Zig | Rust |
|--------|-----|------|
| **Graph type** | `ResourceContractGraph` | `ContractGraph` |
| **Edge type** | `ContractEdge` (embedded in instances) | `ContractEdge` (flat vec) |
| **Instance tracking** | `ResourceInstance` with embedded edges | Instance IDs on edges, state in `PointerStateMap` |
| **Pass structure** | Integrated into a single pass | Separate `ContractGraphBuilderPass` + `OwnershipSolverPass` |
| **Pass dependencies** | Implicit (called in order) | Explicit (`dependencies() -> Vec<&str>`) |
| **State propagation** | Edges are counted/classified in path_analyzer | `OwnershipSolverPass` propagates states independently |
| **Storage** | Graph lives in the pass | Graph stored in `PassContext` |
| **FFI boundary info** | Per-edge `is_ffi_boundary` flag | Per-edge `boundary_evidence` attachable data |

### The Zig Trade-off: Pass-Integrated, Ad-Hoc

Zig's contract graph is **built and used within the same analysis flow**. The `contract_graph_builder.zig` creates the graph, and the `path_analyzer.zig` uses it directly. There's no separate "ownership solver pass" — state analysis happens during path analysis.

This is simpler to implement and easier to understand in the small. You read one file (`contract_graph_builder.zig`) and you see the whole flow. But it's harder to reuse — if another pass wanted to query the state of a resource, it would need to either access the graph's internal state or duplicate the logic.

### The Rust Trade-off: Formalized, Modular

Rust's pass-based approach with separate builders and solvers is **more work upfront** but **easier to extend**. Want to add a new analysis that reads the contract graph? Just declare `ContractGraphBuilder` as a dependency. Want to try a different ownership solver? Write a new `OwnershipSolverPass` that reads the same graph and produces a different `PointerStateMap`.

The explicit dependency system (`dependencies()`) also provides **automatic ordering** — the pass manager can topologically sort passes and run them in the right order without the developer having to think about it.

### What We Can Learn

The contract graph reveals how the two languages approach **data flow** in large systems:

**Zig treats data flow as implicit and local.** The contract graph is a tool, not an architecture. It exists to help the path analyzer, and it's tightly coupled to that use case. If you need to understand how a resource flows through the system, you read the graph builder and the path analyzer together.

**Rust treats data flow as explicit and modular.** The contract graph is an architectural boundary with a clearly defined interface. Passes declare their dependencies, produce well-typed outputs, and consume well-typed inputs. The data flow between passes is visible in the type signatures.

Which approach is better? It depends on your project:

- If you're building a **single-purpose analyzer** where the graph has one consumer, Zig's integrated approach is simpler and faster to develop.
- If you're building a **framework for analysis** where multiple passes might query the graph in different ways, Rust's modular approach gives you the flexibility you need without sacrificing correctness.

OmniScope's requirements lean toward the second category — it has many analysis passes (leak detection, cross-free validation, borrow-escape checking, FFI boundary analysis) that all need to query resource flow information. The Rust's pass-based architecture serves this well.

---

Next up: **Part 6 — Path-Sensitive Analysis: Heuristic vs. Structured**. With the contract graph in hand, we need to determine which resources are actually leaked. Not all code paths free resources — some have if/else branches, some have cleanup paths, some abort. How do we distinguish a real leak from a legitimate design choice?