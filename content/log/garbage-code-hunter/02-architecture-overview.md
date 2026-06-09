+++
title = "Architecture Overview: How to Structure a Multi-Language Code Analyzer"
date = 2026-05-27
description = "A code analyzer that needs to parse files, detect issues, compute scores, and generate reports must support 11 languages, run in CI, and finish in seconds. How do you structure it?"
weight = 34
[taxonomies]
tags = ["Rust", "Code Quality", "Static Analysis"]
series = ["garbage-code-hunter"]
[extra]
series = "garbage-code-hunter"
+++

# Architecture Overview

> **Question**: You have a code analyzer that needs to parse files, detect issues, compute scores, and generate reports. It must support 11 languages, run in CI, and finish in seconds. How do you structure it?

## The Four-Phase Pipeline

Most code analysis tools follow a linear pipeline: parse, analyze, report. garbage-code-hunter adds a twist — it separates **duplication detection** from **signal detection** because they operate at different granularities:

{% mermaid() %}
graph LR
    P1[Phase 1<br/>Parse] --> P2[Phase 2<br/>Cross-File<br/>Duplication]
    P2 --> P3[Phase 3<br/>Intra-File<br/>Duplication]
    P3 --> P4[Phase 4<br/>Signal<br/>Detection]
{% end %}

Here is how it works in the actual source code (`src/analyzer.rs:174-275`):

### Phase 1: Parse

Walk the directory tree, filter by supported extensions, parse each file with tree-sitter:

```rust
// src/analyzer.rs:183-200
for file_path in &files {
    if Self::is_generated_file(file_path) {
        continue;
    }
    let content = match fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(_) => continue,
    };
    let lang = Language::from_path(file_path);
    if lang == Language::Unknown {
        continue;
    }
    if let Some(parsed) = self.ts_engine.parse_file(file_path, &content) {
        parsed_files.push((parsed, file_path.clone(), is_test_file));
    }
}
```

Key design decision: **parsed files are cached** in a `Vec<(ParsedFile, PathBuf, bool)>` so phases 2-4 do not re-parse. The `bool` tracks whether the file is a test file.

### Phase 2: Cross-File Duplication

Fingerprint every function across the entire codebase. Find exact duplicates by hash grouping, near-duplicates by Jaccard similarity:

```rust
// src/analyzer.rs:202-212
*self.cross_detector.borrow_mut() = CrossFileDupDetector::new();
for (parsed, _, is_test) in &parsed_files {
    self.cross_detector.borrow_mut().process_file(parsed);
}
issues.extend(self.cross_detector.borrow().find_duplicates());
issues.extend(self.cross_detector.borrow().find_near_duplicates());
```

This phase needs to see **all files at once** — which is why it runs before per-file signal detection.

### Phase 3: Intra-File Duplication

Find repeated code blocks within a single file using 5-line chunk hashing:

```rust
// src/analyzer.rs:215-220
for (parsed, _, is_test) in &parsed_files {
    issues.extend(IntraFileDupDetector::check(parsed));
}
```

### Phase 4: Signal Detection

Run all 10 detectors against each file. If a pre-computed `StyleIR` exists, use it to avoid redundant computation:

```rust
// src/analyzer.rs:239-271
for (parsed, file_path, is_test_file) in &parsed_files {
    let ir = StyleIr::from_parsed(parsed);
    for detector in &self.detectors {
        if !detector.supported_languages().contains(&lang) {
            continue;
        }
        let findings_iter = if let Some(ref ir) = ir {
            detector.detect_findings_with_ir(ir, parsed, *is_test_file, skip_tests_config)
        } else {
            detector.detect_findings(parsed, *is_test_file, skip_tests_config)
        };
        for (signal, count) in findings_iter {
            // Test files get 20% weight
            let count = if *is_test_file {
                (count as f64 * 0.2).round() as usize
            } else { count };
            findings.push(StyleFinding::for_signal(signal, count, file_path.clone()));
        }
    }
}
```

Notice the test file downweighting: violations in test code count as 20% of their actual value. This prevents test helpers from inflating scores.

## Module Map

The project is organized as a library + binary:

{% mermaid() %}
graph TB
    subgraph BIN["Binary (main.rs)"]
        CLI[CLI Parser<br/>clap]
        SCAN[scan<br/>14 tools in parallel]
        ANALYZE[analyze<br/>4-phase pipeline]
    end

    subgraph LIB["Library (lib.rs)"]
        A[analyzer]
        TS[treesitter]
        LANG[language]
        SIG[signals]
        IR[style_ir]
        DET[detectors]
        DUP[duplication]
        SCORE[scoring]
        FIND[finding]
        REPORT[reporter]
        CONFIG[config]
        I18N[i18n]
        LLM[llm]
    end

    subgraph ADAPT["Language Adapters"]
        RA[rust.rs]
        GA[go.rs]
        PA[python.rs]
        TA[ts.rs]
        JA[java.rs]
        CA[c.rs]
        CPA[cpp.rs]
        SA[swift.rs]
        ZA[zig.rs]
        RBA[ruby.rs]
        JSA[js.rs]
    end

    CLI --> SCAN
    CLI --> ANALYZE
    ANALYZE --> A
    A --> TS
    A --> LANG
    A --> SIG
    A --> IR
    A --> DET
    A --> DUP
    A --> SCORE
    A --> FIND
    SCAN --> REPORT
    REPORT --> CONFIG
    REPORT --> I18N
    REPORT --> LLM
    LANG --> RA
    LANG --> GA
    LANG --> PA
    LANG --> TA
    LANG --> JA
    LANG --> CA
    LANG --> CPA
    LANG --> SA
    LANG --> ZA
    LANG --> RBA
    LANG --> JSA
{% end %}

### Key Modules

| Module | Responsibility | Key Type |
|--------|---------------|----------|
| `analyzer` | Orchestrates the 4-phase pipeline | `CodeAnalyzer` |
| `treesitter` | Parser management, query execution, duplication | `TreeSitterEngine` |
| `language` | Language enum + per-language adapters | `LanguageAdapter` trait |
| `style_ir` | Language-neutral fact extraction | `StyleIr` |
| `signals` | Signal definitions, scoring helpers, personality | `SignalDetector` trait |
| `detectors` | 10 concrete detector implementations | `PanicAddictionDetector`, etc. |
| `scoring` | Two-tier log scoring model | `CodeScorer` |
| `finding` | Structured finding model | `StyleFinding` |
| `reporter` | Terminal/Markdown/JSON output | `Reporter` |
| `config` | App + project configuration | `AppConfig`, `ProjectConfig` |
| `llm` | LLM-powered roast generation | `RoastProvider` |

## The Dual Command Model

garbage-code-hunter has two main execution modes:

### `analyze` — Deep Code Analysis

Runs the 4-phase pipeline, produces detailed findings with line numbers and evidence. This is the primary mode.

### `scan` — Full Project Health Check

Runs **all 14 tools in parallel** using `std::thread::scope`:

```rust
// src/main.rs:153-436 (conceptual)
std::thread::scope(|s| {
    s.spawn(|| commit_roaster::run());
    s.spawn(|| deps_shamer::run());
    s.spawn(|| pr_title_hunter::run());
    s.spawn(|| debt_invoice::run());
    // ... 10 more tools
});
```

Each tool runs independently and produces its own score. The final report aggregates all scores into a combined project health metric.

## Data Flow: From Source File to Report

{% mermaid() %}
sequenceDiagram
    participant CLI
    participant Analyzer
    participant TreeSitter
    participant Adapter
    participant StyleIR
    participant Detector
    participant Scorer
    participant Reporter

    CLI->>Analyzer: analyze(path)
    Analyzer->>TreeSitter: parse_file(path, content)
    TreeSitter-->>Analyzer: ParsedFile (AST + source)

    Note over Analyzer: Phase 2-3: Duplication detection

    Analyzer->>StyleIR: from_parsed(parsed)
    StyleIR->>Adapter: compute_all(file)
    Adapter->>Adapter: batch_captures() — single AST traversal
    Adapter-->>StyleIR: AdapterCounts
    StyleIR-->>Analyzer: StyleIr { counts, functions }

    Analyzer->>Detector: detect_findings_with_ir(ir, file)
    Detector->>Detector: read ir.panic_call_count (etc.)
    Detector-->>Analyzer: Vec<(signal, count)>

    Analyzer->>Scorer: calculate_score(findings)
    Scorer-->>Analyzer: CodeQualityScore

    Analyzer->>Reporter: report(score, findings)
    Reporter-->>CLI: Formatted output
{% end %}

The key insight in this flow: **StyleIR is computed once, consumed by many detectors.** This is the O(detectors + languages) scaling from Article 01 in action.

## Test File Handling

One detail that deserves attention: test file awareness is baked into the architecture at multiple levels:

1. **File identification**: `is_test_file()` checks path patterns like `test/`, `tests/`, `_test.go`, `Test.java`
2. **Rust-specific**: `#[cfg(test)]` module byte ranges are detected and panics inside them are excluded (`src/language/adapter/rust.rs:16-46`)
3. **Detector level**: `SignalDetector::skips_test_files()` returns `true` by default — detectors opt-in to test file analysis
4. **Scoring level**: Test file violations are multiplied by 0.2 (`src/analyzer.rs:257-260`)
5. **Config level**: Users can set `signals.skip_tests = true` in `.garbage-code-hunter.toml`

This layered approach means test code is neither fully ignored nor fully counted — it is proportionally reduced.

## Configuration Discovery

{% mermaid() %}
graph TD
    A[Working Directory] --> B{.garbage-code-hunter.toml<br/>exists?}
    B -->|Yes| C[Load project config]
    B -->|No| D[Walk up to parent]
    D --> B

    E[Config File] --> F{./config.toml<br/>exists?}
    F -->|Yes| G[Load app config]
    F -->|No| H{~/.config/garbage-code-hunter/<br/>config.toml exists?}
    H -->|Yes| G
    H -->|No| I[Use defaults]
{% end %}

Two independent config systems:
- **ProjectConfig** (`.garbage-code-hunter.toml`): Per-project rules, whitelists, overrides. Lives in the repo.
- **AppConfig** (`config.toml`): Global settings — LLM mode, language preferences. Lives in user's home or project root.

---

*Next: [Tree-sitter and the LanguageAdapter Pattern](@/log/garbage-code-hunter/03-treesitter-and-language-adapter.md) — How 11 language adapters share a single tree-sitter query engine, and why `compute_all()` matters.*
