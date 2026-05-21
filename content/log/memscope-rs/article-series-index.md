+++
title = "memscope-rs Technical Article Series Index"
date = 2026-05-21
description = "This repository contains a set of pragmatic, source-driven articles that decompose `memscope-rs` by module."
weight = 10
[taxonomies]
tags = ["Rust", "memscope-rs"]
series = ["memscope-rs"]
[extra]
toc = true
series = "memscope-rs"
+++

# memscope-rs Technical Article Series Index

This repository contains a set of pragmatic, source-driven articles that decompose `memscope-rs` by module.

The goal of the series is not to over-market the project, but to explain what the tool actually tracks, how it collects data, where inference starts, and what the current limitations are.

## Suggested Reading Order

1. `article-single-thread-tracking.md`
   - `GlobalAlloc`
   - `track!`
   - `Trackable`
   - `TrackKind`
   - standard and custom Rust types

2. `article-lockfree-multithread-tracking.md`
   - concurrent event capture
   - `SegQueue`
   - `DashMap`
   - atomics
   - CAS peak memory tracking

3. `article-unsafe-ffi-memory-passport.md`
   - unsafe allocation
   - FFI allocation
   - memory passport
   - handover/free lifecycle
   - audit boundaries

4. `article-arc-rc-stackowner.md`
   - `Arc/Rc` shared ownership
   - `StackOwner`
   - `stack_ptr`
   - `heap_ptr`
   - clone/share relation inference

5. `article-async-task-memory-attribution.md`
   - async task context
   - `AsyncTracker`
   - `spawn_tracked`
   - task-level memory attribution
   - zombie task candidates

6. `article-ownership-graph-relation-inference.md`
   - relation graph
   - ownership graph
   - owner/slice/clone/container/shared detectors
   - confidence boundaries

7. `article-architecture-facade-pipeline.md`
   - `MemScope` facade
   - capture engine
   - event store
   - snapshot engine
   - render engine

8. `article-export-dashboard-pipeline.md`
   - JSON export
   - dashboard rendering
   - memory passports
   - async reports
   - ownership graph export

9. `article-benchmark-deep-dive.md`
   - benchmark coverage
   - raw benchmark numbers
   - regressions
   - limitations of the benchmark suite

## Editorial Principle

Each article should preserve three distinctions:

- Runtime facts: data captured directly from allocation events or explicit API calls.
- Explicit metadata: variable names, source locations, task IDs, `TrackKind`, and passports.
- Inference: ownership, containment, clone, borrow, move, leak, or cycle relationships derived during analysis.

This distinction is central to presenting `memscope-rs` honestly.
