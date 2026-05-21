+++
title = "Lockfree Tracking: How `memscope-rs` Handles Concurrent Memory Events"
date = 2026-05-20
description = "Single-thread memory tracking answers the first question: can we collect useful allocation data?"
weight = 2
[taxonomies]
tags = ["Rust", "multithread", "memscope-rs"]
series = ["memscope-rs"]
[extra]
toc = true
series = "memscope-rs"
+++

# Lockfree Tracking: How `memscope-rs` Handles Concurrent Memory Events

Single-thread memory tracking answers the first question: can we collect useful allocation data?

Multithreaded tracking asks a harder one:

> Can the tool keep collecting useful memory data while many threads allocate and free memory at the same time?

In a real Rust service, allocation events do not arrive politely in sequence. Multiple threads may allocate concurrently, update statistics, drop values, and trigger snapshots or exports.

This article explains how the multithreaded path in `memscope-rs` is structured, what it actually does, and where its limits are.

---

## 1. Why Multithread Tracking Is Different

In a single-threaded flow, event order is relatively easy to reason about.

In a multithreaded flow:

- allocation events can arrive concurrently;
- deallocations can race with snapshots;
- active allocation maps need concurrent updates;
- statistics must avoid becoming a global bottleneck;
- the profiler itself should not dominate application contention.

The design uses separate structures for separate responsibilities:

{% mermaid() %}
flowchart TD
    A[Concurrent Allocation Events] --> B[Lock-free Event Queue]
    A --> C[Concurrent Allocation Map]
    A --> D[Atomic Counters]

    B --> E[Snapshot / Export]
    C --> F[Active Allocation Lookup]
    D --> G[Stats / Peak Memory]

    E --> H[Analysis / Report]
    F --> H
    G --> H
{% end %}

---

## 2. `ThreadLocalTracker`

The core multithreaded structure is `ThreadLocalTracker`.

Its important fields include:

```rust
pub struct ThreadLocalTracker {
    thread_id: ThreadId,
    events: Arc<SegQueue<Event>>,
    active_allocations: Arc<DashMap<usize, usize>>,
    total_allocations: AtomicU64,
    total_allocated: AtomicU64,
    total_deallocations: AtomicU64,
    total_deallocated: AtomicU64,
    active_memory: AtomicU64,
    peak_memory: AtomicU64,
    sample_rate: f64,
    total_seen: AtomicUsize,
    total_tracked: AtomicUsize,
}
```

The important point is separation of responsibilities:

- `SegQueue` stores events.
- `DashMap` tracks active allocations.
- atomics track counters.
- CAS logic maintains peak memory.

This avoids one large global mutex around the entire tracking pipeline.

---

## 3. Recording Allocation Events

The allocation path is structured roughly like this:

```rust
pub fn track_allocation(&self, ptr: usize, size: usize, call_stack_hash: u64) {
    self.total_seen.fetch_add(1, Ordering::Relaxed);

    if self.sample_rate < 1.0 {
        let sample_decision = rand::random::<f64>();
        if sample_decision >= self.sample_rate {
            return;
        }
    }

    self.total_tracked.fetch_add(1, Ordering::Relaxed);

    let event = Event::allocation(ptr, size, call_stack_hash, self.thread_id);
    self.events.push(event);

    self.active_allocations.insert(ptr, size);

    self.total_allocations.fetch_add(1, Ordering::Relaxed);
    self.total_allocated.fetch_add(size as u64, Ordering::Relaxed);
}
```

The design is pragmatic:

- event recording avoids a global event mutex;
- active allocations use a concurrent map;
- statistics use atomic counters;
- sampling can reduce overhead when full fidelity is not required.

---

## 4. Peak Memory with CAS and Backoff

Peak memory is a shared statistic and can become a contention point.

`memscope-rs` updates it with a CAS loop and progressive backoff:

```rust
let new_active = self.active_memory.fetch_add(size as u64, Ordering::Relaxed) + size as u64;

let mut current_peak = self.peak_memory.load(Ordering::Relaxed);
let mut backoff_count = 0u32;

while new_active > current_peak {
    match self.peak_memory.compare_exchange_weak(
        current_peak,
        new_active,
        Ordering::Relaxed,
        Ordering::Relaxed,
    ) {
        Ok(_) => break,
        Err(actual) => {
            current_peak = actual;
            backoff_count += 1;

            if backoff_count < 10 {
                std::hint::spin_loop();
            } else if backoff_count < 20 {
                std::thread::yield_now();
            } else {
                std::thread::sleep(std::time::Duration::from_micros(1));
            }
        }
    }
}
```

This is not academic “everything is lock-free” purity. It is an engineering tradeoff: keep hot updates lightweight, but avoid wasting CPU under contention.

---

## 5. Deallocation and Suspicious Frees

Deallocation removes a pointer from the active map:

```rust
pub fn track_deallocation(&self, ptr: usize, call_stack_hash: u64) {
    let size = self
        .active_allocations
        .remove(&ptr)
        .map(|(_, v)| v)
        .unwrap_or(0);

    let event = Event::deallocation(ptr, size, call_stack_hash, self.thread_id);
    self.events.push(event);

    self.total_deallocations.fetch_add(1, Ordering::Relaxed);
    self.total_deallocated.fetch_add(size as u64, Ordering::Relaxed);
}
```

If the pointer is missing, that can indicate an untracked allocation, double free candidate, or another mismatch. It should be treated as a suspicious signal, not an automatic proof of memory corruption.

---

## 6. Backend Strategy

The capture backend abstraction exposes a common interface:

```rust
pub trait CaptureBackend: Send + Sync {
    fn capture_alloc(&self, ptr: usize, size: usize, thread_id: u64) -> MemoryEvent;
    fn capture_dealloc(&self, ptr: usize, size: usize, thread_id: u64) -> MemoryEvent;
    fn capture_realloc(&self, ptr: usize, old_size: usize, new_size: usize, thread_id: u64) -> MemoryEvent;
    fn capture_move(&self, from_ptr: usize, to_ptr: usize, size: usize, thread_id: u64) -> MemoryEvent;
}
```

Available backend types include:

- `Core`
- `Lockfree`
- `Async`
- `Unified`

The `Unified` backend currently chooses simply:

- single core or unavailable parallelism → `Core`
- multiple cores → `Lockfree`

It is useful, but it should not be described as a sophisticated adaptive runtime scheduler.

---

## 7. Benchmark Interpretation

The benchmark log shows concurrent tracking scales upward with thread count, but not linearly.

| Threads | Approximate Time |
|---|---:|
| 1 | ~19.17 µs |
| 2 | ~40.60 µs |
| 4 | ~55.30 µs |
| 8 | ~134.74 µs |
| 16 | ~372.96 µs |
| 32 | ~961.58 µs |
| 64 | ~1.86 ms |
| 128 | ~4.67 ms |

Shared-tracker scenarios also show clear concurrency cost:

| Threads | Approximate Time |
|---|---:|
| 1 | ~98.30 µs |
| 8 | ~924.19 µs |
| 16 | ~1.84 ms |
| 64 | ~7.06 ms |

The honest interpretation:

- the design works under concurrency;
- contention still exists;
- shared state is not free;
- the benchmark log contains both improvements and regressions.

---

## 8. What Makes This Design Worth Writing About

### Lock-free-ish event capture

The implementation is not fully lock-free everywhere. The accurate description is that hot paths avoid heavyweight global locks where possible:

- `SegQueue` for event ingestion;
- `DashMap` for active allocation lookup;
- atomics for counters;
- CAS for peak memory.

### Separation of concerns

The tracking path separates:

- event writing;
- active allocation management;
- statistics;
- snapshot/export.

This makes the architecture easier to reason about and extend.

### Honest performance envelope

The benchmark data is useful because it is not uniformly positive. Some paths improve, some regress, and some remain close to noise. That is a credible measurement record, not just a promotional claim.

---

## 9. Limitations

- Sampling means the trace may not be complete.
- `call_stack_hash` is a lightweight signal, not a full symbolic backtrace.
- Contention is reduced, not eliminated.
- Shared tracker benchmarks are stress scenarios, not proof of ideal scalability.
- Performance should be measured under real application workloads.

---

## 10. Summary

The multithreaded design answers a different question from single-thread tracking:

> When many threads write memory events at once, can the tool still collect useful data without becoming the main bottleneck?

`memscope-rs` approaches this with `SegQueue`, `DashMap`, atomics, and CAS-based statistics. It is not zero-cost, but it is a practical concurrent tracking architecture.

