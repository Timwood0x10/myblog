+++
title = "OmniScope-rs: Same Problem, Two Philosophies"
date = 2026-06-16
description = "Part 1 of the OmniScope-rs series: comparing the Zig and Rust implementations of a cross-language FFI security static analyzer."
weight = 1
[taxonomies]
tags = ["Rust", "Zig", "FFI", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 1: Same Problem, Two Philosophies

## Two Tools, One Mission

Imagine you're building a security scanner. Its job: find memory safety bugs that happen when different programming languages talk to each other across FFI (Foreign Function Interface) boundaries. A Rust program calls `malloc` from C. A Python extension calls `free()` on a `PyObject`. A Go program calls `fclose` through cgo. When these cross-language handoffs go wrong — when `malloc` is paired with `delete[]`, when a borrowed pointer is freed, when a resource escapes without being released — the result is crashes, vulnerabilities, and security holes.

This is the problem that **OmniScope** solves.

But here's the interesting part: OmniScope was built twice — once in **Zig** and once in **Rust** — solving exactly the same problem with two very different languages and two very different design philosophies.

This blog series is the story of those two implementations. It's not a "which is better" comparison. It's a "what can we learn" exploration.

## What Is OmniScope?

Before we dive into the differences, let's understand what OmniScope actually does.

OmniScope is a static analyzer for cross-language FFI security. It takes LLVM bitcode (`.bc`) or text IR (`.ll`) as input — the same intermediate representation that compilers like Clang, rustc, and the Zig compiler produce — and analyzes it for memory safety issues that arise when resources cross language boundaries.

The kinds of bugs it finds include:

- **Cross-language frees**: Allocating memory with `malloc` in C and freeing it with `delete[]` in C++. Both are "C/C++", but they're different allocator families.
- **Resource leaks**: Memory allocated through FFI but never freed — a Python C extension that calls `PyMem_Malloc` but forgets `PyMem_Free`.
- **Use-after-free**: A C function frees a pointer that a Rust function still holds a reference to.
- **Borrow violations**: Passing a borrowed pointer to a callback that assumes ownership.
- **Reference count mismatches**: Calling `Py_INCREF` one too many or one too few times.

To do this, OmniScope needs to:

1. **Load and parse LLVM IR** — understand the program structure
2. **Identify resource allocation/deallocation pairs** — know that `malloc` pairs with `free`, `fopen` with `fclose`, `PyObject_New` with `PyObject_Del`
3. **Track ownership across function boundaries** — follow who owns what, through calls, returns, stores, and escapes
4. **Build a graph of resource lifecycles** — connect allocation sites to release sites
5. **Analyze paths** — distinguish "definitely leaked" from "maybe cleaned up on error paths"
6. **Detect FFI boundaries** — know when a call crosses from one language into another

Every single one of these steps looks different in the Zig implementation versus the Rust implementation.

## The Two Implementations at a Glance

### The Zig Version: Monolithic and Direct

The Zig version lives in a single, monolithic project. Here's what the source tree looks like (simplified):

```
omniscope/
  src/
    main.zig              # Entry point
    ir/
      llvm_raw.zig         # Raw @cImport bindings to LLVM C API
      llvm_safe.zig        # Safe Zig wrapper around raw bindings
    semantics/
      resource/
        contract.zig       # PointerContract — 8-state ownership model
        family.zig         # Resource family definitions
        ownership_state.zig # State solver with detailed diagnostics
        effect.zig         # Effect types
        escape.zig         # Escape kind definitions
    pass/
      analysis/
        resource/
          contract_graph_builder.zig  # Builds resource contract graph
          path_analyzer.zig           # Path-sensitive analysis
    lang/
      language_adapter.zig  # VTable-based interface pattern
      cpp_adapter.zig       # C++ adapter (~200 LOC)
    ffi/
      ffi_matcher.zig       # FFI declare/define matching
```

The code is straightforward Zig: compile-time code generation via `@cImport`, structs with methods, enums with switch statements, and arena-based allocators passed explicitly. There's a single `build.zig` file. You run `zig build` and you're done.

### The Rust Version: Modular and Structured

The Rust version is organized as a Cargo workspace with 8 crates:

```
OmniScope-rs/
  Cargo.toml               # Workspace root
  crates/
    omniscope-cli/          # CLI entry point
    omniscope-core/         # Core types, diagnostics, issues
    omniscope-ir/           # LLVM IR loading (llvm-sys + text parser)
    omniscope-types/        # Shared type definitions (FamilyId, PointerContract, etc.)
    omniscope-pass/         # Analysis passes (pass manager, passes)
    omniscope-pipeline/     # Pipeline orchestrator
    omniscope-dataflow/     # Dataflow graph
    omniscope-semantics/    # Semantic analysis (adapters, resource tracking)
```

Each crate has a clear responsibility. The dependency graph is directed: `omniscope-ir` depends on nothing else in the workspace, `omniscope-types` is shared by everyone, and `omniscope-pass` orchestrates the semantic and IR crates.

## Language Philosophy: What the Design Reveals

### Zig: "Control is Freedom"

Zig's philosophy is that you should have control over every aspect of your program. No hidden control flow. No hidden allocations. No hidden copy. This shows in the OmniScope codebase:

- **Explicit allocators**: Every function that might allocate takes a `std.mem.Allocator` parameter. Nothing is global.
- **`@cImport` for C binding**: LLVM's C API headers are imported directly at compile time with `@cImport({ @cInclude("llvm-c/Core.h"); ... })`. No build script, no code generation step. The C headers become Zig declarations.
- **No trait objects**: Zig doesn't have traits or interfaces. Instead, the language adapter system uses a **VTable pattern** — a struct of function pointers. This is explicit, manual, and gives you full control.
- **Rich enums with methods**: `PointerContract` is an enum with 8 states, each with query methods like `isActiveOwnership()`, `isDisposed()`. The state machine is right there in the source, readable and auditable.
- **Single binary**: One `build.zig`, one output. Everything compiles into one binary.

The Zig version says: "Here is exactly what the code does. No surprises."

### Rust: "Correctness through Types"

Rust's philosophy is that the type system should guarantee correctness. This shows in the Rust OmniScope:

- **Trait objects for dispatch**: Instead of a VTable struct, the Rust version uses `trait LanguageAdapter { fn analyze(...) -> ...; }` with `dyn LanguageAdapter` trait objects. This is the idiomatic Rust way to achieve polymorphism.
- **`llvm-sys` crate**: A well-maintained crate that provides Rust bindings to the LLVM C API. It handles the FFI, links against LLVM at build time using `llvm-config`, and provides `unsafe` blocks that localize the unsafety.
- **RAII guards**: LLVM resources (contexts, modules, memory buffers) are wrapped in RAII guards — `ContextGuard`, `ModuleGuard`, `MemoryBufferGuard` — that automatically free LLVM resources on `Drop`.
- **Result types everywhere**: Fallible operations return `Result<T, E>` with well-defined error types. The `anyhow` crate provides context for error propagation.
- **Enums as algebraic types**: `PointerContract` in Rust is an enum with 12 variants, but the key difference is that some variants carry data (`PointerValueState::Released { instance }`), making invalid states unrepresentable.
- **Workspace structure**: 8 crates with explicit dependency edges. The compiler enforces the module boundaries.

The Rust version says: "If it compiles, the architecture is sound."

## High-Level Architecture Comparison

Let's zoom out and compare the two architectures side by side:

| Aspect | Zig | Rust |
|--------|-----|------|
| **Project structure** | Monolithic single project | 8-crate workspace |
| **LLVM binding** | `@cImport` compile-time header import | `llvm-sys` crate with build script |
| **Dispatch mechanism** | VTable (function pointer struct) | Trait objects (`dyn LanguageAdapter`) |
| **Memory management** | Explicit allocator passing | RAII + ownership model |
| **Error handling** | Error union types | `Result<T, E>` + anyhow |
| **Ownership model** | `PointerContract` with 8 states, rich diagnostics | `PointerContract` + `OwnershipState` with formal state machine |
| **Resource families** | `FamilyId` enum, integer IDs | `FamilyId(u16)` newtype, same IDs |
| **Pass structure** | Ad-hoc pass functions | Formal `Pass` trait with dependencies |
| **Graph analysis** | Integrated in path_analyzer | Separate passes with explicit data flow |

## Why Both Approaches Work

Here's the thing: **both implementations find real bugs**. The Zig version has been tested against a corpus of 15+ real-world projects including OpenSSL, SQLite, ripgrep, and zlib. The Rust version has comparable coverage. Both catch cross-language frees, leaks, and use-after-free across C/C++/Rust/Python/Go/Java/C# boundaries.

The difference isn't in capability — it's in how the two languages express the same ideas.

Zig says: "I'll give you the tools, you build what you need." The result is more lines of code in fewer files, with more explicit control over every detail.

Rust says: "I'll give you the abstractions, the compiler will check your work." The result is more files with fewer lines each, with stronger compile-time guarantees about module boundaries and data flow.

## What We'll Learn

Over the next six posts, we'll walk through each major subsystem of OmniScope:

1. **Today**: Same Problem, Two Philosophies (you're reading it)
2. **Loading LLVM IR**: Raw C bindings vs. safe wrapper crates
3. **Resource Tracking**: Heuristic name matching vs. formal `ResourceFamily` system
4. **Ownership Model**: Rich 8-state contract vs. lean state machine with events
5. **Contract Graph**: Building the resource flow picture
6. **Path-Sensitive Analysis**: Floating-point confidence vs. discrete confidence levels
7. **FFI Boundary Detection**: VTable pattern vs. trait objects

Each post will ask you to **think** about the problem first, then reveal how each language approaches it. We'll end with a comparison of what we can learn from the two approaches.

The goal isn't to declare a winner. The goal is to understand how language design shapes software design — and how the same problem, solved in two different languages, reveals different truths about both the problem and the languages.

---

Next up: **Part 2 — Loading LLVM IR: Raw C API vs. Safe Wrappers**. We'll look at how each version gets from a `.bc` file to an analyzable representation. The Zig version uses `@cImport` to import LLVM C headers directly at compile time. The Rust version uses `llvm-sys` and wraps it in an `IRModule` abstraction. Both work, but the experience is very different.