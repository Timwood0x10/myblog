+++
title = "Duplication Detection Algorithms"
date = 2026-05-27
description = "You have a 10,000-line codebase. Somewhere in it, two functions are 95% identical — differing only in variable names. How do you find them without comparing every pair of functions?"
weight = 38
[taxonomies]
tags = ["Rust", "Code Quality", "Static Analysis"]
series = ["garbage-code-hunter"]
[extra]
series = "garbage-code-hunter"
+++

# Duplication Detection Algorithms

> **Question**: You have a 10,000-line codebase. Somewhere in it, two functions are 95% identical — differing only in variable names. How do you find them without comparing every pair of functions?

## Why Duplication Is Hard

Code duplication is the most pervasive code smell and the hardest to detect automatically. The challenge is not finding exact copies — `diff` can do that. The challenge is finding **near-duplicates**: code blocks that do the same thing with different variable names, different string literals, or trivially different control flow.

garbage-code-hunter uses two complementary approaches:
- **Cross-file duplication**: finds duplicate functions across the entire codebase
- **Intra-file duplication**: finds repeated code blocks within a single file

## Cross-File Duplication: AST Token Fingerprinting

The cross-file detector (`src/treesitter/duplication.rs`) works in three steps:

### Step 1: Extract and Normalize Functions

For each file, the detector extracts all functions and normalizes their AST tokens:

{% mermaid() %}
graph LR
    SRC[Source Code] --> AST[Parse to AST]
    AST --> TOKENS[Extract Tokens]
    TOKENS --> NORM[Normalize]

    subgraph "Normalization"
        NORM --> ID[Identifiers → Hash]
        NORM --> STR[Strings → STRING_LIT]
        NORM --> NUM[Numbers → NUMBER_LIT]
        NORM --> KEY[Keywords → Keep]
    end

    NORM --> HASH[Token Hash]
{% end %}

The normalization rules:
- **Identifiers** are replaced with a hash of their name. Two functions that differ only in variable names will produce the same token sequence.
- **String literals** are replaced with `STRING_LIT`. Two functions that differ only in hardcoded strings will match.
- **Numeric literals** are replaced with `NUMBER_LIT`.
- **Keywords and operators** are kept as-is — they represent structure, not naming.

### Step 2: Exact Duplicate Detection

After normalization, each function is represented as a hash of its token sequence. Functions with identical hashes are exact duplicates (after normalization):

```rust
// Conceptual: group functions by their normalized hash
let mut hash_groups: HashMap<u64, Vec<&FunctionInfo>> = HashMap::new();
for func in &functions {
    hash_groups.entry(func.token_hash).or_default().push(func);
}
// Groups with >1 member are exact duplicates
```

This is O(n) — linear in the number of functions. Hash collisions are possible but extremely rare with 64-bit hashes.

### Step 3: Near-Duplicate Detection with Jaccard Similarity

Exact duplicates are easy. Near-duplicates require a similarity metric. garbage-code-hunter uses **Jaccard similarity on token bigrams** (`src/treesitter/duplication.rs:275-343`):

{% mermaid() %}
graph LR
    F1[Function A<br/>token bigrams] --> JACC[Jaccard<br/>Similarity]
    F2[Function B<br/>token bigrams] --> JACC
    JACC --> |">= 0.95"| MATCH[Near Duplicate]
    JACC --> |"< 0.95"| SKIP[Different]
{% end %}

The algorithm:

1. **Extract bigrams** from the normalized token sequence. For tokens `[A, B, C, D]`, the bigrams are `{AB, BC, CD}`.

2. **Compute Jaccard similarity**: `|A ∩ B| / |A ∪ B|`. This measures how much the two token sequences overlap.

3. **Apply thresholds**:
   - Jaccard similarity >= **0.95** (95% overlap)
   - Minimum **20 bigrams** (prevents tiny functions from matching)
   - Type-set overlap >= **0.85** (85% of token types must be shared)

Why three thresholds? Each one catches a different failure mode:
- Jaccard alone: two 3-line functions with 2 shared tokens score 0.67 — false positive
- Bigram count alone: a 2-token function matches everything — noise
- Type-set overlap: catches cases where Jaccard is high only because of common tokens like `return` and `if`

## Intra-File Duplication: Chunk Hashing

Within a single file, duplication takes a different form: repeated code blocks that are typically 5-20 lines long. The intra-file detector uses a **sliding window approach**:

### The Algorithm

{% mermaid() %}
graph TB
    FILE[Source File] --> SPLIT[Split into<br/>5-line chunks]
    SPLIT --> NORM[Normalize each chunk<br/>strip comments, structure]
    NORM --> HASH[Hash each chunk]
    HASH --> GROUP[Group by hash]
    GROUP --> FILTER[Filter: appears 2+ times<br/>with spacing]
    FILTER --> DUPS[Duplicated Blocks]
{% end %}

1. **Split** the file into overlapping 5-line chunks
2. **Normalize** each chunk:
   - Strip comment lines
   - Strip structural-only lines (braces, blank lines)
   - Keep only "content" lines
3. **Hash** each normalized chunk
4. **Group** chunks by hash
5. **Filter**: keep only chunks that appear 2+ times with at least one non-matching line between them

### Why 5 Lines?

The chunk size is a tradeoff:
- **3 lines**: too many false positives — `if err != nil { return err }` appears everywhere in Go
- **10 lines**: too few detections — small duplicated blocks are missed
- **5 lines**: captures the most common duplication patterns (error handling, boilerplate, repeated logic)

### Normalization Matters

Without normalization, these two chunks would not match:

```go
// Chunk A
userName := getUser(id)
if userName == "" {
    return errors.New("not found")
}
processUser(userName)
```

```go
// Chunk B
orderID := getOrder(id)
if orderID == "" {
    return errors.New("not found")
}
processOrder(orderID)
```

After normalization (identifiers hashed, strings replaced):

```
IDENT == ""
return STRING_LIT
processIDENT(IDENT)
```

They match — because the **structure** is identical, even though the **names** are different.

## The DuplicationDetector

Both approaches feed into the `DuplicationDetector` (`src/detectors.rs`), which implements `SignalDetector`:

```rust
impl SignalDetector for DuplicationDetector {
    fn signal(&self) -> StyleSignal {
        StyleSignal::Duplication
    }

    fn count_violations(&self, file: &ParsedFile) -> usize {
        // Cross-file: counted globally by CrossFileDupDetector
        // Intra-file: counted per file by IntraFileDupDetector
        IntraFileDupDetector::check(file).len()
    }
}
```

The cross-file detector runs in Phase 2 (before per-file signal detection) because it needs to see all files at once. The intra-file detector runs in Phase 3.

## Performance Considerations

Comparing every pair of functions is O(n^2) — unacceptable for large codebases. garbage-code-hunter reduces this to near-linear:

1. **Hash grouping** for exact duplicates: O(n)
2. **Bigram indexing** for near-duplicates: only functions with similar bigram-set sizes are compared
3. **Early termination**: if the type-set overlap is below 85%, skip the Jaccard computation

For a codebase with 10,000 functions, the typical comparison count is under 100,000 — not 50,000,000.

## Threshold Tuning

The thresholds (95% Jaccard, 20 bigrams, 85% type-set) were chosen to minimize false positives while catching real duplication:

| Threshold | Too Low | Too High |
|-----------|---------|----------|
| Jaccard (0.95) | Catches unrelated functions with shared tokens | Misses functions that differ in 10% of tokens |
| Bigrams (20) | Matches trivially small functions | Misses short but meaningful duplicates |
| Type-set (0.85) | Matches functions with same keywords but different logic | Misses functions with different structure |

These are configurable in `.garbage-code-hunter.toml` under the `[rules.duplication]` section.

---

*Next: [The Scoring Model](./07-scoring-model.md) — How to turn 10 signal scores into a single number between 0 and 100, and why logarithmic scaling is the right choice.*
