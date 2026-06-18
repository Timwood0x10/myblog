+++
title = "OmniScope-rs 03: Resource Tracking — Heuristic Name Matching vs. Formal ResourceFamily System"
date = 2026-06-16
description = "Part 3 of the OmniScope-rs series: how Zig and Rust classify allocators and deallocators into resource families."
weight = 3
[taxonomies]
tags = ["Rust", "Zig", "Resource Management", "FFI", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 3: Resource Tracking — Heuristic Name Matching vs. Formal ResourceFamily System

## The Core Problem

OmniScope's most fundamental job is tracking resources. When a function calls `malloc`, we need to know it created a resource. When another function calls `free`, we need to know it destroyed one. When we see `PyObject_New` in Python C API code, we need to pair it with `PyObject_Del` — not `free`, not `delete[]`, not `__rust_dealloc`.

But here's the tricky part: **how do we know which functions are allocators and which are deallocators?**

Think about it. The LLVM IR just shows function calls. It doesn't tell you "this function allocates memory" or "this function frees memory." You need a classification system — a way to look at a function name like `malloc`, `fopen`, `PyMem_Malloc`, `sqlite3_open`, `mi_malloc`, or `HeapAlloc` and determine:

1. Is this an allocator, a deallocator, or neither?
2. If it's an allocator, what "family" does it belong to?
3. If it's a deallocator, which allocator families are compatible?

This is the **resource tracking** problem. And once again, Zig and Rust solve it in very different ways.

---

## Think About It

Imagine you're building this system from scratch. You have a function call `my_custom_alloc`. How do you know it allocates memory?

You could:

1. **Use a registry** — Maintain a list of known allocators and deallocators: `malloc` → allocates, `free` → deallocates, etc.
2. **Use name patterns** — Functions starting with `PyMem_` probably belong to Python's memory family. Functions ending in `_new` probably allocate.
3. **Infer from behavior** — If a function returns a pointer that is later freed by a known deallocator, it's probably an allocator.
4. **Use metadata** — LLVM debug info or language-specific attributes might tell you.

Both Zig and Rust use all of these to some degree. But they emphasize different approaches.

---

## Zig's Approach: Heuristic Name-Based Matching

### The Cleanup Patterns Table

The Zig version's `path_analyzer.zig` contains this notable constant:

```zig
const CLEANUP_PATTERNS = [_][]const u8{
    "_cleanup",
    "_fail",
    "errdefer",
    "defer_",
    "__cxa_begin_catch",
    "goto ",
    "__attribute__((cleanup",
    "RAII",
    "destructor",
    "~",
    "Drop(",
    "drop(",
};
```

This is a **heuristic table**. It says: if a function name contains any of these substrings, it's probably a cleanup/error-handling function, not a normal path. This affects how we analyze leaks — resources freed in cleanup functions might still be legitimate.

### Function Name Suffix Analysis

The Zig version classifies allocators and deallocators using function name patterns throughout its codebase. The C++ adapter, for instance, has pattern tables like:

```zig
pub const C_ALLOCATORS = [_][]const u8{
    "malloc", "calloc", "realloc", "reallocarray",
    "aligned_alloc", "memalign", "posix_memalign",
    "strdup", "strndup",
};
```

And corresponding deallocator patterns:

```zig
pub const C_DEALLOCATORS = [_][]const u8{
    "free", "cfree",
};
```

The approach is **lightweight and heuristic-driven**. It's easy to add new patterns — just add a string to the table. But it's also potentially imprecise:

- A function named `my_free_helper` might match the `free` pattern even though it's not a deallocator.
- A function named `custom_allocator_v3` might not match any pattern and get misclassified.
- The same family information is spread across multiple files — `CLEANUP_PATTERNS` in `path_analyzer.zig`, `C_ALLOCATORS` in `cpp_adapter.zig`, and more in `ffi_contract_data.zig`.

### The Family System in Zig

Zig does have a formal `FamilyId` enum:

```zig
pub const FamilyId = enum(u16) {
    invalid = 0,
    c_heap = 1,
    c_mmap = 2,
    c_aligned = 3,
    cpp_new_scalar = 10,
    cpp_new_array = 11,
    rust_global = 20,
    rust_box = 21,
    python_object = 30,
    python_mem = 31,
    python_mem_raw = 32,
    java_local_ref = 40,
    java_global_ref = 41,
    csharp_hglobal = 50,
    csharp_cotask = 51,
    go_gc = 60,
    zig_allocator = 70,
    sentinel = 255,
};
```

And a `FamilyMatchResult` for comparing families:

```zig
pub const FamilyMatchResult = enum(u8) {
    same_family,
    compatible_family,
    mismatch,
    unknown_alloc,
    unknown_release,
    unknown_both,
};
```

The `compareFamiliesSimple` function in `ownership_state.zig` does the matching:

```zig
fn compareFamiliesSimple(alloc: FamilyId, release: FamilyId) FamilyMatchResult {
    if (alloc == release) return .same_family;
    if ((alloc == .python_object or alloc == .python_mem or alloc == .python_mem_raw) and
        (release == .python_object or release == .python_mem or release == .python_mem_raw))
    {
        return .compatible_family;
    }
    // ...
    return .mismatch;
}
```

Notice the hardcoded Python compatibility — it's inlined in the comparison function rather than being data-driven. This is the Zig style: explicit, readable, and directly in the code.

The Zig system also has a `ResourceOpKind` enum that classifies what operation a function performs:

```zig
pub const ResourceOpKind = enum(u8) {
    acquire,
    release,
    retain,
    borrow,
    transfer,
    conditional_release,
    unknown,
};
```

And `EvidenceSource` to track where the classification came from:

```zig
pub const EvidenceSource = enum(u8) {
    builtin_registry,
    name_pattern,
    structural_inference,
    project_model,
    fallback_heuristic,
    unknown,
};
```

This is sophisticated for a "heuristic" system. The Zig version has a proper family model — it's just that the _discovery_ of which family a function belongs to is largely name-based.

---

## Rust's Approach: Formal ResourceFamily with Compatibility Tables

### The FamilyId Newtype

The Rust version uses a `FamilyId` newtype — a wrapper around `u16`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FamilyId(pub u16);

impl FamilyId {
    pub const C_HEAP: FamilyId = FamilyId(1);
    pub const CPP_NEW_SCALAR: FamilyId = FamilyId(2);
    pub const CPP_NEW_ARRAY: FamilyId = FamilyId(3);
    pub const RUST_GLOBAL: FamilyId = FamilyId(4);
    pub const PYTHON_OBJECT: FamilyId = FamilyId(5);
    pub const PYTHON_MEM: FamilyId = FamilyId(6);
    pub const PYTHON_MEM_RAW: FamilyId = FamilyId(7);
    pub const JAVA_LOCAL_REF: FamilyId = FamilyId(8);
    pub const JAVA_GLOBAL_REF: FamilyId = FamilyId(9);
    pub const CSHARP_HGLOBAL: FamilyId = FamilyId(10);
    pub const CSHARP_COTASK: FamilyId = FamilyId(11);
    pub const GO_GC: FamilyId = FamilyId(12);
    pub const ZLIB_STREAM: FamilyId = FamilyId(14);
    pub const OPENSSL_RESOURCE: FamilyId = FamilyId(15);
    pub const SQLITE_RESOURCE: FamilyId = FamilyId(16);
    pub const GO_CGO: FamilyId = FamilyId(17);
    pub const MIMALLOC: FamilyId = FamilyId(18);
    pub const CSHARP_COM: FamilyId = FamilyId(19);
    pub const RUST_RAW_OWNERSHIP: FamilyId = FamilyId(20);
    pub const FILE_DESCRIPTOR: FamilyId = FamilyId(21);
    pub const UNKNOWN: FamilyId = FamilyId(22);
    pub const WIN32_HEAP: FamilyId = FamilyId(23);
    pub const WIN32_VIRTUAL: FamilyId = FamilyId(24);
    pub const SWIFT_ALLOC: FamilyId = FamilyId(25);
    pub const USER_FAMILY_START: u16 = 256;
    // ...
}
```

The key difference from Zig's enum: **this is a newtype with associated constants, not an enum**. Why? Because `FamilyId` also needs to support user-defined families (IDs >= 256), which an enum can't do dynamically. The `custom()` constructor creates a hash-based ID for user-inferred families:

```rust
pub fn custom(name: &str) -> Self {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    let id = (hash % (u16::MAX as u32 - Self::USER_FAMILY_START as u32))
        + Self::USER_FAMILY_START as u32;
    FamilyId(u16::try_from(id).expect("..."))
}
```

### The ResourceFamily Struct

Each family is described by a `ResourceFamily` struct with detailed metadata:

```rust
pub struct ResourceFamily {
    pub id: FamilyId,
    pub name: &'static str,
    pub kind: FamilyKind,
    pub lifetime: LifetimeDomain,
    pub compatible_releases: &'static [FamilyId],
}
```

The `FamilyKind` enum provides semantic classification:

```rust
pub enum FamilyKind {
    ManualHeap,
    GcManaged,
    RefCounted,
    VtableDispatched,
    HandleBased,
    LibraryManaged,
    UserDefined,
    FileDescriptor,
    Socket,
    ProcessHandle,
    RuntimeManaged,
}
```

And `LifetimeDomain` describes when resources should be freed:

```rust
pub enum LifetimeDomain {
    CallLocal,
    ThreadLocal,
    OwnerBounded,
    ExplicitFree,
    GcManaged,
    ProcessStatic,
    Unknown,
}
```

### The Compatibility Table

Compatibility is data-driven, not hardcoded:

```rust
pub static FAMILY_PYTHON_MEM_RAW: ResourceFamily = ResourceFamily {
    id: FamilyId::PYTHON_MEM_RAW,
    name: "python_mem_raw",
    kind: FamilyKind::ManualHeap,
    lifetime: LifetimeDomain::ExplicitFree,
    compatible_releases: &[FamilyId::C_HEAP],  // PyMem_RawMalloc delegates to C malloc
};

pub static FAMILY_MIMALLOC: ResourceFamily = ResourceFamily {
    id: FamilyId::MIMALLOC,
    name: "mimalloc",
    kind: FamilyKind::ManualHeap,
    lifetime: LifetimeDomain::ExplicitFree,
    compatible_releases: &[FamilyId::C_HEAP],  // mimalloc is a malloc replacement
};

pub static FAMILY_RUST_RAW_OWNERSHIP: ResourceFamily = ResourceFamily {
    id: FamilyId::RUST_RAW_OWNERSHIP,
    name: "rust_raw_ownership",
    kind: FamilyKind::ManualHeap,
    lifetime: LifetimeDomain::ExplicitFree,
    compatible_releases: &[FamilyId::RUST_GLOBAL],  // Uses Rust's global allocator underneath
};
```

The compatibility check is a simple method:

```rust
pub fn is_compatible_with(&self, other: FamilyId) -> bool {
    if self.id == other {
        return true;
    }
    self.compatible_releases.contains(&other)
}
```

And there's a top-level function for looking up compatibility from the built-in registry:

```rust
pub fn are_families_compatible(acquire: FamilyId, release: FamilyId) -> bool {
    if acquire == release {
        return true;
    }
    for family in BUILTIN_FAMILIES {
        if family.id == acquire {
            return family.compatible_releases.contains(&release);
        }
    }
    false
}
```

### The Built-in Registry

All built-in families are collected in a single static slice:

```rust
pub static BUILTIN_FAMILIES: &[&ResourceFamily] = &[
    &FAMILY_C_HEAP,
    &FAMILY_CPP_NEW_SCALAR,
    &FAMILY_CPP_NEW_ARRAY,
    &FAMILY_RUST_GLOBAL,
    &FAMILY_PYTHON_OBJECT,
    &FAMILY_PYTHON_MEM,
    &FAMILY_PYTHON_MEM_RAW,
    &FAMILY_JAVA_LOCAL_REF,
    &FAMILY_JAVA_GLOBAL_REF,
    &FAMILY_CSHARP_HGLOBAL,
    &FAMILY_CSHARP_COTASK,
    &FAMILY_GO_GC,
    &FAMILY_ZLIB_STREAM,
    &FAMILY_OPENSSL_RESOURCE,
    &FAMILY_SQLITE_RESOURCE,
    &FAMILY_GO_CGO,
    &FAMILY_MIMALLOC,
    &FAMILY_CSHARP_COM,
    &FAMILY_RUST_RAW_OWNERSHIP,
    &FAMILY_FILE_DESCRIPTOR,
    &FAMILY_UNKNOWN,
    &FAMILY_WIN32_HEAP,
    &FAMILY_WIN32_VIRTUAL,
];
```

This is the "source of truth." Every family is defined once, in one place, with all its metadata and compatibility information. The tests verify invariants:

```rust
#[test]
fn test_c_heap_not_compatible_with_cpp_new() {
    assert!(!FAMILY_C_HEAP.is_compatible_with(FamilyId::CPP_NEW_SCALAR));
    assert!(!FAMILY_C_HEAP.is_compatible_with(FamilyId::CPP_NEW_ARRAY));
}

#[test]
fn test_rust_global_not_compatible_with_c_heap() {
    assert!(!FAMILY_RUST_GLOBAL.is_compatible_with(FamilyId::C_HEAP));
}

#[test]
fn test_python_mem_raw_compatible_with_c_heap() {
    assert!(FAMILY_PYTHON_MEM_RAW.is_compatible_with(FamilyId::C_HEAP));
}
```

---

## Comparison: Coverage vs. Precision

| Aspect | Zig | Rust |
|--------|-----|------|
| **Family definition** | `enum(u16)` with hardcoded IDs | `FamilyId(u16)` newtype with associated constants |
| **Compatibility logic** | Hardcoded in `compareFamiliesSimple()` | Data-driven in `ResourceFamily.compatible_releases` |
| **User-defined families** | Not supported (enum is closed) | Supported via `FamilyId::custom()` (hash-based) |
| **Family metadata** | `FamilyOp` struct with `ResourceOpKind` | `ResourceFamily` struct with `FamilyKind`, `LifetimeDomain` |
| **Discovery mechanism** | Name-based pattern matching | Registry + name-based + structural inference |
| **Registry location** | Spread across files | Single `BUILTIN_FAMILIES` slice |
| **Tests for compatibility** | Implicit (tested through integration) | Explicit unit tests for each family |
| **Number of built-in families** | ~16 | 23 + dynamic user families |

### The Zig Trade-off: Coverage

Zig's heuristic approach can catch more edge cases. If a function is named `my_allocator_create`, the name-based pattern matching might infer it's an allocator even though it's not in any registry. The `CLEANUP_PATTERNS` table catches error-handling paths that a formal system might miss.

But it also catches things it shouldn't. A function named `drop_my_thing` would match the `drop(` pattern. A function named `cleanup_temp_files` would match `_cleanup`. These false positives need downstream filtering.

### The Rust Trade-off: Precision

Rust's formal system is more precise. Every compatibility relationship is explicitly declared. If `PYTHON_MEM_RAW` is compatible with `C_HEAP`, it's because the `ResourceFamily` struct says so — not because the comparison function happened to match.

But precision has a cost: **you must know about every family ahead of time**. If a new allocator family appears (say, a user writes a custom allocator), the Rust version needs it to be added to the registry or inferred through structural analysis. The Zig version might catch it through name heuristics on the first pass.

### What We Can Learn

The resource tracking problem reveals a fundamental tension in static analysis:

**Heuristic systems cover more ground but are harder to reason about.** The Zig version's `CLEANUP_PATTERNS` table might match things it shouldn't. But it also might catch real bugs that a formal system misses.

**Formal systems are provably correct but have blind spots.** The Rust version's `BUILTIN_FAMILIES` clearly defines what's compatible and what isn't. But it can only reason about what it knows. Unknown families are a black box.

The best approach? Both versions _actually use both strategies_. The Zig version has a formal family system (`FamilyId`, `FamilyMatchResult`). The Rust version has heuristic discovery (`structural_inference`, `family_inference`). The difference is in emphasis:

- Zig starts with **heuristics and formalizes the results**. The patterns come first, the family IDs come second.
- Rust starts with **formalism and supplements with heuristics**. The family IDs come first, the pattern discovery augments them.

This reflects the languages' broader philosophies: Zig is comfortable with ambiguity and handles it pragmatically. Rust wants to nail down the types first and let the compiler enforce the rules.

---

Next up: **Part 4 — Ownership Model: Rich 8-State Contract vs. Lean State Machine with Events**. Once we know what families resources belong to, we need to track their ownership state across function boundaries. Is a pointer owned? borrowed? released? retained? The Zig version uses a rich `PointerContract` with 8 states and a detailed diagnostic system. The Rust version uses a leaner `OwnershipState` with a formal event-driven state machine.