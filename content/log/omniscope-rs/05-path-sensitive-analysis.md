+++
title = "OmniScope-rs 06: Path-Sensitive Analysis — Heuristic vs. Structured"
date = 2026-06-16
description = "Part 6 of the OmniScope-rs series: how Zig and Rust distinguish definite leaks from conditional leaks and cleanup-protected paths."
weight = 6
[taxonomies]
tags = ["Rust", "Zig", "Path Analysis", "FFI", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 6: Path-Sensitive Analysis — Heuristic vs. Structured

## The Hardest Problem in Static Analysis

So far, we've built a contract graph. We know which resources were allocated, which operations were performed, and which ownership states each resource went through.

But here's the thing: **not all code paths are the same**.

```c
void example(int error_code) {
    char *buf = malloc(1024);           // Allocate
    if (error_code != 0) {
        log_error(error_code);          // Just log, don't free
        return;                         // LEAK on this path!
    }
    process(buf);                       // Use the buffer
    free(buf);                          // Free on success path
}
```

Is this a leak? **Yes, it is** — when `error_code != 0`, `buf` is never freed. But is this a _real_ leak, or did the programmer intentionally skip the free because the process is about to terminate? Or maybe `log_error()` takes ownership of `buf`? Or maybe `process()` stores `buf` in a global on success?

This is the **path-sensitivity problem**: determining, for each execution path through a function, whether a resource is properly released, transferred, or escaped. And then making a judgment call about whether the resource leak is real.

---

## Think About It

How would you determine if a "leak" is real?

Consider a function with multiple exit paths. Some paths free the resource. Some don't. What conclusions can you draw?

- **All paths free** → definitely not a leak (probably).
- **No paths free** → definitely a leak (probably).
- **Some paths free, some don't** → maybe a leak? Depends on whether the non-freeing paths are error/abort paths.

And then there are cleanup patterns:

- `goto cleanup` in C — a common pattern where a single cleanup block handles all resources on error paths.
- `defer` / `errdefer` in Zig — the compiler guarantees cleanup runs even on error paths.
- RAII destructors in C++ / `Drop` in Rust — the compiler handles cleanup automatically.
- Destructors, finalizers, GC — various language mechanisms that make "leak" a more nuanced concept.

A good static analyzer needs to distinguish between:
1. **Definite leaks**: Resources that are never freed on any path, with no cleanup mechanism.
2. **Conditional leaks**: Resources freed on some paths but not others — may be intentional (error paths) or may be bugs.
3. **Cleanup-protected**: Resources that appear leaked but are handled by a cleanup mechanism (goto cleanup, errdefer, destructor).
4. **Safe**: Resources freed, transferred, or escaped on all paths.

---

## Zig's Approach: Heuristic with Floating-Point Confidence

### The PathAnalyzer

The Zig version uses a `PathAnalyzer` that examines the contract graph edges and classifies paths based on edge types:

```zig
pub const PathClassification = enum(u8) {
    released_path,
    escaped_path,
    leak_path,
    unknown_path,
    cleanup_path,
};
```

### Confidence Thresholds

The analyzer uses three floating-point confidence constants:

```zig
const CONF_ALL_LEAKING: f32 = 0.90;
const CONF_SOME_LEAKING: f32 = 0.65;
const CONF_NONE_LEAKING: f32 = 0.0;
```

These thresholds determine how the analyzer reports findings:

- **0.90 confidence**: All edges are leaking — this is a definite leak.
- **0.65 confidence**: Some edges are leaking — this is a conditional/possible leak.
- **0.0 confidence**: None are leaking — not a leak.

### Cleanup Pattern Detection

The `isCleanupEdge` function checks if an edge matches any cleanup pattern:

```zig
const CLEANUP_PATTERNS = [_][]const u8{
    "_cleanup", "_fail", "errdefer", "defer_",
    "__cxa_begin_catch", "goto ",
    "__attribute__((cleanup", "RAII",
    "destructor", "~", "Drop(", "drop(",
};

fn isCleanupEdge(edge: *const ContractEdge) -> bool {
    const callee = edge.callee_name orelse return false;
    for (CLEANUP_PATTERNS) |pat| {
        if (std.mem.indexOf(u8, callee, pat) != null) return true;
    }
    return false;
}
```

If a cleanup edge is detected, the `has_cleanup_alternative` flag is set on the `LeakCandidate`, which can downgrade the severity or suppress the false positive.

### How Classification Works

The `analyzeInstance` method counts edges:

```zig
pub fn analyzeInstance(self: *PathAnalyzer, inst: *ResourceInstance) ?LeakCandidate {
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

    const classification = if (release_count > 0) .released_path
        else if (escape_count > 0) .escaped_path
        else if (has_cleanup) .cleanup_path
        else if (total_paths > 0) .leak_path
        else .unknown_path;

    const leaky_paths = switch (classification) {
        .released_path, .escaped_path, .cleanup_path => 0,
        .leak_path, .unknown_path => total_paths,
    };

    const confidence = if (classification == .leak_path and leaky_paths == total_paths)
        CONF_ALL_LEAKING
    else if (classification == .leak_path)
        CONF_SOME_LEAKING
    else
        CONF_NONE_LEAKING;

    return LeakCandidate{ ... };
}
```

The key insight: **the Zig classifier doesn't truly track individual paths**. It counts edges and makes a judgment based on the counts. If there are release edges, it's a "released path." If there are no release or escape edges, it's a "leak path." The confidence is then calculated from the ratio.

This is heuristic path analysis — it approximates path sensitivity without doing full symbolic execution.

### Configurable Threshold

The default threshold of 0.65 is configurable:

```zig
pub const DEFAULT_THRESHOLD: f32 = 0.65;

// In the pipeline:
if (candidate.confidence >= config.threshold) {
    // Report this as a finding
}
```

This lets users tune the analyzer's sensitivity. Set it to 0.0 to catch everything (at the cost of false positives). Set it to 0.9 to only report definite leaks (at the cost of false negatives).

---

## Rust's Approach: Structured Path States with Discrete Confidence

### PathExitState and ResourcePathState

The Rust version defines a richer set of exit states:

```rust
pub enum ResourcePathState {
    Owned,                  // Still owned — potential leak
    Released,               // Properly freed
    EscapedToCaller,        // Returned to caller
    EscapedOutParam,        // Stored in out-parameter
    StoredToOwner,          // Stored in owner struct
    StoredToRuntime,        // Stored in GC heap / global
    RuntimeManaged,         // Arena/zone/GC managed
    StaticLifetime,         // Process-lifetime
    AbortOrUnreachable,     // Path terminates abnormally
    Null,                   // Resource is NULL
    Unknown,                // Can't determine
}
```

### Collecting Exit States

The `collect_exit_states` function collects resource states at each function exit point, enriched with semantic resolution tree (SRT) data, function summaries, and termination information:

```rust
pub fn collect_exit_states(
    pointer_states: &PointerStateMap,
    alloc: &RawResourceFact,
    srt_resolutions: &Option<HashMap<String, Vec<SemanticKind>>>,
    summary_store: &SummaryStore,
    func_termination: &HashMap<String, FunctionTermination>,
) -> Vec<PathExitState> {
    let mut exit_states = Vec::new();

    for (slot, state) in pointer_states {
        let resource_state = match state {
            PointerValueState::Unknown => ResourcePathState::Unknown,
            PointerValueState::Null => ResourcePathState::Null,
            PointerValueState::Owned { .. } => {
                // Enrich: check if function only aborts
                if let Some(FunctionTermination::OnlyAborts) =
                    func_termination.get(&alloc.caller_name)
                {
                    ResourcePathState::AbortOrUnreachable
                }
                // Enrich: check SRT for runtime-managed / static-lifetime
                else if is_runtime_managed(srt_resolutions, alloc) {
                    classify_runtime_state(srt_resolutions, alloc)
                } else {
                    ResourcePathState::Owned
                }
            }
            PointerValueState::Released { .. } => ResourcePathState::Released,
            PointerValueState::Escaped { .. } => {
                // Enrich: check if caller returns owned resource
                if caller_returns_owned_resource(summary_store, alloc) {
                    ResourcePathState::EscapedToCaller
                } else {
                    ResourcePathState::EscapedToCaller
                }
            }
        };
        exit_states.push(PathExitState { resource_state, _evidence: vec![] });
    }

    // ... release path pattern detection ...
}
```

Key enrichments:
- **AbortOrUnreachable**: If a function only has abort paths, "leaked" resources are actually harmless.
- **StoredToOwner vs RuntimeManaged vs StaticLifetime**: SRT data distinguishes between storing in a struct field (safe) vs. managed by a runtime (safe) vs. static lifetime (safe).
- **EscapedToCaller vs EscapedOutParam**: Differentiates returning a value vs. writing to an out-parameter.

### PathConfidence — Discrete Levels

The Rust version uses discrete confidence levels:

```rust
pub enum PathConfidence {
    Low,     // < 65% agreement
    Medium,  // >= 65% agreement
    High,    // >= 90% agreement
}
```

These are computed by `path_confidence_score`:

```rust
fn path_confidence_score(total: usize, owned: usize, safe: usize) -> PathConfidence {
    if total == 0 {
        return PathConfidence::Low;
    }
    let majority_ratio = owned.max(safe) as f32 / total as f32;
    if majority_ratio >= 0.90 {
        PathConfidence::High
    } else if majority_ratio >= 0.65 {
        PathConfidence::Medium
    } else {
        PathConfidence::Low
    }
}
```

The confidence converts to a score for reporting:

```rust
impl PathConfidence {
    pub fn to_score(self) -> f32 {
        match self {
            PathConfidence::High => 0.9,
            PathConfidence::Medium => 0.6,
            PathConfidence::Low => 0.3,
        }
    }
}
```

### Combining Path States

The `combine_path_states` function aggregates multiple exit states:

```rust
pub fn combine_path_states(exit_states: &[PathExitState]) -> PathCombinationResult {
    let total_paths = exit_states.len();
    let mut owned_paths = 0usize;
    let mut safe_paths = 0usize;
    let mut unknown_paths = 0usize;

    for state in exit_states {
        if is_safe_exit(&state.resource_state) {
            safe_paths += 1;
        } else if state.resource_state == ResourcePathState::Owned {
            owned_paths += 1;
        } else {
            unknown_paths += 1;
        }
    }

    let confidence = path_confidence_score(total_paths, owned_paths, safe_paths);
    PathCombinationResult { total_paths, owned_paths, safe_paths, unknown_paths, confidence }
}
```

### Release Path Pattern Detection

The Rust version also detects whether releases are mutually exclusive or sequential, which is critical for double-free analysis:

```rust
pub enum ReleasePathPattern {
    MutuallyExclusive,    // if/else branches each free once
    SequentialRelease,    // Same path frees twice
    MixedRelease,         // Combination
    Indeterminate,
}

pub fn detect_release_path_pattern(
    total_released_instances: usize,
    unique_instances: usize,
) -> ReleasePathPattern {
    if total_released_instances > unique_instances {
        ReleasePathPattern::MutuallyExclusive
    } else if total_released_instances == unique_instances {
        ReleasePathPattern::SequentialRelease
    } else {
        ReleasePathPattern::Indeterminate
    }
}
```

This is important for correctness: if a resource is released on two different paths (if/else), that's not a double-free — only one path executes. But if it's released twice on the same path, that's a real double-free.

### LeakType Determination

The `determine_leak_type` function makes the final call:

```rust
pub fn determine_leak_type(
    exit_states: &[PathExitState],
    alloc_count: u32,
    release_count: u32,
) -> LeakType {
    if !exit_states.is_empty() {
        let all_owned = exit_states.iter().all(|s| s.resource_state == ResourcePathState::Owned);
        let some_owned = exit_states.iter().any(|s| s.resource_state == ResourcePathState::Owned);
        let all_safe = exit_states.iter().all(|s| is_safe_exit(&s.resource_state));

        if all_safe { return LeakType::Safe; }
        else if all_owned { return LeakType::Definite; }
        else if some_owned { return LeakType::Conditional; }
    }

    // Fallback to counting
    if alloc_count > 0 && release_count == 0 { LeakType::Definite }
    else if alloc_count > 0 && release_count > 0 && release_count < alloc_count {
        LeakType::Conditional
    } else { LeakType::Safe }
}
```

---

## Comparison: Floating-Point vs. Discrete

| Aspect | Zig | Rust |
|--------|-----|------|
| **Confidence model** | Floating-point `f32` (0.0–1.0) | Discrete enum `PathConfidence` (Low/Medium/High) |
| **Thresholds** | 0.65 default, configurable | 65% and 90% hardcoded |
| **Path tracking** | Edge counting per instance | `PathExitState` enumeration with enrichment |
| **Enrichment sources** | Cleanup pattern matching | SRT, function summaries, termination analysis |
| **Release pattern** | Implicit (count-based) | Explicit `ReleasePathPattern` detection |
| **Abort handling** | Not explicit | `FunctionTermination::OnlyAborts` |
| **Runtime-managed detection** | Not explicit | SRT-based `is_runtime_managed()` |
| **Default report threshold** | 0.65 | Definite + Conditional |

### The Zig Trade-off: More Granular, More Arbitrary

Zig's floating-point confidence scoring is **more granular**. You get values like 0.85, 0.55, 0.30 — precise numbers that can be used for ranking and prioritization. The configurable threshold lets users dial in their preferred sensitivity.

But it's also **more arbitrary**. What does "0.73 confidence" really mean? Is it meaningfully different from 0.74? The floating-point precision suggests a scientific rigor that doesn't really exist — these are heuristic scores, not probabilities derived from data.

### The Rust Trade-off: Less Granular, More Deterministic

Rust's discrete confidence levels are **less granular** but **more deterministic**. There are clear rules: ≥90% agreement is High, ≥65% is Medium, below is Low. This is easier to explain, easier to test, and harder to accidentally break.

But the discrete levels can feel **imprecise**. A scenario with 64% agreement gets "Low" confidence, and one with 66% gets "Medium". That 2% difference changes the output, even though the scenarios are practically identical.

### What We Can Learn

Path-sensitive analysis is the most subjective part of OmniScope. There's no "right answer" — every threshold, every confidence level, every enrichment heuristic is a judgment call.

- **Zig's floating-point approach says**: "Let's give analysts a continuous score they can use to prioritize findings. The exact number matters less than the ranking."
- **Rust's discrete approach says**: "Let's give analysts clear categories they can build rules around. Definite leaks get reported, conditional leaks get flagged for review, low-confidence leaks get suppressed."

Both approaches are used in production static analyzers. Clang Static Analyzer uses something closer to Zig's approach (bug categories with priority levels). Coverity uses something closer to Rust's approach (definite vs. probable vs. possible).

The right choice depends on your users: do they want a ranked list of "most likely bugs first" (Zig), or do they want clear "this is a bug / this might be a bug / this is not a bug" categories (Rust)?

---

Next up: **Part 7 — FFI Boundary Detection: VTable Pattern vs. Trait Objects**. The final piece of the puzzle: detecting which functions cross FFI boundaries and what language they belong to. This is where OmniScope's cross-language mission becomes concrete, and where the Zig and Rust implementations diverge most in their use of language-specific idioms.