+++
title = "Benchmark Deep Dive: What the Numbers Actually Say"
date = 2026-05-21
description = "Performance claims are easy to overstate. This article keeps the interpretation narrow and tied to the benchmark source and log that exist in the repository."
weight = 14
[taxonomies]
tags = ["Rust", "memscope-rs"]
series = ["memscope-rs"]
[extra]
toc = true
series = "memscope-rs"
+++

# Benchmark Deep Dive: What the Numbers Actually Say

Performance claims are easy to overstate. This article keeps the interpretation narrow and tied to the benchmark source and log that exist in the repository.

The benchmark suite is in:

```text
benches/comprehensive_benchmarks.rs
```

The raw benchmark log reviewed here is:

```text
benches/run.log
```

The goal is not to claim that `memscope-rs` is always fast. The goal is to identify which operations are currently cheap, which operations scale linearly, and where the log already shows regressions.

---

## 1. Benchmark Coverage

The benchmark source includes groups such as:

- tracker creation;
- single variable tracking;
- multiple variable tracking;
- analysis;
- stats;
- backend alloc/dealloc/realloc/move;
- type classification;
- concurrent tracking;
- parallel tracking;
- shared tracker concurrent tracking;
- allocation patterns;
- analysis operations;
- tracking stats;
- IO operations.

This is broad coverage, but not every feature has an isolated benchmark. For example, there is no standalone benchmark specifically isolating `StackOwner` grouping or async attribution overhead.

---

## 2. Tracker Creation

The log reports:

```text
tracker_creation time: [867.65 ns 873.02 ns 879.91 ns]
change: [+551.47% +559.50% +568.23%]
Performance has regressed.
```

Interpretation:

- absolute time is still sub-microsecond;
- relative performance regressed significantly against the previous baseline;
- this should not be described as an unqualified win.

---

## 3. Single Variable Tracking

Representative results:

| Benchmark | Approximate Median |
|---|---:|
| `track_single/vec/64` | 653.02 ns |
| `track_single/vec/256` | 662.81 ns |
| `track_single/vec/1024` | 666.22 ns |
| `track_single/vec/4096` | 725.49 ns |
| `track_single/vec/65536` | 1.1087 µs |
| `track_single/vec/1048576` | 4.9307 µs |

The small-object tracking path is sub-microsecond, but the log marks several of these as regressions relative to earlier runs.

Interpretation:

- single tracking overhead is practically usable for profiling;
- overhead is not zero;
- recent changes appear to have increased latency for smaller payloads.

---

## 4. Multiple Variable Tracking

Representative results:

| Variables | Approximate Median |
|---:|---:|
| 10 | 6.5364 µs |
| 50 | 33.240 µs |
| 100 | 66.963 µs |
| 1000 | 669.67 µs |
| 5000 | 3.3126 ms |
| 10000 | 6.5949 ms |

This is close to linear scaling.

Interpretation:

- batch tracking cost grows predictably;
- the per-item cost is roughly stable;
- the log marks these paths as regressions against the prior baseline.

---

## 5. Analysis Cost

Representative analysis results:

| Records | Approximate Median |
|---:|---:|
| 10 | 5.2939 µs |
| 50 | 16.028 µs |
| 100 | 29.759 µs |
| 1000 | 285.64 µs |
| 5000 | 1.5684 ms |
| 10000 | 4.1880 ms |
| 50000 | 33.887 ms |

Interpretation:

- small and medium analysis is fast enough for interactive use;
- large analysis becomes millisecond-scale;
- 50,000 records is tens of milliseconds;
- several larger analysis cases show significant relative regressions.

---

## 6. Backend Event Construction

Representative backend allocation times:

| Backend | Alloc Median |
|---|---:|
| Core | 23.022 ns |
| Lockfree | 39.265 ns |
| Async | 23.008 ns |
| Unified | 39.512 ns |

Representative deallocation times:

| Backend | Dealloc Median |
|---|---:|
| Core | 22.859 ns |
| Lockfree | 38.586 ns |
| Async | 22.632 ns |
| Unified | 39.147 ns |

Interpretation:

- backend event construction is nanosecond-scale;
- Core and Async are similar in this benchmark;
- Lockfree and Unified are slower, roughly in the high-30ns range;
- this benchmark measures event construction, not full end-to-end application overhead.

---

## 7. Concurrent Tracking

Representative concurrent tracking results:

| Threads | Approximate Median |
|---:|---:|
| 1 | 19.174 µs |
| 2 | 40.599 µs |
| 4 | 55.303 µs |
| 8 | 134.74 µs |
| 16 | 372.96 µs |
| 32 | 961.58 µs |
| 64 | 1.8646 ms |
| 128 | 4.6714 ms |

Interpretation:

- concurrency works;
- scaling is not linear;
- thread scheduling and shared state costs are visible;
- 48-thread results show regression, while some larger thread-count cases show improvement against the previous baseline.

---

## 8. Shared Tracker Concurrent Tracking

Representative shared tracker results:

| Threads | Approximate Median |
|---:|---:|
| 1 | 98.300 µs |
| 2 | 231.96 µs |
| 4 | 363.82 µs |
| 8 | 924.19 µs |
| 16 | 1.8448 ms |
| 32 | 3.5680 ms |
| 64 | 7.0581 ms |

Interpretation:

- sharing one tracker across many threads is a stress scenario;
- costs grow clearly with thread count;
- the log shows improvements against previous runs, but absolute shared-state cost remains visible.

---

## 9. Allocation Patterns

Representative results:

| Pattern | Approximate Median | Log Status |
|---|---:|---|
| many small allocations | 809.84 µs | regressed |
| few large allocations | 96.308 µs | improved |
| mixed size allocations | 111.44 µs | regressed |
| burst allocations | 789.08 µs | no significant change |

Interpretation:

- many small allocations remain expensive compared with few large allocations;
- allocation pattern matters;
- performance should be discussed by workload shape, not one global number.

---

## 10. Tracking Stats

Some statistics operations are extremely cheap:

| Operation | Approximate Median |
|---|---:|
| `stats_record_attempt` | 1.8200 ns |
| `stats_record_success` | 1.8211 ns |
| `stats_record_miss` | 3.2607 ns |
| `stats_get_completeness` | 548.58 ps |
| `stats_get_detailed_stats` | 1.6463 ns |

These are tiny operations, but they should not be confused with full tracking or analysis cost.

---

## 11. What the Benchmark Does Not Prove

The benchmark log does not prove:

- production overhead under all workloads;
- async attribution overhead in isolation;
- `StackOwner` grouping cost in isolation;
- dashboard rendering cost under large reports;
- memory overhead under long-running services;
- correctness of relation inference.

Benchmarks measure performance of specific paths, not the whole tool in every environment.

---

## 12. Honest Summary

The accurate performance story is:

- core event construction is nanosecond-scale;
- explicit variable tracking is usually sub-microsecond for small values;
- batch tracking scales roughly linearly;
- analysis becomes millisecond-scale for large record counts;
- concurrency is supported but not free;
- shared tracker scenarios show real contention cost;
- benchmark logs include both improvements and regressions.

The most honest phrasing is:

> `memscope-rs` has practical profiling overhead for many measured paths, but it is not zero-cost and the benchmark log shows active performance evolution.

