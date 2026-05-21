+++
title = "Ownership Graph and Relation Inference: From Memory Events to Rust Semantics"
date = 2026-05-21
description = "The previous articles focused on data collection:"
weight = 13
[taxonomies]
tags = ["Rust", "memscope-rs"]
series = ["memscope-rs"]
[extra]
toc = true
series = "memscope-rs"
+++

# Ownership Graph and Relation Inference: From Memory Events to Rust Semantics

The previous articles focused on data collection:

- single-thread tracking records allocation facts and Rust-level metadata;
- lockfree tracking handles concurrent event capture;
- memory passports describe unsafe and FFI lifecycles;
- `StackOwner` makes `Arc/Rc` shared ownership observable;
- async attribution connects allocations to logical tasks.

This article focuses on the next layer:

> How does `memscope-rs` turn collected memory records into relationships?

This is where raw events become a graph of ownership, containment, sharing, slices, clones, and inferred relations.

The key word is **inferred**. This graph is not a compiler proof of Rust ownership. It is a post-analysis structure built from runtime facts, explicit metadata, memory scanning, and heuristics.

---

## 1. Why a Relation Graph Exists

Raw allocation records are useful, but they do not explain structure.

An allocation list can tell us:

```text
ptr=0x1000 size=1024 type=Vec<T>
ptr=0x5000 size=64   type=HashMap<K,V>
ptr=0x9000 size=24   type=Arc<T>
```

But it does not directly answer:

- Which object owns another object?
- Which container likely contains which heap allocations?
- Which `Arc/Rc` values share the same heap data?
- Which object is a slice/view into another?
- Which allocations look like clones?
- Are there cycles in the relationship graph?

The relation graph exists to answer those questions as an analysis layer.

{% mermaid() %}
flowchart TD
    A[MemoryEvent Stream] --> B[Snapshot]
    B --> C[Active Allocations]
    C --> D[Inference Records]
    D --> E[Relation Detectors]

    E --> F[Owns]
    E --> G[Contains]
    E --> H[Shares]
    E --> I[Slice]
    E --> J[Clone]
    E --> K[ArcClone / RcClone]

    F --> L[RelationGraph]
    G --> L
    H --> L
    I --> L
    J --> L
    K --> L

    L --> M[Diagnostics]
    L --> N[JSON Export]
    L --> O[Dashboard]
{% end %}

---

## 2. Relation Types

The relation inference module defines the core relationship types:

```rust
pub enum Relation {
    Owns,
    Contains,
    Shares,
    Slice,
    Clone,
    Evolution,
    ArcClone,
    RcClone,
    ImmutableBorrow,
    MutableBorrow,
}
```

These represent analysis edges between allocation records.

The important distinction is that not all of these relations have the same confidence level.

For example:

- `Owns` can be inferred from pointer scanning.
- `Contains` is inferred from `Container` metadata and temporal locality.
- `ArcClone` can be inferred from `StackOwner` records sharing a `heap_ptr`.
- `Clone` is inferred from type, size, call stack, time window, and content similarity.
- borrow/move-related edges are higher-level semantic approximations, not direct runtime hooks.

---

## 3. The Builder Pipeline

The main pipeline is in `RelationGraphBuilder::build()`.

At a high level, it does this:

```rust
pub fn build(
    allocations: &[ActiveAllocation],
    config: Option<GraphBuilderConfig>,
) -> RelationGraph {
    let scan_results = HeapScanner::scan(allocations);

    let records: Vec<InferenceRecord> = allocations
        .iter()
        .enumerate()
        .map(|(id, alloc)| {
            InferenceRecord {
                id,
                ptr: alloc.ptr.unwrap_or(0),
                size: alloc.size,
                memory: scanned_memory,
                type_kind,
                confidence,
                call_stack_hash: alloc.call_stack_hash,
                alloc_time: alloc.allocated_at,
                stack_ptr: alloc.stack_ptr,
            }
        })
        .collect();

    let range_map = RangeMap::new(allocations);

    let mut graph = RelationGraph::new();

    for record in &records {
        graph.add_edges(detect_owner(record, &range_map));
    }

    graph.add_edges(detect_slice(&records, allocations, &range_map));
    graph.add_edges(detect_clones(&records, &config.clone_config));
    graph.add_edges(detect_containers(allocations, Some(config.container_config)));
    graph.add_edges(detect_variable_evolution(allocations));
    graph.add_edges(detect_shared(&records, &graph.edges));

    graph
}
```

The real implementation runs these steps:

1. scan heap memory;
2. build inference records;
3. build an address range map;
4. detect owner relations;
5. detect slice relations;
6. detect clone relations;
7. detect container relations;
8. detect variable evolution;
9. detect shared ownership.

{% mermaid() %}
flowchart TD
    A[ActiveAllocation List] --> B[HeapScanner]
    B --> C[ScanResult]
    C --> D[UTI / Type Inference]
    D --> E[InferenceRecord]
    E --> F[RangeMap]

    F --> G[Owner Detector]
    F --> H[Slice Detector]
    E --> I[Clone Detector]
    A --> J[Container Detector]
    A --> K[Variable Evolution]
    E --> L[Shared Detector]

    G --> M[RelationGraph]
    H --> M
    I --> M
    J --> M
    K --> M
    L --> M
{% end %}

---

## 4. `InferenceRecord`: The Analysis Unit

The relation builder converts runtime allocations into inference records.

The fields include:

```rust
InferenceRecord {
    id,
    ptr: alloc.ptr.unwrap_or(0),
    size: alloc.size,
    memory,
    type_kind,
    confidence,
    call_stack_hash: alloc.call_stack_hash,
    alloc_time: alloc.allocated_at,
    stack_ptr: alloc.stack_ptr,
}
```

This record is the bridge between raw memory data and relation inference.

It may contain:

- pointer address;
- allocation size;
- scanned memory bytes;
- inferred type kind;
- inference confidence;
- call stack hash;
- allocation timestamp;
- `stack_ptr` for `StackOwner` values such as `Arc/Rc`.

This is also where confidence boundaries begin. If memory cannot be scanned, type inference and pointer-based relation detection become less informative.

---

## 5. Owner Detection: Pointer Scanning

Owner detection scans an allocation’s memory for pointer-sized values that point into another allocation.

Simplified:

```rust
pub fn detect_owner(record: &InferenceRecord, range_map: &RangeMap) -> Vec<RelationEdge> {
    let memory = match &record.memory {
        Some(m) => m,
        None => return Vec::new(),
    };

    for offset in (0..memory.len()).step_by(std::mem::size_of::<usize>()) {
        let Some(ptr_val) = memory.read_usize(offset) else {
            continue;
        };

        if ptr_val == 0 || ptr_val < MIN_VALID_POINTER {
            continue;
        }

        if let Some(target_id) = range_map.find_containing(ptr_val) {
            relations.push(RelationEdge {
                from: record.id,
                to: target_id,
                relation: Relation::Owns,
            });
        }
    }

    relations
}
```

This is a useful heuristic: if allocation A contains a pointer into allocation B, A may own or reference B.

But it is still a heuristic. A pointer-looking value in memory does not always mean Rust ownership.

---

## 6. Slice Detection

Slice detection looks for records whose pointer falls inside another allocation rather than at the beginning.

Conceptually:

```rust
if ptr != target_start && ptr >= target_start && ptr + size <= target_end {
    relations.push(RelationEdge {
        from: record.id,
        to: target_id,
        relation: Relation::Slice,
    });
}
```

This is useful for views such as slices or sub-regions.

The interpretation should be conservative:

> This allocation looks like a view into another allocation.

Not:

> This is definitely a Rust slice with exact lifetime semantics.

---

## 7. Clone Detection

Clone detection groups allocations and compares content similarity within a time window.

The configuration includes:

```rust
pub struct CloneConfig {
    pub max_time_diff_ns: u64,
    pub compare_bytes: usize,
    pub min_similarity: f64,
    pub min_similarity_no_stack_hash: f64,
    pub max_clone_edges_per_node: usize,
    pub detect_smart_pointers: bool,
    pub arc_threshold: f64,
    pub rc_threshold: f64,
}
```

The module comments describe the grouping strategy as:

```text
(type, size, stack_hash) + sliding time window + content similarity
```

This is explicitly probabilistic. It reduces false positives with thresholds, but it is not a compiler-level clone hook.

---

## 8. Container Detection

Containers such as `HashMap`, `BTreeMap`, and `VecDeque` often do not expose a stable user-level heap pointer.

`memscope-rs` tracks them as `TrackKind::Container` metadata, then infers `Contains` relations using temporal locality and filters.

The container detector algorithm is described in the source as:

1. filter allocations into containers and heap owners;
2. for each container, examine subsequent heap owners within a time window;
3. apply thread affinity and size-ratio filters;
4. add `Contains` edges for candidates.

Simplified:

```rust
for container in containers {
    for candidate in heap_owners_after(container) {
        if container.thread_id != candidate.thread_id {
            continue;
        }

        if time_diff > config.time_window_ns {
            break;
        }

        if candidate.size > container.size * config.size_ratio {
            continue;
        }

        edges.push(RelationEdge {
            from: container_id,
            to: candidate_id,
            relation: Relation::Contains,
        });
    }
}
```

This is one of the places where the tool is intentionally honest: `Contains` is inferred from metadata and timing, not directly proven from Rust internals.

---

## 9. Shared Ownership Detection

Shared ownership detection has two strategies.

The first strategy looks for multiple owner edges into a target that looks like `Arc/Rc`-like data.

The second strategy is more important for the newer `StackOwner` model:

```rust
let mut stack_owners: Vec<(usize, usize)> = Vec::new();

for (i, record) in records.iter().enumerate() {
    if let Some(stack_ptr) = record.stack_ptr {
        if stack_ptr > 0x1000 {
            stack_owners.push((i, record.ptr));
        }
    }
}

let mut heap_to_records: HashMap<usize, Vec<usize>> = HashMap::new();

for (record_id, heap_ptr) in stack_owners {
    heap_to_records.entry(heap_ptr).or_default().push(record_id);
}

for (_heap_ptr, record_ids) in heap_to_records {
    if record_ids.len() >= 2 {
        // emit ArcClone edges
    }
}
```

This is the same principle explained in the `StackOwner` article:

> multiple tracked smart pointer values pointing to the same heap data imply observed shared ownership.

---

## 10. Variable Evolution

The builder also has a variable evolution step.

The source comment describes it as:

```text
For allocations with the same variable name, infer evolution relationships indicating that the same variable was tracked multiple times.
```

Examples include:

- a growing `Vec`;
- a reallocated buffer;
- a container tracked multiple times over time.

This is useful for timeline-style interpretation, but it should be described as variable evolution inference, not exact move semantics.

---

## 11. RelationGraph vs OwnershipGraph

There are two related but distinct graph concepts.

### `RelationGraph`

`RelationGraph` is the direct output of relation inference:

```rust
pub struct RelationGraph {
    pub edges: Vec<RelationEdge>,
}
```

It is centered on inferred relationships between allocation records.

### `OwnershipGraph`

`OwnershipGraph` is a higher-level post-analysis graph:

```rust
pub struct Node {
    pub id: ObjectId,
    pub type_name: String,
    pub size: usize,
    pub stack_ptr: Option<usize>,
}

pub enum EdgeKind {
    Owns,
    Contains,
    Borrows,
    RcClone,
    ArcClone,
    Move,
    SharedBorrow,
    MutBorrow,
}
```

The ownership graph is designed for diagnostics and visualization. It can report clone edges, cycles, and possible clone storms.

---

## 12. Exporting the Ownership Graph

The render/export layer builds an ownership graph from allocation records and event store data.

The export includes:

- nodes;
- edges;
- cycles;
- diagnostics;
- borrow history.

Node export looks like:

```rust
json!({
    "id": format!("0x{:x}", node.id.0),
    "type_name": node.type_name,
    "size": node.size,
    "stack_ptr": node.stack_ptr.map(|p| format!("0x{:x}", p)),
})
```

Edge export maps internal edge kinds to strings:

```rust
"kind": match edge.op {
    EdgeKind::Owns => "Owns",
    EdgeKind::Contains => "Contains",
    EdgeKind::Borrows => "Borrows",
    EdgeKind::RcClone => "RcClone",
    EdgeKind::ArcClone => "ArcClone",
    EdgeKind::Move => "Move",
    EdgeKind::SharedBorrow => "SharedBorrow",
    EdgeKind::MutBorrow => "MutBorrow",
}
```

This is what makes the graph consumable by dashboards and JSON-based tooling.

---

## 13. A Practical View of Confidence

Not all graph edges should be interpreted equally.

High-confidence inputs:

- pointer addresses from allocation tracking;
- allocation sizes;
- explicit `track!` metadata;
- `StackOwner.stack_ptr` and `heap_ptr` when tracked;
- explicit memory passport lifecycle events.

Medium-confidence relations:

- `ArcClone` from multiple `StackOwner` records sharing a `heap_ptr`;
- `Contains` from container metadata and temporal locality;
- `Slice` from pointer-in-range detection.

Heuristic relations:

- `Clone` from content similarity;
- `Owns` from memory pointer scanning;
- variable `Evolution` from repeated variable names;
- borrow/move approximations.

The graph is most useful when these confidence levels are understood.

---

## 14. What This Can Do

The relation and ownership graph layers can help answer:

- Which allocations appear connected?
- Which tracked smart pointers share heap data?
- Which containers likely own or group nearby heap allocations?
- Which allocations look like slices or sub-regions?
- Which allocations appear cloned?
- Are there graph cycles?
- Are there many `ArcClone` edges suggesting a clone storm candidate?

This is valuable for debugging and exploration.

---

## 15. What This Cannot Prove

The graph cannot prove:

- full Rust ownership correctness;
- exact borrow lifetimes;
- exact move semantics;
- every clone call site;
- all container internals;
- semantic ownership across untracked variables;
- correctness of unsafe or foreign code.

It is a runtime-informed analysis graph, not a Rust compiler or formal verifier.

---

## 16. Summary

The ownership graph layer is where `memscope-rs` starts to connect raw memory behavior back to Rust semantics.

It combines:

- allocation records;
- heap scanning;
- type inference;
- range maps;
- `TrackKind` metadata;
- `StackOwner` metadata;
- container metadata;
- memory passport events;
- relation detectors.

The most accurate description is:

> `memscope-rs` builds an explainable, runtime-informed relationship graph. It is not a compiler proof, but it can make memory structure visible enough to debug real Rust programs.

