+++
title = "Export and Dashboard Pipeline: Turning Memory Events into Reports"
date = 2026-05-21
description = "Collecting memory data is only useful if developers can inspect it."
weight = 12
[taxonomies]
tags = ["Rust", "memscope-rs"]
series = ["memscope-rs"]
[extra]
toc = true
series = "memscope-rs"
+++

# Export and Dashboard Pipeline: Turning Memory Events into Reports

Collecting memory data is only useful if developers can inspect it.

`memscope-rs` exports both machine-readable JSON and HTML dashboards. The export pipeline is not a thin wrapper around one report; it combines snapshots, passports, async task data, ownership graphs, system resources, and task graphs.

This article explains what the export pipeline actually writes and how it is assembled.

---

## 1. Export Starts from the Event Store

The main export entry point is `export_all_json()`.

The first step is to read events from the tracker’s event store:

```rust
let events = tracker.event_store().snapshot();
let allocations = rebuild_allocations_from_events(&events);
let snapshot = MemorySnapshot::from_allocation_infos(allocations.clone());
```

This is important:

> export does not only use a live allocation map; it rebuilds report data from the event stream.

{% mermaid() %}
flowchart TD
    A[EventStore] --> B[snapshot]
    B --> C[rebuild_allocations_from_events]
    C --> D[MemorySnapshot]
    D --> E[JSON Reports]
    D --> F[Dashboard Context]
{% end %}

---

## 2. What `export_all_json()` Writes

The export pipeline writes multiple files:

```rust
export_snapshot_to_json(&snapshot, path_ref, &options)?;
export_memory_passports_json(path_ref, passport_tracker)?;
export_leak_detection_json(path_ref, passport_tracker)?;
export_unsafe_ffi_json(path_ref, passport_tracker)?;
export_system_resources_json(path_ref)?;
export_async_analysis_json(path_ref, async_tracker)?;
export_ownership_graph_json(path_ref, &typed_allocations, tracker.event_store())?;
export_task_graph_json(path_ref)?;
```

The actual outputs include:

- memory snapshot JSON;
- memory passport JSON;
- leak detection JSON;
- unsafe/FFI JSON;
- system resources JSON;
- async analysis JSON;
- ownership graph JSON;
- task graph JSON.

This makes the export pipeline one of the main integration points in the project.

---

## 3. Memory Passport Export

Passport export summarizes lifecycle records:

```rust
serde_json::json!({
    "passport_id": p.passport_id,
    "allocation_ptr": format!("0x{:x}", p.allocation_ptr),
    "size_bytes": p.size_bytes,
    "created_at": p.created_at,
    "lifecycle_events": p.lifecycle_events.len(),
    "status": format!("{:?}", p.status_at_shutdown),
})
```

This is intentionally a summary. It does not dump every internal detail by default.

---

## 4. Unsafe/FFI Export

Unsafe/FFI export filters passports by FFI-relevant status:

```rust
let ffi_reports: Vec<_> = passports
    .values()
    .filter(|p| {
        matches!(
            p.status_at_shutdown,
            PassportStatus::HandoverToFfi
                | PassportStatus::InForeignCustody
                | PassportStatus::FreedByForeign
        )
    })
    .collect();
```

This means `unsafe_ffi.json` is not just a raw memory dump. It is a filtered report focused on boundary-related memory.

---

## 5. Async Export

Async export writes `async_analysis.json` with summary, task profiles, and active allocations.

```rust
let async_data = json!({
    "summary": {
        "total_tasks": stats.total_tasks,
        "active_tasks": stats.active_tasks,
        "total_allocations": stats.total_allocations,
        "total_memory_bytes": stats.total_memory,
        "active_memory_bytes": stats.active_memory,
        "peak_memory_bytes": stats.peak_memory,
    },
    "task_profiles": profiles.iter().map(|p| json!({
        "task_id": p.task_id,
        "task_name": p.task_name,
        "current_memory": p.current_memory,
        "peak_memory": p.peak_memory,
        "total_allocations": p.total_allocations,
        "total_deallocations": p.total_deallocations,
        "is_completed": p.is_completed(),
        "has_potential_leak": p.has_potential_leak(),
    })),
    "allocations": snapshot.allocations.iter().map(|a| json!({
        "ptr": format!("0x{:x}", a.ptr),
        "size": a.size,
        "task_id": a.task_id,
        "var_name": a.var_name,
        "type_name": a.type_name,
    })),
});
```

This is the bridge between runtime async attribution and offline analysis.

---

## 6. Ownership Graph Export

Ownership graph export includes nodes and edges.

Node export:

```rust
json!({
    "id": format!("0x{:x}", node.id.0),
    "type_name": node.type_name,
    "size": node.size,
    "stack_ptr": node.stack_ptr.map(|p| format!("0x{:x}", p)),
})
```

Edge export:

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

This output is only as accurate as the underlying relation inference. It should be read as an analysis graph, not a compiler proof.

---

## 7. Dashboard Rendering

The HTML dashboard path builds a dashboard context from tracker data and renders it with a template.

The export function chooses a dashboard template:

```rust
match template {
    DashboardTemplate::Final => renderer.render_final_dashboard(&context),
    DashboardTemplate::Unified => renderer.render_unified_dashboard(&context),
}
```

The dashboard is therefore a rendered view over the same reconstructed data used by JSON export.

{% mermaid() %}
flowchart TD
    A[Tracker + EventStore] --> B[Dashboard Context]
    C[Passport Tracker] --> B
    D[Async Tracker] --> B
    B --> E[Handlebars Renderer]
    E --> F[Unified Dashboard HTML]
{% end %}

---

## 8. Practical Value

The export pipeline matters because it gives different audiences different entry points:

- JSON for tooling and CI;
- HTML dashboard for human inspection;
- ownership graph JSON for visual relation analysis;
- async JSON for task-level diagnosis;
- passport JSON for unsafe/FFI audit trails.

---

## 9. Limitations

- Exported reports are derived from recorded events; missing events mean missing report data.
- Some reports summarize data rather than dumping every internal detail.
- Ownership graph export includes inferred relations.
- Async export depends on explicit async context attribution.
- Unsafe/FFI export depends on passports being created and updated.

---

## 10. Summary

The export and dashboard pipeline is the point where `memscope-rs` becomes usable as a developer tool.

It turns event streams into:

- snapshots;
- JSON files;
- ownership graphs;
- async task reports;
- memory passport reports;
- dashboards.

The most accurate description is:

> export is not just serialization; it is the integration layer that combines runtime facts, explicit metadata, and analysis results into inspectable artifacts.

