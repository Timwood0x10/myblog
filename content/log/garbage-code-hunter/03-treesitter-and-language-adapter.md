+++
title = "Tree-sitter and the LanguageAdapter Pattern"
date = 2026-05-27
description = "You need to detect debug print statements in 11 languages. Each language has different syntax, different function names, and different conventions. Do you write 11 separate detection functions, or is there a better way?"
weight = 35
[taxonomies]
tags = ["Rust", "Code Quality", "Static Analysis"]
series = ["garbage-code-hunter"]
[extra]
series = "garbage-code-hunter"
+++

# Tree-sitter and the LanguageAdapter Pattern

> **Question**: You need to detect "debug print statements" in 11 languages. Each language has different syntax, different function names, and different conventions. Do you write 11 separate detection functions, or is there a better way?

## The Naive Approach: 11 Detectors

The most direct solution is to write a `DebugPrintDetector` that has a match statement for each language:

```rust
fn count_debug_calls(&self, file: &ParsedFile) -> usize {
    match file.language {
        Language::Rust => count_rust_debug(file),    // println!, dbg!
        Language::Go => count_go_debug(file),         // fmt.Println
        Language::Python => count_python_debug(file), // print()
        Language::Java => count_java_debug(file),     // System.out.println
        // ... 7 more
    }
}
```

This works, but it has a scaling problem. When you add `MagicNumberDetector`, `NamingDetector`, and 7 more detectors, each one needs the same 11-way match. You now have O(detectors x languages) code paths, and each one is a potential bug.

## The Adapter Pattern: Absorb Language Complexity

garbage-code-hunter inverts the dependency. Instead of detectors knowing about languages, **language adapters know about detections**.

The `LanguageAdapter` trait (`src/language/adapter/mod.rs:78-137`) defines a contract: every language must report its own counts for each quality dimension:

```rust
pub trait LanguageAdapter: Send + Sync {
    fn language(&self) -> Language;
    fn count_panic_calls(&self, file: &ParsedFile) -> usize;
    fn extract_functions(&self, file: &ParsedFile) -> Vec<FunctionNode>;
    fn count_naming_violations(&self, file: &ParsedFile) -> usize;
    fn count_deeply_nested_blocks(&self, &ParsedFile) -> usize;
    fn count_debug_calls(&self, file: &ParsedFile) -> usize;
    fn count_excessive_params(&self, file: &ParsedFile, threshold: usize) -> usize;
    fn count_unsafe_blocks(&self, file: &ParsedFile) -> usize { 0 }
    fn count_magic_numbers(&self, file: &ParsedFile) -> usize { 0 }
    fn count_goroutine_spawns(&self, file: &ParsedFile) -> usize { 0 }  // Go-specific
    fn count_defer_in_loop(&self, file: &ParsedFile) -> usize { 0 }     // Go-specific
    fn count_go_convention_violations(&self, file: &ParsedFile) -> usize { 0 }
    fn count_python_issues(&self, file: &ParsedFile) -> usize { 0 }
    fn count_java_issues(&self, file: &ParsedFile) -> usize { 0 }
    // ... language-specific methods with default no-op implementations
}
```

Notice the pattern: **common methods** (`count_panic_calls`, `count_debug_calls`) are required. **Language-specific methods** (`count_goroutine_spawns`, `count_python_issues`) have default no-op implementations that only the relevant adapter overrides.

## How Adapters Use Tree-sitter Queries

Each adapter defines a set of tree-sitter query patterns. Here is the GoAdapter (`src/language/adapter/go.rs:14-40`):

```rust
const GO_PATTERNS: &[&str] = &[
    // pc_ — panic calls
    "(call_expression function: (identifier) @pc_fn (#eq? @pc_fn \"panic\"))",
    // ex_ — extract functions
    "[(function_declaration name: (identifier) @ex_name)
      (method_declaration name: (field_identifier) @ex_name)] @ex_fn",
    // nv_ — naming violations
    "[(short_var_declaration left: (expression_list (identifier) @nv_var))
      (var_spec name: (identifier) @nv_var)]",
    // dp_ — debug calls
    r#"(call_expression
      function: (selector_expression
        operand: (identifier) @dp_pkg
        field: (field_identifier) @dp_method)
      (#match? @dp_pkg "^(fmt|log)$")
      (#match? @dp_method "^(Print|Println|Printf|Fprint|Fprintln|Fprintf)$"))"#,
    // ep_ — excessive params
    "[(function_declaration parameters: (parameter_list) @ep_params)
      (method_declaration parameters: (parameter_list) @ep_params)]",
    // mn_ — magic numbers
    "[(int_literal) @mn_num (float_literal) @mn_num]",
    // gs_ — goroutine spawns
    "(go_statement) @gs_go",
    // cv_ — convention violations
    r#"(call_expression function: (selector_expression
      operand: (identifier) @cv_pkg field: (field_identifier) @cv_method)
      (#eq? @cv_pkg "fmt")
      (#match? @cv_method "^(Errorf|New)$"))"#,
    // ui_ — unsafe operations
    r#"(selector_expression operand: (identifier) @ui_pkg (#eq? @ui_pkg "unsafe"))"#,
];
```

The naming convention is critical: each capture name is prefixed with a **2-letter code** (`pc_`, `ex_`, `dp_`, `mn_`) that identifies which counting function should process it. This allows all patterns to be merged into a single query string.

## The Batch Query Optimization

Here is where the architecture gets clever. Instead of running each pattern separately (10 AST traversals per file), `batch_captures()` merges all patterns and runs them in **one pass**:

{% mermaid() %}
graph LR
    subgraph "Naive: 10 traversals"
        T1[Pattern 1] --> AST1[AST Walk 1]
        T2[Pattern 2] --> AST2[AST Walk 2]
        T3[...] --> AST3[AST Walk ...]
        T10[Pattern 10] --> AST10[AST Walk 10]
    end

    subgraph "Batch: 1 traversal"
        BM[All Patterns<br/>Merged] --> BAST[Single<br/>AST Walk]
        BAST --> BC[Vec of<br/>Capture Groups]
    end
{% end %}

The implementation (`src/language/adapter/mod.rs:265-271`):

```rust
fn batch_captures<'a>(&self, file: &'a ParsedFile) -> Vec<Vec<QueryCapture<'a>>> {
    let patterns = self.query_patterns();
    if patterns.is_empty() {
        return Vec::new();
    }
    collect_captures_multi(file, patterns).unwrap_or_default()
}
```

And `compute_all()` (`src/language/adapter/mod.rs:278-304`) is the single entry point that calls `batch_captures()` once and distributes results:

```rust
fn compute_all(&self, file: &ParsedFile) -> AdapterCounts {
    let batch = self.batch_captures(file);
    AdapterCounts {
        functions: self.extract_functions_from_batch(file, &batch),
        panic_calls: self.count_panic_from_batch(file, &batch),
        naming_violations: self.count_naming_from_batch(file, &batch),
        deeply_nested_blocks: self.count_deeply_nested_blocks(file),
        debug_calls: self.count_debug_from_batch(file, &batch),
        excessive_params: self.count_excessive_from_batch(file, &batch),
        unsafe_blocks: self.count_unsafe_from_batch(file, &batch),
        magic_numbers: self.count_magic_from_batch(file, &batch),
        goroutine_spawns: self.count_goroutine_from_batch(file, &batch),
        defer_in_loop: self.count_defer_in_loop(file),
        go_conventions: self.count_go_convention_from_batch(file, &batch),
        python_issues: self.count_python_from_batch(file, &batch),
        java_issues: self.count_java_from_batch(file, &batch),
        ruby_issues: self.count_ruby_from_batch(file, &batch),
        c_issues: self.count_c_from_batch(file, &batch),
        ts_issues: self.count_ts_from_batch(file, &batch),
        js_issues: self.count_js_from_batch(file, &batch),
        swift_issues: self.count_swift_from_batch(file, &batch),
        dead_code: self.count_dead_code(file),
        duplicate_imports: self.count_duplicate_imports(file),
        // ...
    }
}
```

The result is an `AdapterCounts` struct — a flat bag of numbers that knows nothing about which language produced them.

## Thread-Local Query Cache

Tree-sitter queries must be compiled before execution. Compilation is not free — it involves regex compilation and pattern analysis. To avoid recompiling the same query on every file, garbage-code-hunter uses a thread-local cache (`src/treesitter/query.rs:64-67`):

```rust
thread_local! {
    static QUERY_CACHE: RefCell<HashMap<(Language, String), tree_sitter::Query>> =
        RefCell::new(HashMap::new());
}
```

The key is `(Language, String)` — the language and the query pattern string. The first time a pattern is used for a language, it is compiled and cached. Subsequent calls reuse the compiled query.

This is thread-local rather than shared because tree-sitter `Query` is not `Send`. Each thread gets its own cache, which avoids lock contention in the parallel `scan` mode.

## The Full Call Flow

{% mermaid() %}
sequenceDiagram
    participant IR as StyleIR
    participant Adapter as LanguageAdapter
    participant Cache as Thread-Local Cache
    participant TS as Tree-sitter

    IR->>Adapter: compute_all(file)
    Adapter->>Adapter: query_patterns() → all patterns
    Adapter->>Adapter: batch_captures(file)

    loop For each pattern
        Adapter->>Cache: get(language, pattern)
        Cache-->>Adapter: compiled Query (or compile + cache)
    end

    Adapter->>TS: run merged query on AST
    TS-->>Adapter: Vec of capture groups

    Adapter->>Adapter: count_*_from_batch() for each signal
    Adapter-->>IR: AdapterCounts { all counts }
{% end %}

## Adding a New Language: The Checklist

When someone adds Zig support to garbage-code-hunter, here is exactly what they do:

1. **Add the grammar dependency** in `Cargo.toml`:
   ```toml
   tree-sitter-zig = "0.7"
   ```

2. **Register the parser** in `src/treesitter/parsers.rs`:
   ```rust
   Language::Zig => tree_sitter_zig::LANGUAGE.into(),
   ```

3. **Add the language variant** in `src/language/mod.rs`:
   ```rust
   Zig => "zig",
   ```

4. **Implement the adapter** in `src/language/adapter/zig.rs` (~200 lines):
   - Define `ZIG_PATTERNS` with prefixed capture names
   - Implement `LanguageAdapter` for `ZigAdapter`
   - Override the counting methods to process captures

5. **Register the adapter** in `src/language/adapter/mod.rs`:
   ```rust
   Language::Zig => Some(&ZigAdapter),
   ```

**Zero detectors modified. Zero scoring logic changed.** The new language immediately works with all 10 detectors because they read from `StyleIr`, not from language-specific ASTs.

## Design Tradeoffs

This adapter pattern has clear advantages, but also tradeoffs:

**Advantage**: O(detectors + languages) scaling. Adding a detector works for all languages. Adding a language works with all detectors.

**Tradeoff**: The adapter must pre-compute everything a detector might need. If a new detector needs a signal the adapter does not compute, you must update the adapter trait AND all 11 implementations. In practice, this happens rarely — the current trait covers all signals used by the 10 detectors.

**Tradeoff**: Language-specific features (Go goroutines, Rust unsafe blocks, Python decorators) require dedicated methods on the trait. The trait grows as language diversity increases. The default no-op implementations mitigate this — only the relevant adapter overrides each method.

---

*Next: [StyleIR: The Language-Neutral Intermediate Representation](@/log/garbage-code-hunter/04-style-ir-the-neutral-layer.md) — How adapter counts become a stable fact layer that detectors consume without knowing the language.*
