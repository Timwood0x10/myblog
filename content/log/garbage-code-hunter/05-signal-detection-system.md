+++
title = "The Signal Detection System"
date = 2026-05-27
description = "A codebase has 200 different rules that each flag a specific pattern. 120 of them fire on every file. Developers ignore the output. Sound familiar? Fewer, stronger detectors beat many weak ones."
weight = 37
[taxonomies]
tags = ["Rust", "Code Quality", "Static Analysis"]
series = ["garbage-code-hunter"]
[extra]
series = "garbage-code-hunter"
+++

# The Signal Detection System

> **Question**: A codebase has 200 different "rules" that each flag a specific pattern. 120 of them fire on every file. Developers ignore the output. Sound familiar?

## The Rule Explosion Problem

Traditional linters follow a "more rules = more coverage" philosophy. ESLint has 250+ rules. Pylint has 200+. RuboCop has 500+. The problem is not finding issues — it is **drowning in them**.

When every line triggers a warning, developers stop reading warnings. This is the linter equivalent of car alarms — everyone ignores them because they go off constantly.

garbage-code-hunter takes the opposite approach: **fewer rules, stronger signals**.

## 10 Detectors, Not 200 Rules

Instead of hundreds of granular rules, garbage-code-hunter defines 10 signal detectors (`src/detectors.rs`). Each detector covers a **behavioral dimension** — a category of code smell that indicates a specific kind of developer behavior:

| # | Detector | Signal | What It Detects | Why It Matters |
|---|----------|--------|-----------------|----------------|
| 1 | `PanicAddictionDetector` | PanicAddiction | `.unwrap()`, `panic!()`, `expect()` | Error handling laziness |
| 2 | `NamingChaosDetector` | NamingChaos | Single-letter vars, meaningless names | Communication failure |
| 3 | `NestedHellDetector` | NestedHell | Blocks nested >= 5 levels | Cognitive complexity |
| 4 | `HotfixCultureDetector` | HotfixCulture | `println!`, `dbg!`, `todo!`, `unimplemented!` | Debug leftovers |
| 5 | `OverEngineeringDetector` | OverEngineering | God functions (>50 lines), >5 params | Over-abstraction |
| 6 | `CodeSmellsDetector` | CodeSmells | Unsafe blocks, magic numbers, dup imports | General hygiene |
| 7 | `DuplicationDetector` | Duplication | Repeated code blocks | Copy-paste culture |
| 8 | `LegacyCodeDetector` | LegacyCode | Commented-out code (3+ lines) | Dead weight |
| 9 | `TodoMountainDetector` | TodoMountain | TODO/FIXME/BUG/HACK markers | Deferred debt |
| 10 | `LineCountSmellDetector` | LineCountSmell | Files >1000 lines | Monolith tendency |

Each detector is **language-agnostic** — it reads from `StyleIr` and does not know which language the code is written in.

## The SignalDetector Trait

The trait (`src/signals.rs:17-79`) is deliberately minimal:

```rust
pub trait SignalDetector: Send + Sync {
    fn signal(&self) -> StyleSignal;
    fn supported_languages(&self) -> &'static [Language];
    fn count_violations(&self, file: &ParsedFile) -> usize;
    fn count_violations_with_ir(&self, ir: &StyleIr, file: &ParsedFile) -> usize;
    fn skips_test_files(&self) -> bool { true }
    fn detect_findings(...) -> Vec<(StyleSignal, usize)>;
    fn detect_findings_with_ir(...) -> Vec<(StyleSignal, usize)>;
}
```

The key methods:

- **`signal()`** — returns the `StyleSignal` variant this detector produces. This is the detector's identity.
- **`supported_languages()`** — which languages this detector applies to. Most return `ADAPTER_LANGUAGES` (all 11).
- **`count_violations()`** — the core detection logic. Returns the raw violation count.
- **`count_violations_with_ir()`** — optimized path using pre-computed StyleIR.
- **`skips_test_files()`** — whether test files should be excluded (default: `true`).

## How a Detector Works: PanicAddiction

Here is the complete implementation (`src/detectors.rs:44-62`):

```rust
impl SignalDetector for PanicAddictionDetector {
    fn signal(&self) -> StyleSignal {
        StyleSignal::PanicAddiction
    }

    fn supported_languages(&self) -> &'static [Language] {
        ADAPTER_LANGUAGES
    }

    fn count_violations(&self, file: &ParsedFile) -> usize {
        StyleIr::from_parsed(file)
            .map(|ir| ir.panic_call_count)
            .unwrap_or(0)
    }

    fn count_violations_with_ir(&self, ir: &StyleIr, _file: &ParsedFile) -> usize {
        ir.panic_call_count
    }
}
```

That is it. The entire detector is 18 lines. It reads `ir.panic_call_count` — a number that the language adapter already computed. The detector does not know about `unwrap()`, `panic!()`, or any language-specific syntax.

## Test File Handling: The 20% Rule

Test code is different from production code. `unwrap()` in a test is acceptable — in production, it is not. But completely ignoring test code would miss real issues in test helpers and utilities.

garbage-code-hunter applies a **20% weight** to test file violations (`src/analyzer.rs:257-260`):

```rust
let count = if *is_test_file {
    (count as f64 * 0.2).round() as usize
} else {
    count
};
```

This means:
- 10 `unwrap()` calls in production code = 10 violations
- 10 `unwrap()` calls in test code = 2 violations

The 20% is not arbitrary — it is low enough to prevent test code from dominating scores, but high enough to flag genuinely problematic patterns in test helpers.

## Rust-Specific: `#[cfg(test)]` Awareness

For Rust, the adapter goes further. It detects `#[cfg(test)]` module byte ranges and **excludes panics inside them** from counting entirely (`src/language/adapter/rust.rs:16-46`):

```rust
// Find #[cfg(test)] module byte ranges
let cfg_test_ranges: Vec<(usize, usize)> = ...;

// When counting panic calls, skip those inside #[cfg(test)] modules
fn is_in_cfg_test_module(node: Node, ranges: &[(usize, usize)]) -> bool {
    let start = node.start_byte();
    ranges.iter().any(|&(lo, hi)| start >= lo && start < hi)
}
```

This is more precise than the 20% rule — it identifies exactly which code is test-only at the language level, not just at the file-path level.

## Detection Flow

{% mermaid() %}
sequenceDiagram
    participant A as Analyzer
    participant IR as StyleIR
    participant D as Detector
    participant S as Scorer

    A->>IR: from_parsed(file)
    IR-->>A: StyleIr { counts }

    loop For each detector
        A->>D: detect_findings_with_ir(ir, file, is_test, skip_tests)

        alt is_test && detector.skips_test_files()
            D-->>A: [] (empty)
        else
            D->>D: count_violations_with_ir(ir)
            D-->>A: [(signal, count)]
        end

        alt is_test_file
            A->>A: count = count * 0.2
        end

        A->>A: push StyleFinding
    end

    A->>S: calculate_score(findings)
{% end %}

## Why "Fewer Rules" Works

The 10-detector approach works because of a key insight: **developers do not have 200 bad habits — they have 10.**

The `PanicAddiction` signal does not care whether you called `.unwrap()` on a `Result` or an `Option`. It does not care whether the call is in a `match` arm or a chain. It cares about one thing: **how many times did you skip error handling?**

This coarse-grained approach has advantages:

1. **Low false positive rate.** A detector that counts `unwrap()` calls has near-zero false positives — every `unwrap()` is a conscious choice to skip error handling.

2. **Actionable feedback.** "You have 47 panic calls" is more actionable than "Line 42: consider using `match` instead of `unwrap()`" x 47.

3. **Cross-language consistency.** The same 10 signals apply to all 11 languages. A Python project and a Rust project are scored on the same scale.

4. **Personality inference.** With 10 signals, you can map patterns to archetypes (Article 08). With 200 rules, the signal is lost in noise.

## The Signal Score

Each detector produces a raw violation count. The scoring system converts this to a normalized score using density-based logarithmic scaling (`src/signals.rs:82-86`):

```rust
pub fn violations_to_score(count: usize, total_lines: usize) -> f64 {
    let k_lines = (total_lines as f64 / 1000.0).max(0.001);
    let density = count as f64 / k_lines;
    ((density + 1.0).log2() * 6.0).min(25.0)
}
```

The formula:
- **Density**: violations per 1000 lines (fair across project sizes)
- **Log2**: diminishing returns (10 violations is bad, 100 is not 10x worse)
- **Cap at 25**: prevents any single signal from dominating

The scoring model is covered in depth in Article 07.

## Adding a New Detector

To add a `MagicNumberDetector`:

1. Add `StyleSignal::MagicNumber` to the signal enum
2. Create `MagicNumberDetector` implementing `SignalDetector`
3. `count_violations_with_ir()` returns `ir.magic_number_count`
4. Register it in the detector list

**Zero adapter changes.** The `magic_number_count` field already exists in `StyleIr` because every adapter already computes it. The detector just reads it.

---

*Next: [Duplication Detection Algorithms](./06-duplication-algorithms.md) — How to find copy-paste code across an entire codebase, and why Jaccard similarity is not enough.*
