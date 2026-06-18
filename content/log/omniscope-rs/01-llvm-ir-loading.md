+++
title = "OmniScope-rs 02: Loading LLVM IR — Raw C API vs. Safe Wrappers"
date = 2026-06-16
description = "Part 2 of the OmniScope-rs series: how Zig and Rust load and parse LLVM IR, from @cImport to RAII guards."
weight = 2
[taxonomies]
tags = ["Rust", "Zig", "LLVM", "FFI", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 2: Loading LLVM IR — Raw C API vs. Safe Wrappers

## The First Hurdle

OmniScope's job is to analyze LLVM IR. Before it can do anything useful — before it can find leaks, track ownership, or detect FFI boundaries — it first needs to **load and parse** that IR from a file.

This sounds simple, but it's the first place where the Zig and Rust philosophies diverge sharply. The question is:

> How do you call C APIs from a language that isn't C?

LLVM is written in C++. It exposes a C API (`llvm-c/Core.h`, `llvm-c/IRReader.h`, `llvm-c/BitReader.h`) and a C++ API (`llvm::parseIRFile`, `llvm::parseBitcodeFile`). If you're building a static analyzer in a non-C++ language, you need some way to reach across the FFI barrier.

Let's think about the options:

1. **Write C bindings manually** — Declare `extern` functions one by one.
2. **Use a binding generator** — Let a tool parse the C headers and generate bindings.
3. **Link against LLVM libraries** — Use the system's `llvm-config` to find the right libraries.
4. **Use a C++ helper bridge** — Write a small C++ file that exposes the C++ API as C-compatible functions.

Both implementations use a combination of these approaches, but they make very different trade-offs.

---

## Think About It

Before reading on, ask yourself: what's the simplest possible way to call a C function from your language of choice?

In Zig, it's literally:

```zig
const c = @cImport({
    @cInclude("llvm-c/Core.h");
});

pub fn main() void {
    const ctx = c.LLVMContextCreate();
    // ctx is a valid LLVMContextRef
    c.LLVMContextDispose(ctx);
}
```

That's it. `@cImport` is a compile-time directive that tells the Zig compiler to parse the C header and make every declaration available as Zig code. No build script. No code generation step. No `bindgen`. The C header is the source of truth.

Now, what about Rust? Rust doesn't have `@cImport`. Instead, you need a crate that provides the bindings. The most popular one is `llvm-sys`. But even with `llvm-sys`, you still need `unsafe` blocks to call C functions:

```rust
use llvm_sys::core::*;

fn main() {
    let ctx = unsafe { LLVMContextCreate() };
    // ctx is a LLVMContextRef (a raw pointer)
    unsafe { LLVMContextDispose(ctx) };
}
```

Every call to LLVM's C API is `unsafe`. Every one of them is a place where a wrong pointer, a null argument, or a use-after-free could crash the analyzer itself.

These two approaches — `@cImport` vs. `llvm-sys` — represent a fundamental difference in how Zig and Rust think about C interop.

---

## Zig's Approach: The Raw Layer and The Safe Layer

### Layer 1: `llvm_raw.zig` — Direct @cImport

The Zig version's raw binding file is remarkably short:

```zig
// llvm_raw.zig
const std = @import("std");

pub const c = @cImport({
    @cInclude("llvm-c/Core.h");
    @cInclude("llvm-c/IRReader.h");
    @cInclude("llvm-c/BitReader.h");
    @cInclude("llvm-c/Analysis.h");
    @cInclude("llvm-c/Target.h");
    @cInclude("llvm-c/DebugInfo.h");
});
```

Twenty lines. That's the entire FFI surface for LLVM. The Zig compiler reads these C headers at compile time, parses them, and generates corresponding Zig declarations. Every LLVM C function becomes a Zig function with the same name, the same parameters, and the same return type.

But there's a catch: the raw LLVM C API is **not safe**. It takes raw pointers. It returns null on error. It doesn't manage memory for you. A `LLVMContextRef` that you forget to dispose is a memory leak. A `LLVMModuleRef` that you use after disposing the context is undefined behavior.

### Layer 2: `llvm_safe.zig` — Wrapping C in Zig Safety

This is where the Zig philosophy comes through. Instead of using the raw C API directly, the Zig version wraps every LLVM resource in a Zig struct with an `init` and `deinit` method:

```zig
pub const Context = struct {
    raw: c.LLVMContextRef,

    pub fn init() !Context {
        const ctx = c.LLVMContextCreate();
        if (ctx == null) return Error.ContextCreationFailed;
        return .{ .raw = ctx };
    }

    pub fn deinit(self: Context) void {
        c.LLVMContextDispose(self.raw);
    }
};

pub const Module = struct {
    raw: c.LLVMModuleRef,

    pub fn deinit(self: Module) void {
        c.LLVMDisposeModule(self.raw);
    }

    pub fn getFunction(self: Module, name: []const u8) ?Function {
        var func = c.LLVMGetFirstFunction(self.raw);
        while (@intFromPtr(func) != 0) {
            const func_name = std.mem.span(c.LLVMGetValueName(func));
            if (std.mem.eql(u8, name, func_name_slice)) {
                return .{ .raw = func };
            }
            func = c.LLVMGetNextFunction(func);
        }
        return null;
    }
};
```

Key design decisions in the safe wrapper:

- **`init()` returns an error union** — `!Context` means "either a Context or an error." Null pointer checks happen in the wrapper, not in every caller.
- **`deinit()` is explicit** — No destructors. You call `deinit()` when you're done. You pass `defer ctx.deinit()` right after `init()`.
- **Methods use Zig idioms** — `getFunction()` returns `?Function` (an optional, Zig's version of `Option<T>`), and we use `std.mem.eql` for name comparison.
- **Iteration uses Zig's `while` loops** — The raw C iterator pattern (`LLVMGetFirstFunction` / `LLVMGetNextFunction`) is wrapped in Zig's loop syntax.

### The C++ Bridge: When C Isn't Enough

The Zig version also uses a small C++ bridge file (`llvm_cpp_bridge.cpp`) that exposes C++ LLVM APIs as C-compatible functions:

```zig
const cpp = struct {
    extern fn omni_parse_ir_file(
        path: [*:0]const u8,
        ctx: ?*anyopaque,
        module_out: ?*?*anyopaque,
        error_out: ?*?[*:0]u8
    ) c_int;
};
```

This bridge handles cases where the C API is insufficient — specifically, parsing LLVM 22 text IR, which the C API's `LLVMParseIRInContext` handles incorrectly. The bridge calls `llvm::parseIRFile` from C++ directly.

The `IRLoader` in `llvm_safe.zig` orchestrates a fallback chain:

1. Try the C++ bridge (`omni_parse_ir_file`) for `.ll` and `.bc` files.
2. If that fails, use `llvm-as` to convert `.ll` to `.bc`, then parse with the C API.
3. For `.bc` files, fall back to `LLVMParseBitcodeInContext2` if the C++ bridge fails.

This pragmatic fallback chain is classic Zig — try the best option, but have a working fallback for when things don't work out.

---

## Rust's Approach: The Crate Ecosystem

### Layer 1: `llvm-sys` — Community FFI Bindings

The Rust version doesn't roll its own LLVM bindings. It uses the `llvm-sys` crate, which provides safe-ish wrappers around the LLVM C API. The crate:

- Calls `llvm-config` during build to find LLVM libraries
- Generates bindings via `bindgen` (or provides pre-generated ones)
- Links against the appropriate LLVM shared libraries
- Provides `LLVM*` types and functions that match the C API

Every call to LLVM from Rust is in an `unsafe` block:

```rust
// SAFETY: `LLVMContextCreate` allocates a fresh context.
let ctx = unsafe { LLVMContextCreate() };
if ctx.is_null() {
    anyhow::bail!("LLVMContextCreate returned null");
}
```

The `unsafe` annotation is a signal to the reader: "this operation CAN violate memory safety if used incorrectly." It forces the programmer to think about what could go wrong.

### Layer 2: RAII Guards

The Rust version wraps LLVM resources in RAII guards that implement `Drop`:

```rust
struct ContextGuard(LLVMContextRef);

impl Drop for ContextGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LLVMContextDispose(self.0) };
        }
        self.0 = ptr::null_mut();
    }
}

struct ModuleGuard(LLVMModuleRef);

impl Drop for ModuleGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LLVMDisposeModule(self.0) };
        }
        self.0 = ptr::null_mut();
    }
}
```

This is Rust's answer to C's manual resource management: **RAII**. When the `ContextGuard` goes out of scope — whether through normal return, early return, or a panic — its `Drop` implementation automatically disposes the LLVM context. No `defer` statements, no manual cleanup, no risk of forgetting.

### Layer 3: `IRModule` — The Analyzer's Data Structure

The Rust version doesn't just keep the raw LLVM module around. It extracts all the information it needs into an `IRModule` data structure:

```rust
pub struct IRModule {
    pub functions: HashMap<String, Function>,
    pub declarations: HashMap<String, Function>,
    pub function_bodies: HashMap<String, FunctionBody>,
    pub calls: Vec<CallInstruction>,
    pub data_layout: DataLayout,
    pub global_variables: HashMap<String, bool>,
    pub calling_conventions: Vec<CallingConvention>,
}
```

The extraction happens in `walk_module_functions`, which iterates over LLVM functions using the C API, converts each instruction into an `IRInstruction` enum, and stores everything in Rust-native data structures:

```rust
fn walk_module_functions(module_ref: LLVMModuleRef, module: &mut IRModule) -> Result<()> {
    let mut func = unsafe { LLVMGetFirstFunction(module_ref) };
    while !func.is_null() {
        let name = get_value_name(func);
        let is_decl = unsafe { LLVMIsDeclaration(func) } != 0;
        // ... extract params, return type, body ...
        if is_decl {
            module.declarations.insert(name, function);
        } else {
            module.functions.insert(name.clone(), function);
            let body = walk_function_body(func, &name);
            module.function_bodies.insert(name, body);
        }
        func = unsafe { LLVMGetNextFunction(func) };
    }
    Ok(())
}
```

Once the IR is extracted into `IRModule`, the LLVM context and module can be disposed. The analysis works entirely on Rust-native types — no `unsafe` blocks needed after extraction.

### Layer 4: The `ir_model.rs` — Rich Model (Optional)

The Rust version also has an `IRModuleModel` type that carries richer type information — per-instruction result types, operand types, basic-block successor edges — populated either from a C++ LLVM pass (Plan A: JSON export) or from `llvm-sys` (Plan C: direct C API):

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IRModuleModel {
    pub target_triple: Option<String>,
    pub data_layout: Option<String>,
    pub functions: Vec<IRFunction>,
    pub declarations: Vec<IRDeclaration>,
    pub named_struct_types: HashMap<String, Vec<String>>,
    pub global_variables: Vec<IRGlobalVariable>,
}
```

This separation of concerns — raw LLVM vs. extracted data vs. rich model — is very Rust-like. Each layer has a clear purpose, and the type system ensures you use the right one.

---

## Comparison: Two Approaches to C Interop

Let's put the two approaches side by side:

| Aspect | Zig | Rust |
|--------|-----|------|
| **FFI binding** | `@cImport` at compile time | `llvm-sys` crate, build-time linking |
| **Build integration** | None — just add `@cInclude` | `llvm-config` in `build.rs` |
| **Safety model** | Explicit safe wrapper layer | `unsafe` blocks + RAII guards |
| **Resource cleanup** | Manual `deinit()` with `defer` | `Drop` trait (automatic) |
| **Data extraction** | Use raw LLVM values throughout | Extract into `IRModule`/`IRModuleModel` |
| **Error handling** | Zig error union types | `Result<T, E>` + `anyhow::Context` |
| **C++ bridge** | Small manual C++ file for edge cases | Potential C++ LLVM pass (Plan A) |
| **LLVM version handling** | Runtime fallback chain (C++ bridge → llvm-as → C API) | Build-time linking via `llvm-config` |

### The Zig Trade-off: Simpler Build, More Manual Work

The Zig approach is **simpler to set up**. You don't need a build script, a binding generator, or a crate. You just `@cInclude` the LLVM headers and you're done. The `@cImport` mechanism handles everything at compile time.

But this simplicity comes at a cost:

- **You must manually wrap every C resource** in a Zig struct with `init`/`deinit`. There's no automatic cleanup — if you forget a `defer`, you leak.
- **You use raw LLVM values** throughout most of the analyzer. The `safe` wrapper is good, but many passes still iterate LLVM values directly.
- **The wrapper is custom**, not community-maintained. If LLVM's API changes, you update your own wrapper.

### The Rust Trade-off: Heavier Build, Better Abstractions

The Rust approach is **more work to set up** — you need `llvm-sys` in `Cargo.toml`, a `build.rs` that calls `llvm-config`, and a CI setup that has LLVM installed.

But once that's done:

- **RAII eliminates resource leaks**. The `Drop` implementations for `ContextGuard` and `ModuleGuard` mean you can't forget to dispose LLVM resources.
- **`unsafe` is localized**. After the `IRModule` is built, all downstream analysis is safe Rust. No `unsafe` blocks in the leak detector, the path analyzer, or the FFI detector.
- **`anyhow::Result` chains errors beautifully**. A failed parse produces a chain of context: "LLVM IR parse failed for foo.bc: LLVM could not read path: No such file or directory."

### What We Can Learn

The LLVM loading problem reveals a deep truth about Zig vs. Rust:

**Zig treats C interop as a natural part of the language.** Calling C code doesn't require any annotation, any special syntax, or any `unsafe` keyword. The assumption is that C interop is normal, expected, and pervasive. The safety comes from how you _wrap_ the C code, not from how you _call_ it.

**Rust treats C interop as dangerous and exceptional.** Every C call requires `unsafe`. The assumption is that you should minimize your FFI surface, extract what you need into safe Rust types as quickly as possible, and then never touch the C code again. The safety comes from the `unsafe` contract — the compiler trusts you to uphold the invariants.

Both approaches work. Both find bugs. But they reflect fundamentally different attitudes about what "safety" means:

- In Zig, safety is a **process** — you build it layer by layer, wrapping C in Zig, handling nulls, adding fallback chains.
- In Rust, safety is a **boundary** — you cross the `unsafe` line, extract everything into safe types, and then stay on the safe side.

---

Next up: **Part 3 — Resource Tracking: Heuristic Name Matching vs. Formal `ResourceFamily` System**. Once we've loaded the IR, how do we know which functions allocate resources and which functions release them? The Zig version uses name-based pattern matching. The Rust version uses a formal family system with explicit compatibility tables. Both approaches try to solve the same problem: knowing that `malloc` pairs with `free`, but `PyObject_New` doesn't.