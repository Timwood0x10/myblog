+++
title = "OmniScope-rs 07: FFI Boundary Detection — VTable Pattern vs. Trait Objects"
date = 2026-06-16
description = "Part 7 of the OmniScope-rs series: how Zig and Rust detect which functions cross language boundaries, using VTables and trait objects."
weight = 7
[taxonomies]
tags = ["Rust", "Zig", "FFI", "Language Detection", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 7: FFI Boundary Detection — VTable Pattern vs. Trait Objects

## The Last Frontier

We've covered how OmniScope loads IR, tracks resources, models ownership, builds contract graphs, and analyzes paths. But there's one more problem that's central to OmniScope's mission:

> How do you know when a function crosses a language boundary?

This is the heart of cross-language FFI security analysis. If we can't detect FFI boundaries, we can't find cross-language bugs.

Consider this LLVM IR:

```llvm
; A call to Python's C API
%result = call i32 @PyObject_GetItem(ptr %obj, ptr %key)

; A call to C's standard library
%buf = call ptr @malloc(i64 100)

; A call through cgo
call void @_cgo_runtime_cgocall(ptr @C.free, ptr %args)
```

Each of these calls crosses a language boundary. But how does the analyzer know that `PyObject_GetItem` is a Python call, that `malloc` is a C call, and that `_cgo_runtime_cgocall` is a Go call?

And more importantly: **how does the analyzer know what each call means for resource ownership**? Does `PyObject_GetItem` return a borrowed reference or a new reference? Does `malloc` allocate memory that must be freed? Does `_cgo_runtime_cgocall` transfer ownership?

---

## Think About It

How would you detect FFI boundaries in LLVM IR?

You have several signals to work with:

1. **Linkage**: Is a function declared (extern) or defined? If it's declared and has C linkage, it's an FFI boundary.
2. **Name patterns**: Does the function name follow a known convention? `Py*` for Python, `Java_*` for JNI, `_cgo_*` for Go cgo.
3. **Debug info**: LLVM debug metadata might tell you what language a function was compiled from (DW_AT_language).
4. **Call graph**: If a Rust function calls a C function, that call crosses an FFI boundary.
5. **Mangling**: C++ Itanium ABI mangled names (`_Z*`) are a strong signal.
6. **Source path**: If the LLVM metadata shows the source file is `foo.py`, functions from that file are Python.

Once you've detected the FFI boundary, you need to understand the **semantics** of each FFI call. A Python C API adapter needs to know that `PyObject_New` allocates, `Py_DECREF` conditionally releases, and `PyObject_GetItem` returns a borrowed reference.

---

## Zig's Approach: VTable Pattern for Adapters

### The LanguageAdapter Interface

Zig doesn't have traits or interfaces. Instead, the language adapter system uses a **VTable pattern** — a struct of function pointers:

```zig
pub const AdapterVTable = struct {
    const AnalyzeFn = *const fn(
        self: *const LanguageAdapter,
        func: *anyopaque,
        ctx: ContextPtr,
        allocator: std.mem.Allocator,
    ) anyerror!AdapterAnalysis;

    const ClassifyFn = *const fn(
        self: *const LanguageAdapter,
        callee_name: []const u8,
    ) FFISemantics;

    const SuppressFn = *const fn(
        self: *const LanguageAdapter,
        func_name: []const u8,
    ) bool;

    const OwningPatternsFn = *const fn(
        self: *const LanguageAdapter,
    ) []const []const u8;

    const BorrowingPatternsFn = *const fn(
        self: *const LanguageAdapter,
    ) []const []const u8;

    analyzeFn: AnalyzeFn,
    classifyFn: ClassifyFn,
    suppressFn: SuppressFn,
    owningPatternsFn: OwningPatternsFn,
    borrowingPatternsFn: BorrowingPatternsFn,
};
```

Each adapter is a `LanguageAdapter` struct that bundles metadata with a VTable:

```zig
pub const LanguageAdapter = struct {
    name: []const u8,
    language: Language,
    memory_model: MemoryModel,
    vtable: AdapterVTable,

    pub fn analyzeFunction(self: *const LanguageAdapter, ...) !AdapterAnalysis {
        return self.vtable.analyzeFn(self, func, ctx, allocator);
    }

    pub fn classifyCall(self: *const LanguageAdapter, callee_name: []const u8) FFISemantics {
        return self.vtable.classifyFn(self, callee_name);
    }
};
```

### Default Implementations

Even without trait objects, Zig provides default implementations via a `Defaults` namespace:

```zig
pub const Defaults = struct {
    pub fn defaultAnalyze(self_ptr: *const LanguageAdapter, ...) anyerror!AdapterAnalysis {
        // Name-based classification: iterate call instructions in the function,
        // classify each callee using adapter-specific knowledge
        var result = try AdapterAnalysis.init(allocator, self_ptr.language);
        // ... iterate LLVM instructions, classify by callee name ...
        return result;
    }

    pub fn defaultClassify(...) FFISemantics {
        return .unknown;  // Conservative default
    }

    pub fn makeDefaultVTable() AdapterVTable {
        return .{
            .analyzeFn = defaultAnalyze,
            .classifyFn = defaultClassify,
            .suppressFn = defaultSuppress,
            .owningPatternsFn = defaultOwningPatterns,
            .borrowingPatternsFn = defaultBorrowingPatterns,
        };
    }
};
```

### Concrete Adapters

Each language adapter (~200 LOC) is a simple module that provides pattern tables and overrides specific VTable methods:

```zig
// cpp_adapter.zig
pub const C_ALLOCATORS = [_][]const u8{
    "malloc", "calloc", "realloc", "strdup", ...
};

pub const c_instance = LanguageAdapter{
    .name = "c_instance",
    .language = .c,
    .memory_model = .manual,
    .vtable = AdapterVTable{
        .analyzeFn = Defaults.defaultAnalyze,  // Use the default
        .classifyFn = cClassify,               // Custom classify
        .suppressFn = Defaults.defaultSuppress,
        .owningPatternsFn = cOwningPatterns,
        .borrowingPatternsFn = cBorrowingPatterns,
    },
};
```

### The FFIMatcher

The Zig version also has an `FFIMatcher` that matches function declarations (declares) across languages with their definitions:

```zig
pub const FFIMatch = struct {
    name: []const u8,
    declare_func: ?FunctionInfo,   // e.g., Rust declaration
    define_func: ?FunctionInfo,    // e.g., C definition
    is_complete: bool,
};
```

The matcher works by:
1. Extracting declares from one language's IR (e.g., Rust `extern "C"` blocks)
2. Extracting defines from another language's IR (e.g., C function definitions)
3. Matching by function name
4. Identifying cross-language FFI calls from the matches

### Language Detection

The language adapter system includes a `detectCalleeLanguage` helper that uses naming heuristics:

```zig
fn detectCalleeLanguage(callee_name: []const u8) Language {
    if (std.mem.startsWith(u8, callee_name, "Py") or
        std.mem.startsWith(u8, callee_name, "_Py"))
        return .python;

    if (std.mem.startsWith(u8, callee_name, "C.") or
        std.mem.startsWith(u8, callee_name, "_Cgo_"))
        return .go;

    if (std.mem.indexOf(u8, callee_name, "std::") != null or
        std.mem.startsWith(u8, callee_name, "_Z"))
        return .cpp;

    if (std.mem.startsWith(u8, callee_name, "Java_") or
        std.mem.startsWith(u8, callee_name, "JNI_"))
        return .java;

    return .c; // Default
}
```

---

## Rust's Approach: Trait Objects and Pass-Based Detection

### The Trait Object Pattern

The Rust version uses idiomatic Rust traits:

```rust
pub trait LanguageAdapter {
    fn analyze(&self, func: &Function, ctx: &AnalysisContext) -> Result<AdapterAnalysis>;
    fn classify_call(&self, callee_name: &str) -> FFISemantics;
    fn should_suppress(&self, func_name: &str) -> bool;
    fn owning_patterns(&self) -> Vec<&str>;
    fn borrowing_patterns(&self) -> Vec<&str>;
}
```

Concrete adapters implement the trait:

```rust
pub struct CAdapter;
pub struct CppAdapter;
pub struct PythonAdapter;
pub struct GoAdapter;
pub struct JavaAdapter;
pub struct CSharpAdapter;
pub struct RustAdapter;
pub struct NodeAdapter;
pub struct WasmAdapter;

impl LanguageAdapter for CAdapter {
    fn analyze(&self, func: &Function, ctx: &AnalysisContext) -> Result<AdapterAnalysis> {
        // C-specific analysis
    }

    fn classify_call(&self, callee_name: &str) -> FFISemantics {
        match callee_name {
            "malloc" | "calloc" | "realloc" => FFISemantics::Allocates,
            "free" => FFISemantics::Deallocates,
            _ => FFISemantics::Unknown,
        }
    }
}
```

Adapters are used via `dyn LanguageAdapter` trait objects:

```rust
let adapter: Box<dyn LanguageAdapter> = Box::new(CAdapter);
let result = adapter.analyze(&func, &ctx)?;
```

### The CSharpAdapter — A Deeper Example

The Rust version's `CSharpAdapter` comes with dedicated modules for different C# interop concerns:

```rust
pub mod dispose;    // IDisposable pattern
pub mod gc;         // .NET GC interaction
pub mod pinvoke;    // P/Invoke conventions

pub enum CSharpSemanticPattern {
    PInvokeCall,
    MarshalAllocation,     // Marshal.AllocHGlobal
    MarshalDeallocation,   // Marshal.FreeHGlobal
    GCHandleAllocation,    // GCHandle.Alloc (pinning)
    GCHandleDeallocation,
    SafeHandleUsage,
    IDisposablePattern,
}
```

### The FFIBoundaryDetector

The Rust version has a dedicated `FFIBoundaryDetector` that consolidates FFI detection:

```rust
pub struct FFIBoundaryDetector {
    detector: LanguageDetector,
}

impl FFIBoundaryDetector {
    pub fn detect_caller_lang(&self, caller: &str, caller_is_defined: bool) -> Language {
        let name = caller.trim_start_matches('@');
        let detected = self.detector.detect_from_function(name);
        if caller_is_defined && detected == Language::Unknown {
            Language::C  // C fallback for defined functions with unknown language
        } else {
            detected
        }
    }

    pub fn detect_callee_lang(&self, callee: &str) -> Language {
        let name = callee.trim_start_matches('@');
        self.detector.detect_from_function(name)
    }

    pub fn is_cross_language(&self, caller_lang: Language, callee_lang: Language) -> bool {
        caller_lang != Language::Unknown
            && callee_lang != Language::Unknown
            && caller_lang != callee_lang
    }
}
```

### The Pass-Based Pipeline

The Rust version structures FFI detection as a series of passes:

1. **`CallGraphPass`**: Builds the call graph, detects cross-language edges
2. **`FFIBoundaryPass`**: Identifies FFI boundary functions from cross-language edges
3. **`SurfaceClassifierPass`**: Classifies functions by surface (Boundary, StdLib, Runtime, Internal) using L1 (linkage) + L2 (source path) + L3 (call graph reachability)

The `SurfaceClassifierPass` depends on `CallGraphPass`:

```rust
impl Pass for SurfaceClassifierPass {
    fn name(&self) -> &'static str { "SurfaceClassifier" }
    fn dependencies(&self) -> Vec<&'static str> { vec!["CallGraph"] }

    fn run(&self, ctx: &mut PassContext) -> Result<PassResult> {
        let classifier = SurfaceClassifier::new();
        let cross_lang_edges: Vec<CrossLangEdge> = ctx.get("cross_lang_edges").unwrap_or_default();

        // Phase 1: Classify each function using L1 + L2
        let mut surfaces: HashMap<String, FunctionSurface> = HashMap::new();
        for name in all_names {
            let language = detector.detect_from_function(name);
            let surface = classifier.classify(name, language, None);
            surfaces.insert(name.clone(), surface);
        }

        // Phase 2: L3 — Upgrade Unknown functions reachable from FFI boundaries
        // If a function was classified as Unknown/Dependency but is reachable
        // from a known FFI boundary, upgrade it to Boundary.
        // ...
    }
}
```

### The LanguageDetector

The `LanguageDetector` is a reusable component that can be cached in `ModuleIndex` to avoid redundant detection:

```rust
pub struct LanguageDetector { ... }

impl LanguageDetector {
    pub fn detect_from_function(&self, name: &str) -> Language {
        // Check name patterns, mangling, metadata
    }
}
```

The detector considers multiple signals:
- Itanium ABI mangling (`_Z*`) → C++
- Python C API prefixes (`Py`, `_Py`) → Python
- JNI patterns (`Java_`, `JNI_`) → Java
- cgo patterns (`_cgo_`, `C.*`) → Go
- Namespace patterns (`std::`) → C++
- Rust name hashing (`_RNv*`) → Rust

---

## Comparison: VTable vs. Trait Objects

| Aspect | Zig | Rust |
|--------|-----|------|
| **Dispatch mechanism** | VTable (function pointer struct) | Trait objects (`dyn LanguageAdapter`) |
| **Default implementations** | `Defaults` namespace with `makeDefaultVTable()` | Default trait methods |
| **Adapter size** | ~200 LOC per adapter | ~200 LOC per adapter module |
| **Adapter structure** | Flat module with exported instances | Module with `impl Trait for Adapter` |
| **Detection passes** | `FFIMatcher` + `LanguageAdapterRegistry` | `CallGraphPass` → `FFIBoundaryPass` → `SurfaceClassifierPass` |
| **Language detector** | Inline `detectCalleeLanguage()` helper | `LanguageDetector` struct (cachable in `ModuleIndex`) |
| **Multi-crate** | Single crate | `omniscope-semantics` crate with sub-modules |
| **C# support** | Basic adapter | Full module: `dispose`, `gc`, `pinvoke` sub-modules |
| **Node.js support** | Not mentioned | Explicit `NodeAdapter` |
| **WASM support** | Not mentioned | Explicit `WasmAdapter` |

### The Zig Trade-off: Explicit and Direct

Zig's VTable pattern is **explicit**. You can see exactly what methods an adapter needs to implement. The `Defaults.makeDefaultVTable()` factory makes it easy to start with sensible defaults and override specific methods. The pattern tables (`C_ALLOCATORS`, `C_DEALLOCATORS`) are simple arrays of strings — easy to extend, easy to audit.

The downside: **more boilerplate**. Every method call goes through `self.vtable.fn(self, ...)`. There's no method resolution, no `super` calls, no inheritance. Everything is manual.

### The Rust Trade-off: Idiomatic and Extensible

Rust's trait objects are **idiomatic**. If you know Rust, you know how `LanguageAdapter` works — it's just a trait. The module structure (`csharp_adapter/mod.rs` with sub-modules for `dispose`, `gc`, `pinvoke`) is the standard Rust way to organize functionality.

The pass-based pipeline (`CallGraphPass` → `FFIBoundaryPass` → `SurfaceClassifierPass`) provides **automatic dependency resolution** and **clear data flow**. Each pass reads inputs from `PassContext` and writes outputs to `PassContext`.

The downside: **more infrastructure**. You need the pass manager, the `PassContext` type, the `Pass` trait, and the dependency system. Setting this up is more work than Zig's simpler approach.

### What We Can Learn

The FFI boundary detection system shows how the two languages handle **pluggable architecture**:

**Zig's VTable pattern says**: "Interfaces are a code organization tool, not a language feature." The VTable is explicit, you can see exactly how it works, and you can build your own dispatch logic if you need something custom (e.g., runtime adapter selection based on module analysis). There's no magic — just structs and function pointers.

**Rust's trait objects say**: "Interfaces are a language feature, and the compiler should enforce them." The `LanguageAdapter` trait defines a contract, and every implementor must fulfill it. The compiler checks that all methods are implemented with the right signatures. The `dyn` dispatch is handled by the runtime.

Both approaches achieve the same goal: **polymorphic dispatch over language-specific adapters**. But they feel different in practice:

- In Zig, you write the dispatch infrastructure once (the VTable pattern) and it never changes. `AdapterVTable` is a plain struct. `LanguageAdapter` is a plain struct with a vtable field. There's no magic, but there's also no compiler-enforced interface contract.

- In Rust, the compiler enforces the contract. If you add a new method to `LanguageAdapter`, every implementor generates a compile error until it's added. The trait serves as documentation, contract, and type-checking mechanism all in one.

---

## Series Wrap-Up: What We've Learned

Over these seven posts, we've walked through every major subsystem of OmniScope:

1. **Same Problem, Two Philosophies**: How language philosophy shapes architecture — monolithic vs. modular, control vs. correctness.
2. **Loading LLVM IR**: How `@cImport` in Zig compares to `llvm-sys` with RAII guards in Rust.
3. **Resource Tracking**: Heuristic name matching vs. formal `ResourceFamily` with compatibility tables.
4. **Ownership Model**: Rich 8-state `PointerContract` with detailed diagnostics vs. lean event-driven state machine.
5. **Contract Graph**: Integrated ad-hoc graph vs. formalized pass-based architecture with explicit dependencies.
6. **Path-Sensitive Analysis**: Floating-point confidence scoring vs. discrete `PathConfidence` levels with enrichment.
7. **FFI Boundary Detection**: VTable pattern vs. trait objects for language adapter dispatch.

### The Meta-Lesson

The most important thing we've learned isn't about Zig or Rust specifically. It's about how **language design influences software architecture**.

When a language gives you `@cImport`, you build your FFI layer differently than when you use `llvm-sys`. When a language gives you traits, you organize your adapters differently than when you use VTables. When a language has RAII, you manage resources differently than when you pass allocators explicitly.

Neither approach is "right" or "wrong." Each is **idiomatic** for its language — it takes advantage of what the language provides and works with the grain of the language.

But by looking at the same problem solved in two languages, we can see past the language-specific details to the underlying design principles:

- **Separation of concerns** matters regardless of language. Both versions separate IR loading from analysis, analysis from reporting.
- **Explicit data flow** is valuable. Whether you use `PassContext` (Rust) or pass allocators explicitly (Zig), knowing where data comes from and goes to is essential for maintainability.
- **Type safety catches bugs**. Rust's type system catches more at compile time (wrong adapter structure, mismatched family compatibility). Zig's explicit style catches different bugs (inconsistent allocator usage, forgotten cleanup).
- **Documentation lives in code**. Zig's `isValid()` transition table documents the entire state machine in one switch expression. Rust's `matches!` macros and enum variants document valid states in the type system.

### The Practical Takeaway

If you're building a cross-language static analyzer (or any complex multi-language tool), here's what this series suggests:

- **Start with the architecture that matches your language's idioms**. Don't fight the language — you'll waste energy and produce unidiomatic code.
- **Think about data flow early**. How will analysis results move between passes? What's the shared context? Both OmniScope versions solved this, but with very different mechanisms.
- **Invest in your domain model**. `ResourceFamily`, `PointerContract`, `OwnershipState` — these types are the foundation everything else builds on. Get them right in either language, and the rest follows.
- **Test with real code**. Both versions have extensive test corpora (OpenSSL, SQLite, ripgrep, zlib, etc.). There's no substitute for running your analyzer against real-world cross-language FFI patterns.

### Final Reflection

OmniScope is the same tool in spirit, regardless of implementation language. It loads LLVM IR, classifies resources, tracks ownership, analyzes paths, and detects FFI boundaries. It finds real cross-language memory safety bugs that other tools miss.

The Zig version is a testament to what you can build with **explicitness and control**. Every allocation is visible. Every function call is direct. The state machine is right there in the code.

The Rust version is a testament to what you can build with **type safety and modularity**. The crate structure enforces boundaries. The trait system enables extensibility. The pass manager orchestrates complexity.

Both are correct. Both are beautiful. And both will continue to find bugs that keep our cross-language software safe.

---

*This concludes the series. Thank you for reading.*