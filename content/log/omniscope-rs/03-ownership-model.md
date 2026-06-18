+++
title = "OmniScope-rs 04: Ownership Model — Rich State vs. Lean Abstraction"
date = 2026-06-16
description = "Part 4 of the OmniScope-rs series: comparing Zig's rich 8-state PointerContract with Rust's lean event-driven ownership state machine."
weight = 4
[taxonomies]
tags = ["Rust", "Zig", "Ownership", "FFI", "Static Analysis"]
series = ["omniscope-rs"]
[extra]
series = "omniscope-rs"
+++

# Part 4: Ownership Model — Rich State vs. Lean Abstraction

## The Central Question

Once OmniScope knows what resource family a function belongs to — "this call to `malloc` allocates a `c_heap` resource" — the next question is: **what happens to that resource over the course of the program?**

Think about all the things that can happen to a pointer after `malloc`:

- It could be **freed** directly: `free(p)`.
- It could be **returned** to the caller: `return p;`
- It could be **stored** in a struct field: `obj->data = p;`
- It could be **passed** to another function that takes ownership: `take_ownership(p);`
- It could be **borrowed** without ownership transfer: `process(p);`
- It could be **retained** (refcount++): `Py_INCREF(p);`
- It could be **conditionally released** (refcount--): `Py_DECREF(p);`
- It could be **invalidated**: `p = NULL;`
- It could escape via a **callback**: `register_callback(cb, p);`
- It could be sent to another **thread**: `thread_start(thread_fn, p);`

Some of these are "safe" — the resource is properly handed off. Some are "leaks" — the resource is forgotten. Some are "use-after-free" — the resource is accessed after release.

The ownership model is the core of OmniScope's analysis. It defines what states a resource can be in, what transitions are valid, and what constitutes a violation.

---

## Think About It

How many states do you need to accurately model resource ownership?

You could get away with just two: **allocated** and **freed**. Any allocated pointer that isn't freed at the end is a leak. Simple.

But consider a pointer that's returned to the caller. It's "allocated" but not "freed" — and yet it's not a leak, because ownership was transferred. So you need at least three states: allocated, freed, and transferred.

Now consider borrowed pointers — pointers that you can read but must not free. That's a fourth state. And retained pointers (refcount incremented) — you're responsible for decrementing, but you didn't allocate. That's a fifth. And there's a difference between "definitely owned" and "maybe owned" when the evidence is ambiguous.

Suddenly your "simple two-state model" has grown into something much richer. The question is: **how rich is rich enough?**

---

## Zig's Approach: The 8-State PointerContract

### The States

The Zig version defines `PointerContract` with 8 states:

```zig
pub const PointerContract = enum(u8) {
    owned,           // We allocated it. Must free/transfer before return.
    borrowed,        // Someone else owns it. Don't free.
    maybe_owned,     // Uncertain. Needs more analysis.
    transferred,     // Given to someone else. No longer our responsibility.
    retained,        // Refcount incremented. Must decrement eventually.
    released,        // Freed/destroyed. Don't touch.
    invalid,         // Null/dangling/undefined. Shouldn't appear.
    unknown,         // Couldn't determine. Treated conservatively.
};
```

Each state has query methods that make the semantics explicit:

```zig
pub fn isActiveOwnership(self: PointerContract) bool {
    return switch (self) {
        .owned, .retained, .maybe_owned => true,
        .transferred, .borrowed, .released, .invalid, .unknown => false,
    };
}

pub fn isDisposed(self: PointerContract) bool {
    return switch (self) {
        .released, .transferred => true,
        else => false,
    };
}
```

### The Transition Table

Transitions between states are defined in `ContractTransition`:

```zig
pub const ContractTransition = struct {
    pub const Trigger = enum(u8) {
        acquire, release, retain,
        return_to_caller, out_param_store,
        field_store, global_store,
        callback_escape, thread_escape,
        borrow, consume,
        conditional_release, unknown,
    };

    pub fn isValid(from: PointerContract, trigger: Trigger) ?PointerContract {
        return switch (from) {
            .owned => switch (trigger) {
                .release => .released,
                .return_to_caller => .transferred,
                .out_param_store => .transferred,
                .field_store => .transferred,
                .global_store => .transferred,
                .callback_escape => .transferred,
                .thread_escape => .transferred,
                .borrow => .borrowed,
                .consume => .released,
                .conditional_release => .retained,
                else => null,
            },
            .borrowed => switch (trigger) {
                .return_to_caller, .field_store, .global_store,
                .callback_escape, .borrow => .transferred,
                else => null,
            },
            // ... transitions for other states
        };
    }
};
```

This is a **state transition table** encoded as a nested switch expression. It's explicit, auditable, and compiles down to a jump table.

### The Diagnostics System

Where Zig really goes deep is in the diagnostic layer. The `OwnershipStateSolver` returns a `SolverDecision` that includes detailed violation information:

```zig
pub const SolverDecision = struct {
    result: SolverResult,           // ok, violation, invalid_transition, unknown
    new_state: PointerContract,
    violation: ?ContractViolation,  // leak, use_after_release, double_release, etc.
    severity: ViolationSeverity,    // critical, high, medium, low, diagnostic
    explanation: ?[]const u8,       // Human-readable reason
};
```

Violation types are rich:

```zig
pub const ContractViolation = enum(u8) {
    leak,
    use_after_release,
    double_release,
    cross_family_free,
    borrowed_treated_as_owned,
    retain_count_mismatch,
    unknown,
};
```

And so is severity:

```zig
pub const ViolationSeverity = enum(u4) {
    critical,
    high,
    medium,
    low,
    diagnostic,
    explained,
};
```

The solver applies transitions with full context:

```zig
pub fn applyTransition(
    self: *const OwnershipStateSolver,
    current_state: PointerContract,
    trigger: ContractTransition.Trigger,
    alloc_family: ?FamilyId,
    release_family: ?FamilyId,
    has_valid_escape: bool,
) SolverDecision {
    // Same-family release handling
    if (trigger == .release or trigger == .conditional_release) {
        if (alloc_family != null and release_family != null) {
            const match_result = compareFamiliesSimple(alloc_family.?, release_family.?);
            switch (match_result) {
                .same_family, .compatible_family => {
                    return .{ .result = .ok, .new_state = .released, ... };
                },
                .mismatch => {
                    return .{ .result = .violation, .violation = .cross_family_free, ... };
                },
                // ...
            }
        }
    }

    // Use-after-release detection
    if (current_state == .released) {
        // ...
    }

    // Standard state transition
    const new_state = ContractTransition.isValid(current_state, trigger) orelse {
        return .{ .result = .invalid_transition, ... };
    };

    return .{ .result = .ok, .new_state = new_state };
}
```

The richness here is notable: every transition can fail with a specific reason. The analysis pipeline knows not just _that_ something went wrong, but _what_ went wrong and how _severe_ it is.

---

## Rust's Approach: Leaner State Machine with Events

### The States

The Rust version defines `OwnershipState` with fewer variants:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OwnershipState {
    Untracked,
    Acquired,
    Released,
    Escaped(EscapeKind),
    Transferred,
    Retained,
    Borrowed,
    Unknown,
}
```

And `PointerContract` in the Rust type crate is similar but richer with 12 variants:

```rust
pub enum PointerContract {
    Owned,
    Borrowed,
    MaybeOwned,
    Transferred,
    Retained,
    Released,
    ReturnedToCaller,
    StoredInOwner,
    Escaped,
    GcManaged,
    StaticLifetime,
    Unknown,
}
```

### The Event-Driven State Machine

The Rust version models transitions as explicit events on a `ResourceInstance`:

```rust
pub enum OwnershipEvent {
    Release { function: u64 },
    ConditionalRelease { function: u64 },
    Escape { kind: EscapeKind },
    Transfer,
    Retain,
    Borrow,
}
```

The `ResourceInstance` struct has a `transition` method that takes an event and returns `Result<(), OwnershipError>`:

```rust
pub fn transition(&mut self, event: OwnershipEvent) -> Result<(), OwnershipError> {
    match event {
        OwnershipEvent::Release { function } => {
            match self.state {
                OwnershipState::Acquired | OwnershipState::Retained => {
                    self.state = OwnershipState::Released;
                    self.released_in = Some(function);
                    Ok(())
                }
                OwnershipState::Released => Err(OwnershipError::DoubleRelease {
                    instance: self.id, family: self.family,
                }),
                OwnershipState::Borrowed => Err(OwnershipError::ReleaseBorrowed {
                    instance: self.id,
                }),
                OwnershipState::Escaped(_) => {
                    self.state = OwnershipState::Released;
                    self.released_in = Some(function);
                    Ok(())
                }
                OwnershipState::Transferred => Err(OwnershipError::InvalidTransition {
                    instance: self.id, from_state: self.state, event: "Release",
                }),
                OwnershipState::Untracked | OwnershipState::Unknown => {
                    Err(OwnershipError::InvalidTransition {
                        instance: self.id, from_state: self.state, event: "Release",
                    })
                }
            }
        }
        OwnershipEvent::Escape { kind } => {
            match self.state {
                OwnershipState::Acquired => {
                    self.state = OwnershipState::Escaped(kind);
                    Ok(())
                }
                OwnershipState::Retained => {
                    self.state = OwnershipState::Escaped(kind);
                    Ok(())
                }
                // ... more transitions, each with clear error on invalid
            }
        }
        // ... Transfer, Retain, Borrow, ConditionalRelease
    }
}
```

### The Error Types

The Rust version defines specific error types for invalid transitions:

```rust
pub enum OwnershipError {
    DoubleRelease { instance: u64, family: FamilyId },
    ReleaseBorrowed { instance: u64 },
    InvalidTransition {
        instance: u64,
        from_state: OwnershipState,
        event: &'static str,
    },
}
```

### Comparison with Zig's Model

Let's compare how each system handles a concrete scenario: a Python refcount cycle.

**Zig's path:**
1. Allocate → state = `owned`
2. `Py_INCREF` → trigger = `conditional_release`? No, that's wrong — INCREF is a retain. Let's see... Actually, in Zig's model, `conditional_release` is for DECREF.
3. `Py_INCREF` → trigger = `retain`. But wait — Zig's `ContractTransition.isValid` for `owned` + `acquire` returns `null`, and `retain` isn't a valid trigger from `owned` either. Hmm, actually looking at the code, `owned + acquire` returns null, and `owned + retain` — it's not in the match arms, so it also returns null. So INCREF from owned is an invalid transition in Zig's model.
4. The `SolverDecision` would return `result = .invalid_transition` with an explanation.

Wait, let me re-read the code more carefully. In `ContractTransition.isValid`:

```zig
.owned => switch (trigger) {
    .release => .released,
    .return_to_caller => .transferred,
    .out_param_store => .transferred,
    .field_store => .transferred,
    .global_store => .transferred,
    .callback_escape => .transferred,
    .thread_escape => .transferred,
    .borrow => .borrowed,
    .consume => .released,
    .conditional_release => .retained,
    .acquire, .retain, .unknown => null,
},
```

So `owned + retain` is invalid. But in the `OwnershipStateSolver.applyTransition`, before the standard transition table, there's a check for `conditional_release`:

```zig
if (trigger == .conditional_release) {
    if (current_state == .owned) {
        return .{ .result = .ok, .new_state = .retained, ... };
    }
}
```

So `owned + conditional_release` → `retained`. That means `Py_DECREF` from owned is "conditional release" → retained (refcount decremented but resource still alive). But `Py_INCREF` from owned is not handled — you'd need to go owned → retain → hmm.

Actually, the model seems to be: you start at `owned`, and `conditional_release` (DECREF) moves you to `retained` (refcount decremented but still alive). Then another `conditional_release` from `retained` → well, looking at the table:

```zig
.retained => switch (trigger) {
    .release => .released,
    .conditional_release => .retained,
    .return_to_caller => .transferred,
    .field_store => .transferred,
    else => null,
},
```

So `retained + conditional_release` → stays `retained`. That makes sense for Python refcounting — multiple DECREFs reduce the count, and the last one frees.

**Rust's path for the same scenario:**
1. Initialize → `ResourceInstance::new()` → state = `Acquired`
2. `Py_INCREF` → `OwnershipEvent::Retain` → state becomes `Retained`
3. `Py_DECREF` → `OwnershipEvent::ConditionalRelease { function }` → state goes back to `Acquired` (if refcount > 0 after decrement) or `Released` (if refcount reached 0).

Wait, let me re-read:

```rust
OwnershipEvent::ConditionalRelease { function } => {
    match self.state {
        OwnershipState::Retained => {
            self.state = OwnershipState::Acquired;
            Ok(())
        }
        OwnershipState::Acquired => {
            self.state = OwnershipState::Released;
            Ok(())
        }
        // ...
    }
}
```

So in Rust's model: `Acquired → Retain → Retained → ConditionalRelease → Acquired` (back to start). If you then call `ConditionalRelease` from `Acquired`, it goes to `Released`.

This is the key difference: **Zig models DECREF as a transition from `owned` to `retained`**. **Rust models INCREF as `Acquired → Retained` and DECREF as `Retained → Acquired`** (refcount still > 0) or `Acquired → Released` (last reference).

Both models capture the same semantics — they just distribute the information differently.

---

## Comparison: Rich Diagnostics vs. Simpler Machine

| Aspect | Zig | Rust |
|--------|-----|------|
| **Number of states** | 8 (PointerContract) | 8 (OwnershipState) + 12 (PointerContract types) |
| **Transition model** | Trigger + transition table | Events on a state machine |
| **Diagnostics** | `SolverDecision` with violation type, severity, explanation | `OwnershipError` with error type and instance info |
| **Violation types** | 6 specific types | 3 error types |
| **Severity** | 6 levels (critical to explained) | Not built-in (handled upstream) |
| **Family checking** | Integrated in solver | Separate (checked by caller) |
| **State queries** | Methods on enum (`isActiveOwnership()`, `isDisposed()`) | Methods on enum (`requires_deallocation()`, `is_refcount()`) |

### The Zig Trade-off: Richer Semantics, More Complex

Zig's `OwnershipStateSolver` with `SolverDecision` provides **more diagnostic information at every step**. When a leak is detected, the solver knows exactly what kind of violation occurred, its severity, and why. This makes it easier to produce high-quality bug reports.

But this richness comes at a cost: **the state machine is more complex**. There are more states to track, more transitions to consider, and more ways to get confused. The `isValid` transition table must be meticulously maintained.

### The Rust Trade-off: Simpler, But Less Nuanced

Rust's event-driven state machine is **simpler to reason about**. Each event has clear, specific behavior. There's no complex transition table — just `match` arms that say "if we're in state X and event Y happens, go to state Z."

But this means **some information is lost**. The Rust version doesn't distinguish between "borrowed" and "maybe_owned" at the state machine level. The `PointerContract` enum has these variants, but the `OwnershipState` machine doesn't track them all. Some nuance is pushed upstream to the analysis passes.

### What We Can Learn

The ownership model reveals another dimension of the Zig vs. Rust philosophy:

**Zig embeds diagnostic information into the state machine itself.** Every transition carries with it the possibility of a detailed explanation. This makes the analyzer more self-documenting — the code says not just "this is a violation" but "this is a `cross_family_free` violation of `high` severity because `malloc` was paired with `delete[]`."

**Rust separates the state machine from the diagnostics.** The state machine tracks the minimal information needed for correctness. Diagnostics are added at a higher level — in the verifier passes, the issue builders, the report formatters. This separation of concerns is classic Rust architecture.

Both approaches work. But they produce different code:

- In Zig, you read `OwnershipStateSolver` and understand the entire ownership model — states, transitions, violations, severities, and explanations — in one file.
- In Rust, you read `OwnershipState` for the state machine, `OwnershipEvent` for the events, `OwnershipError` for the errors, and then look at separate verifier passes for the full diagnostic picture.

Zig is **integrated**. Rust is **modular**. Both are valid engineering choices.

---

Next up: **Part 5 — Contract Graph: Building the Resource Flow Picture**. Once we know the ownership state of individual resources, we need to connect them into a global picture — a graph of resource lifecycles that shows how resources flow through the program. The Zig version builds a `ResourceContractGraph` with `ResourceInstance` and `ContractEdge` nodes. The Rust version builds a `ContractGraph` with a formal pass-based approach.