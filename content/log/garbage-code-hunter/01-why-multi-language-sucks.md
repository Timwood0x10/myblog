+++
title = "Why Multi-Language Code Quality Analysis Is Hard"
date = 2026-05-27
description = "You have a monorepo with Rust services, a Go gateway, Python ML pipelines, a TypeScript frontend, and Java Android code. Your CTO wants one dashboard for code quality. What do you do?"
weight = 33
[taxonomies]
tags = ["Rust", "Code Quality", "Static Analysis"]
series = ["garbage-code-hunter"]
[extra]
series = "garbage-code-hunter"
+++

# Why Multi-Language Code Quality Analysis Is Hard

> **Problem**: You have a monorepo with Rust services, a Go gateway, Python ML pipelines, a TypeScript frontend, and Java Android code. Your CTO wants "one dashboard for code quality." What do you do?

## The Landscape of Pain

Here is what the real world looks like:

| Language | Linter | Config Format | AST Library | Rule Language |
|----------|---------|---------------|-------------|---------------|
| Rust | Clippy | TOML | `syn` | Rust macros |
| Go | `golangci-lint` | YAML | `go/ast` | Go plugins |
| Python | Ruff / Pylint | TOML / INI | `libcst` / `ast` | Python |
| JavaScript | ESLint | JS/JSON/YAML | `acorn` / `espree` | JavaScript |
| TypeScript | ESLint + TSC | JS/JSON/YAML | `typescript` | JavaScript |
| Java | SpotBugs / PMD | XML | Eclipse JDT | Java / XPath |
| C | cppcheck | CLI flags | Custom | Custom |
| C++ | clang-tidy | YAML | Clang AST | Custom |
| Ruby | RuboCop | YAML | `parser` gem | Ruby |
| Swift | SwiftLint | YAML | SourceKit | Swift |
| Zig | `zig fmt` | — | Self-hosted | — |

Each tool has its own:
- Installation method
- Configuration format
- Rule definition language
- AST representation
- CI integration pattern
- Output format

If you want to analyze all 11 languages, you are not building a tool. You are building an **integration layer** over 11 tools, each with its own release cycle, breaking changes, and opinionated defaults.

## The Three Approaches (and Why They Fail)

### Approach 1: Run All Linters, Aggregate Results

```bash
cargo clippy --message-format=json > rust.json
golangci-lint run --out-format=json > go.json
ruff check --output-format=json > python.json
eslint --format=json > js.json
# ... 7 more
```

**Problems**:
- 11 tools to install, configure, and keep updated
- Incompatible output schemas — one tool's "warning" is another's "info"
- No cross-language signals (e.g., "this Go function and this Rust function are identical")
- Each tool has different opinions about what constitutes a "violation"
- CI setup becomes a YAML novel

### Approach 2: Write a Custom Parser per Language

Roll your own AST for each language. Full control, unified interface.

**Problems**:
- Each language grammar takes months to implement correctly
- Grammars evolve — you are now maintaining 11 parsers
- Edge cases in parsing (string interpolation, macros, preprocessor directives) will consume your life
- You are essentially rebuilding compiler frontends for fun

### Approach 3: Use a Single Parser Framework

This is what garbage-code-hunter does. But which framework?

## Why Tree-sitter?

Tree-sitter is an incremental parsing library designed for syntax highlighting in editors. It has compiled grammars for 100+ languages. But more importantly:

1. **One API, many languages.** `tree_sitter_rust()`, `tree_sitter_go()`, `tree_sitter_python()` all return the same `Language` type with the same query API.

2. **Query-based extraction.** Instead of walking the AST manually, you write declarative patterns:
   ```scheme
   (call_expression
     function: (identifier) @fn
     (#match? @fn "^(panic|unwrap|expect)$"))
   ```
   This is the same query language for every language.

3. **Speed.** Tree-sitter parses most files in under 10ms. It is designed for real-time editing — batch analysis is trivially fast.

4. **Incremental.** If you need to re-parse after an edit, only the changed region is re-parsed. This matters for LSP integration.

But tree-sitter alone is not enough. It gives you syntax, not semantics. You still need to answer questions like:

- "Is this `unwrap()` call in a test file?"
- "Is this function more than 50 lines?"
- "Are these two code blocks duplicated?"

This is where the architecture gets interesting.

## The Real Challenge: Language-Specific vs. Language-Neutral

Consider the simple question: "Is this code using debug print statements?"

| Language | Debug Patterns |
|----------|---------------|
| Rust | `println!`, `dbg!`, `eprintln!` |
| Go | `fmt.Println`, `log.Println`, `println` |
| Python | `print()`, `pprint()` |
| Java | `System.out.println`, `System.err.println` |
| JavaScript | `console.log`, `console.warn`, `console.error` |
| Ruby | `puts`, `p `, `pp ` |
| Swift | `print()`, `debugPrint()`, `dump()` |
| Zig | `std.debug.print` |
| C | `printf`, `fprintf(stderr, ...)` |
| C++ | `std::cout`, `std::cerr`, `printf` |

Each language has its own set of patterns. But the **concept** — "debug output that should not be in production code" — is language-neutral.

This is the fundamental tension:

{% mermaid() %}
graph LR
    A[Language-Specific<br/>AST Details] --> B[???]
    B --> C[Language-Neutral<br/>Quality Signals]
{% end %}

How do you bridge this gap? Two options:

**Option A: Each detector handles all languages.** Your `DebugPrintDetector` has a match statement for 11 languages. When you add language #12, you update every detector. This is O(detectors x languages).

**Option B: Each language adapter produces a common output.** Your `RustAdapter` knows that `println!` is a debug call. Your `GoAdapter` knows that `fmt.Println` is a debug call. Both emit the same counter: `debug_call_count`. Detectors never see the language. This is O(detectors + languages).

garbage-code-hunter chose Option B.

## The Architecture That Emerges

Once you commit to Option B, the architecture becomes clear:

{% mermaid() %}
graph TB
    subgraph PL["Per-Language (O(languages))"]
        RA[RustAdapter]
        GA[GoAdapter]
        PA[PythonAdapter]
        VA[...11 adapters]
    end

    subgraph LN["Language-Neutral (O(1))"]
        IR[StyleIR]
        DD[DebugPrintDetector]
        ND[NamingDetector]
        PD[PanicDetector]
        SD[...10 detectors]
    end

    RA --> |debug_call_count| IR
    GA --> |debug_call_count| IR
    PA --> |debug_call_count| IR
    VA --> |debug_call_count| IR
    IR --> DD
    IR --> ND
    IR --> PD
    IR --> SD
{% end %}

The key insight: **adapters are the complexity sink.** They absorb all language-specific knowledge so that detectors can be simple.

This is the pattern that the rest of this series explores in depth:

- **Article 03** dives into the `LanguageAdapter` trait and how tree-sitter queries are batched
- **Article 04** explains `StyleIR` — the language-neutral fact layer
- **Article 05** shows how `SignalDetector` implementations consume StyleIR without knowing the language

## What This Buys You

The O(detectors + languages) scaling is not just theoretical. When garbage-code-hunter added Zig support, the changes were:

1. Add `ZigAdapter` implementing `LanguageAdapter` (~200 lines)
2. Add `Language::Zig` variant and extension mapping
3. Add `tree_sitter_zig` to dependencies

Zero detectors were modified. Zero scoring logic changed. Zero configuration updates needed.

When a new detector is added (say, `MagicNumberDetector`), it works across all 11 languages immediately — because it reads `StyleIr.magic_number_count`, which every adapter already computes.

This is the payoff of the adapter pattern: **decoupling that actually scales.**

---

*Next: [Architecture Overview](@/log/garbage-code-hunter/02-architecture-overview.md) — How the four-phase pipeline works, and why the module boundaries are drawn where they are.*
