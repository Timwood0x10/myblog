+++
title = "The Scoring Model: From Qualitative Signals to a Single Number"
date = 2026-05-27
description = "You have 10 signal detectors, each producing a violation count. Some signals are severe (deep nesting), some are noisy (magic numbers). How do you combine them into a single, fair score using logarithmic scaling?"
weight = 39
[taxonomies]
tags = ["Rust", "Code Quality", "Static Analysis"]
series = ["garbage-code-hunter"]
[extra]
series = "garbage-code-hunter"
+++

# The Scoring Model

> **Question**: You have 10 signal detectors, each producing a violation count. Some signals are severe (deep nesting), some are noisy (magic numbers). How do you combine them into a single, fair score?

## The Problem with Linear Scoring

The simplest approach is linear addition: `score = sum(all violations)`. This fails because:

1. **Scale mismatch.** 100 magic numbers is common in large codebases. 100 deeply nested blocks is catastrophic. Linear scoring treats them equally.

2. **Project size bias.** A 100,000-line project will have more violations than a 100-line project, even if the code quality is identical. Raw counts are not comparable.

3. **Diminishing severity.** The 1st god function is alarming. The 100th is just more of the same systemic issue. Linear scoring says the second is 100x worse — but it is not.

garbage-code-hunter solves all three problems with a **two-tier logarithmic scoring model**.

## The Two-Tier Model

The total score is the sum of two independent tiers (`src/scoring.rs:141-166`):

{% mermaid() %}
graph TB
    ISSUES[All Issues] --> SEV{Severity?}
    SEV --> |"Nuclear"| T1[Tier 1: Nuclear Score]
    SEV --> |"Spicy"| T2[Tier 2: Noisy Density Score]
    SEV --> |"Mild"| T2

    T1 --> |"log2(1+n) * 8<br/>cap: 40"| TOTAL[Total Score<br/>0-100]
    T2 --> |"log2(1+d) * 6<br/>cap: 60"| TOTAL

    TOTAL --> QL[Quality Level]
{% end %}

### Tier 1: Nuclear Score (High Confidence)

Nuclear issues are **high-confidence problems** — when they appear, they are almost always real:

- Deeply nested blocks (>= 5 levels)
- God functions (> 50 lines)
- Bare `except` in Python
- `unsafe` blocks in Rust

The formula:

```rust
// src/scoring.rs:155-156
let n_score = (severity_distribution.nuclear as f64 + 1.0).log2() * 8.0;
let n_score = n_score.min(40.0);
```

| Nuclear Count | Score | Interpretation |
|---------------|-------|----------------|
| 0 | 0.0 | No high-confidence issues |
| 1 | 8.0 | One nuclear issue detected |
| 2 | 12.7 | Two issues |
| 5 | 20.7 | Pattern forming |
| 10 | 27.7 | Systemic problem |
| 30 | 39.6 | Cap reached |

The logarithm ensures that going from 0 to 1 nuclear issue is a bigger jump than going from 30 to 31. This matches human intuition: the first deeply nested function is alarming; the 31st is just confirmation.

### Tier 2: Noisy Density Score

Spicy and Mild issues are **noisy** — magic numbers, naming violations, and `println` calls often have legitimate reasons:

- Magic numbers in UI layouts
- Short variable names in mathematical formulas
- `println` in main functions

The formula uses **density** (per 1000 lines) to normalize across project sizes:

```rust
// src/scoring.rs:158-164
let k_lines = total_lines as f64 / 1000.0;
let noisy_density = (severity_distribution.spicy as f64 * 1.5
                   + severity_distribution.mild as f64) / k_lines;
let d_score = (noisy_density + 1.0).log2() * 6.0;
let d_score = d_score.min(60.0);
```

Key details:
- **Spicy counts 1.5x** vs Mild — slightly more reliable, but still noisy
- **Density normalization**: a 100-line file with 5 magic numbers scores the same as a 10,000-line file with 500
- **Cap at 60**: prevents noisy signals from overwhelming the score

### The Final Score

```rust
// src/scoring.rs:166
let total_score = n_score + d_score;
```

Range: 0-100. But note the asymmetry:
- Nuclear cap: 40 (high confidence)
- Noisy cap: 60 (volume matters more)
- Nuclear issues can never exceed 40% of the total score

This means a codebase with 0 nuclear issues but lots of mild noise can still score poorly — because high-volume noise is still a quality problem.

## Quality Levels

The score maps to five quality levels (`src/scoring.rs:33-39`):

```rust
pub enum QualityLevel {
    Excellent, // 0-20
    Good,      // 21-40
    Average,   // 41-60
    Poor,      // 61-80
    Terrible,  // 81+
}
```

These are not arbitrary. Each level corresponds to a different response:

| Level | Score | Meaning | Action |
|-------|-------|---------|--------|
| Excellent | 0-20 | Clean code | Ship it |
| Good | 21-40 | Minor issues | Fix when convenient |
| Average | 41-60 | Noticeable smells | Schedule cleanup |
| Poor | 61-80 | Significant problems | Prioritize fixes |
| Terrible | 81+ | Systemic failure | Halt and refactor |

## Why Logarithmic?

The logarithm serves three purposes:

### 1. Diminishing Returns

```
log2(1 + n):
  n=0   → 0.0
  n=1   → 1.0
  n=10  → 3.5
  n=100 → 6.7
  n=1000 → 10.0
```

Going from 0 to 1 issue is a 1.0 jump. Going from 100 to 101 is a 0.01 jump. This matches the "first one matters most" intuition.

### 2. Scale Invariance

Logarithmic scoring makes the score comparable across project sizes. A 100-line file with 5 issues and a 10,000-line file with 500 issues get similar density scores.

### 3. Outlier Resistance

Without log, a single file with 1000 `println` calls would dominate the entire project score. With log, it contributes about 10 points — significant but not catastrophic.

## Signal-Level Scoring

Each individual signal also gets a normalized score (`src/signals.rs:82-86`):

```rust
pub fn violations_to_score(count: usize, total_lines: usize) -> f64 {
    let k_lines = (total_lines as f64 / 1000.0).max(0.001);
    let density = count as f64 / k_lines;
    ((density + 1.0).log2() * 6.0).min(25.0)
}
```

Each signal's score ranges from 0 to 25. This is used for:
- **Personality inference** (Article 08): which signal dominates determines the archetype
- **Category breakdown**: naming, complexity, duplication, code-smells, student-code
- **Trend tracking**: signal scores over time show whether a specific smell is getting better or worse

## Category Scoring

Beyond the two-tier model, the scorer also computes per-category scores (`src/scoring.rs:117-139`):

```rust
// Five categories, each log-scaled and capped at 20
for &cat_name in &["naming", "complexity", "duplication", "code-smells", "student-code"] {
    let cat_count = category_counts.get(cat_name).copied().unwrap_or(0);
    let cat_density = cat_count as f64 / k_lines;
    let cat_score = ((cat_density + 1.0).log2() * 6.0).min(20.0);
    category_scores.insert(cat_name.to_string(), cat_score);
}
```

These are informational — they do not affect the total score, but they help developers understand **which dimension** of code quality needs attention.

## Severity Classification

Not all issues are equal. garbage-code-hunter classifies issues into three severity levels (`src/analyzer.rs:39-44`):

```rust
pub enum Severity {
    Mild,    // Minor issues (naming, magic numbers)
    Spicy,   // Medium issues (debug calls, shallow nesting)
    Nuclear, // Serious issues (deep nesting, god functions)
}
```

The classification is not per-rule — it is per-signal. A `NestedHell` violation is always Nuclear because deep nesting is always a structural problem. A `NamingChaos` violation is always Mild because bad names are annoying but not dangerous.

## Putting It All Together

{% mermaid() %}
graph TB
    subgraph "Per-File"
        F1[File A] --> IR1[StyleIR]
        F2[File B] --> IR2[StyleIR]
        F3[File N] --> IRN[StyleIR]
    end

    subgraph "Detection"
        IR1 --> DET[10 Detectors]
        IR2 --> DET
        IRN --> DET
        DET --> FIND[StyleFindings]
    end

    subgraph "Scoring"
        FIND --> SEV[Classify Severity]
        SEV --> T1[Tier 1: Nuclear<br/>log2(1+n)*8]
        SEV --> T2[Tier 2: Noisy<br/>log2(1+d)*6]
        T1 --> TOTAL[Total: 0-100]
        T2 --> TOTAL
        TOTAL --> QL[Quality Level]
    end
{% end %}

---

*Next: [The Fun Side: Roasts, Personality, and the Tool Belt](./08-fun-side-roasts-and-personality.md) — Why code analysis should be entertaining, and how garbage-code-hunter makes developers actually read their reports.*
