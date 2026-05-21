+++
title = "Async Task Memory Attribution: Tracking Memory Beyond Threads"
date = 2026-05-20
description = "Rust async applications often run many logical tasks on a small number of runtime worker threads."
weight = 3
[taxonomies]
tags = ["Rust", "memscope-rs"]
series = ["memscope-rs"]
[extra]
toc = true
series = "memscope-rs"
+++

# Async Task Memory Attribution: Tracking Memory Beyond Threads

Rust async applications often run many logical tasks on a small number of runtime worker threads.

That makes thread-level memory tracking insufficient. A thread can execute many tasks, and a task may resume on different worker threads after an `.await`.

The more useful question is:

> Which async task should be responsible for this allocation?

`memscope-rs` provides an async attribution layer that associates allocations with logical task IDs where task context is available.

---

## 1. Why Thread-Level Tracking Fails in Async Rust

In a synchronous multithreaded program, a thread often maps reasonably well to a unit of work.

In async Rust, that assumption breaks down:

{% mermaid() %}
flowchart TD
    R[Tokio Runtime] --> T1[Worker Thread 1]
    R --> T2[Worker Thread 2]

    T1 --> A[Task A]
    T1 --> B[Task B]
    T2 --> A
    T2 --> C[Task C]

    A --> M1[Allocation]
    B --> M2[Allocation]
    C --> M3[Allocation]

    M1 --> Q[Need task attribution]
    M2 --> Q
    M3 --> Q
{% end %}

Thread ID tells us where an allocation ran. Task attribution tells us which logical async unit it belongs to.

---

## 2. `TrackerContext`

The async context structure records thread and task information:

```rust
pub struct TrackerContext {
    pub thread_id: u64,
    pub task_id: Option<u64>,
    pub tokio_task_id: Option<u64>,
}
```

Context capture attempts to read both memscope task context and Tokio task ID:

```rust
pub fn capture() -> Self {
    let task_id_from_context = TASK_CONTEXT.try_with(|ctx| *ctx).ok().flatten();
    let tokio_task_id = tokio::task::try_id().and_then(|id| id.to_string().parse().ok());

    Self {
        thread_id: current_thread_id(),
        task_id: task_id_from_context.or(CURRENT_TASK_ID.with(|cell| cell.get())),
        tokio_task_id,
    }
}
```

This provides the basic attribution context.

---

## 3. Internal Task IDs

`memscope-rs` uses its own task ID counter:

```rust
static TASK_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn generate_unique_task_id() -> u64 {
    TASK_COUNTER.fetch_add(1, Ordering::Relaxed)
}
```

This matters because runtime task IDs may be recycled. Internal IDs are more stable for analysis and export.

---

## 4. Context Storage

The async tracker uses both thread-local and Tokio task-local context:

```rust
thread_local! {
    static CURRENT_TASK_ID: std::cell::Cell<Option<u64>> =
        const { std::cell::Cell::new(None) };
}

tokio::task_local! {
    static TASK_CONTEXT: Option<u64>;
}
```

This design reflects an important truth: async task attribution requires explicit context management. It is not automatically inferred for every future in the program.

---

## 5. `AsyncTracker`

The core async tracker stores allocations, statistics, and task profiles:

```rust
pub struct AsyncTracker {
    allocations: Arc<Mutex<HashMap<usize, AsyncAllocation>>>,
    stats: Arc<Mutex<AsyncStats>>,
    profiles: Arc<Mutex<HashMap<u64, TaskMemoryProfile>>>,
    initialized: Arc<Mutex<bool>>,
}
```

This is not a lock-free async tracker. It uses `Mutex<HashMap<...>>` internally. The focus of this module is attribution, not zero-lock performance.

---

## 6. Tracking Task Lifecycle

When a task starts, the tracker creates a profile and updates counters:

```rust
stats.total_tasks += 1;
stats.active_tasks += 1;
Self::set_current_task(task_id);
```

When it ends:

```rust
profile.mark_completed();
stats.active_tasks = stats.active_tasks.saturating_sub(1);
Self::clear_current_task();
```

{% mermaid() %}
stateDiagram-v2
    [*] --> Started
    Started --> Running
    Running --> Completed
    Completed --> [*]

    Running --> ZombieCandidate: started but not completed
{% end %}

---

## 7. Tracking Allocations by Task

Allocation attribution records pointer, size, task ID, and optional metadata:

```rust
pub fn track_allocation_with_location(
    &self,
    ptr: usize,
    size: usize,
    task_id: u64,
    var_name: Option<String>,
    type_name: Option<String>,
    source_location: Option<SourceLocation>,
) {
    let allocation = AsyncAllocation {
        ptr,
        size,
        timestamp: Self::now(),
        task_id,
        var_name,
        type_name,
        source_location,
    };

    allocations.insert(ptr, allocation);

    if let Some(profile) = profiles.get_mut(&task_id) {
        profile.record_allocation(size as u64);
    }

    stats.total_allocations += 1;
    stats.total_memory += size;
    stats.active_memory += size;
}
```

Deallocation removes the pointer and updates the relevant task profile:

```rust
let (task_id, size) = allocations
    .remove(&ptr)
    .map(|alloc| (alloc.task_id, alloc.size))
    .unwrap_or((0, 0));

if task_id != 0 {
    if let Some(profile) = profiles.get_mut(&task_id) {
        profile.record_deallocation(size as u64);
    }
}
```

---

## 8. `GlobalTracker` Integration

`GlobalTracker::track_as()` first records the normal memory event, then tries to associate heap-owner allocations with the current async task:

```rust
self.tracker.track_as(var, name, file, line, module_path);

if let Some(task_id) = AsyncTracker::get_current_task() {
    let kind = var.track_kind();
    if let TrackKind::HeapOwner { ptr, size } = kind {
        self.async_tracker.track_allocation_with_location(
            ptr,
            size,
            task_id,
            Some(name.to_string()),
            Some(type_name),
            None,
        );
    }
}
```

Important limitation: this path reads `CURRENT_TASK_ID`, while `spawn_tracked()` sets Tokio task-local `TASK_CONTEXT`. `TrackerContext::capture()` can see the task-local context, but automatic attribution through `track!` depends on the current integration path.

This should be described carefully.

---

## 9. `spawn_tracked`

`spawn_tracked()` creates a memscope task ID and scopes a future with Tokio task-local context:

```rust
pub fn spawn_tracked<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let task_id = generate_unique_task_id();

    tokio::spawn(async move {
        TASK_CONTEXT.scope(Some(task_id), future).await
    })
}
```

Example usage:

```rust
let handles: Vec<_> = (0..4)
    .map(|i| {
        spawn_tracked(async move {
            let tracker = global_tracker().unwrap();
            let ctx = TrackerContext::capture();

            let data = vec![0i32; 100];
            track!(tracker, data);

            ctx
        })
    })
    .collect();
```

This is useful for context capture, but it should not be overstated as fully automatic attribution for every `track!` path.

---

## 10. `track_in_tokio_task`

`track_in_tokio_task()` wraps a future with explicit lifecycle tracking:

```rust
pub async fn track_in_tokio_task<F, T>(&self, name: String, future: F) -> (u64, T)
where
    F: Future<Output = T>,
{
    let unique_task_id = generate_unique_task_id();
    let tokio_task_id = tokio::task::try_id().and_then(|id| id.to_string().parse().ok());

    self.track_task_start_with_tokio(unique_task_id, tokio_id, name.clone(), thread_id);

    let output = future.await;

    self.track_task_end(unique_task_id);

    (unique_task_id, output)
}
```

This path is more explicit about start/end lifecycle tracking than plain `spawn_tracked()`.

---

## 11. Zombie Task Detection

The async tracker can detect tasks that were started but not completed:

```rust
pub fn detect_zombie_tasks(&self) -> Vec<u64> {
    let profiles = self.profiles.lock().unwrap();

    profiles
        .iter()
        .filter(|(_, p)| !p.is_completed())
        .map(|(&id, _)| id)
        .collect()
}
```

This should be interpreted as zombie task candidates. A long-running task is not always a bug.

---

## 12. Export: `async_analysis.json`

The export pipeline writes async attribution data:

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

---

## 13. What This Can Track

The async layer can track:

- internal task ID;
- Tokio task ID as auxiliary data;
- thread ID;
- task start/end;
- active task count;
- task-level allocation count;
- task-level current and peak memory;
- allocation pointer and size;
- variable name and type name;
- zombie task candidates;
- `async_analysis.json` export.

---

## 14. Limitations

The async layer cannot guarantee:

- automatic tracking of every Tokio task;
- attribution for all third-party-library allocations;
- exact memory changes at every `.await` point;
- full future lifecycle reconstruction;
- automatic bridging between all task-local and thread-local context paths;
- lock-free async attribution.

The best description is:

> `memscope-rs` provides explicit async task attribution, not a fully automatic Tokio runtime profiler.

---

## 15. Summary

Async attribution matters because Rust services are increasingly task-oriented rather than thread-oriented.

{% mermaid() %}
flowchart LR
    A[task_scope / tracked future] --> B[Task Context]
    B --> C[task_id]
    C --> D[track allocation]
    D --> E[AsyncTracker]
    E --> F[TaskMemoryProfile]
    F --> G[async_analysis.json]
{% end %}

`memscope-rs` does not magically understand all async execution. It gives developers a way to attach memory events to logical tasks when context is available.

That is a practical step beyond thread-level memory tracking.

