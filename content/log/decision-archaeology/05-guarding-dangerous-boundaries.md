+++
title = "危险边界的守卫"
date = 2026-06-12
description = "跨语言 FFI 是内存安全的最大盲区。OmniScope 从 LLVM IR 静态分析检测，memscope-rs 从运行时追踪。两种守卫，同一条边界。"
weight = 5
[taxonomies]
tags = ["Rust", "Zig", "FFI", "Memory Safety", "LLVM", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 危险边界的守卫

> **Problem**: Rust 的 borrow checker 保证了 safe 代码的内存安全，但 unsafe 块和 FFI 调用打破了这个保证。一块内存从 Rust 交给 C，再从 C 交回 Rust——中间发生了什么？谁能保证这段旅程是安全的？

Rust 的内存安全模型建立在一个清晰的信任边界上：safe 代码由编译器担保，unsafe 代码由程序员担保。问题在于，真实世界的 Rust 程序不可能只用 safe 代码。系统编程必然涉及 unsafe 块，跨语言交互必然经过 FFI 边界。当一块 `Vec<u8>` 通过 `into_raw()` 交到 C 库手上时，borrow checker 的管辖权就到此为止了。

这条边界是内存安全的最大盲区。两个项目从不同角度守卫它：OmniScope 在编译后的 LLVM IR 层做静态分析，memscope-rs 在运行时追踪内存的完整生命周期。一个在事前审查，一个在事中监控。

## 安全的边界在哪里

Rust 编译器对 safe 代码的保证是绝对的——不存在 use-after-free，不存在 data race。但这个保证有严格的适用范围。一旦进入 unsafe 块，程序员接管了安全责任：

```rust
// src/ffi/bridge.rs
unsafe fn pass_to_c(data: *mut u8, len: usize) {
    // 从这一刻起，编译器不再追踪 data 的生命周期
    c_library_process(data, len);
    // 如果 C 那边提前释放了这块内存？
    // 如果 C 持有了这个指针，但 Rust 这边 drop 了 Vec？
}
```

这不是假设性的问题。FFI 边界的 bug 是最难调试的——它们表现为随机的段错误、数据损坏、或者安静的内存泄漏，而且往往在生产环境中才暴露。

## OmniScope 的 Zone 分类：不做什么比做什么更重要

OmniScope 的第一个设计决策不是"怎么检测问题"，而是"在哪里检测"。Zone 分类系统决定了分析器关注什么、忽略什么：

```zig
// src/types/zone_types.zig:13-31
pub const ZoneKind = enum(u8) {
    safe,              // 语言保证生效，跳过分析
    unsafe,            // 显式安全逃逸，高优先级
    ffi,               // 跨语言调用，最高优先级
    runtime_internal,  // 标准库/运行时，跳过
    unknown,           // 需要分类
};
```

五个枚举值背后是一条信任链：safe zone 由编译器保证，runtime_internal 由语言实现保证（假设标准库是正确的），只有 unsafe、ffi、unknown 才需要人工审查。

这个分类通过一个 gate 函数转化为分析策略：

```zig
// src/pass/analysis/pass.zig:360-367
pub fn shouldAnalyzeZone(zone: ZoneKind) bool {
    return !PassContext.shouldAnalyzeZone(.safe) and
           !PassContext.shouldAnalyzeZone(.runtime_internal);
    // 只分析 .unknown, .unsafe, .ffi
}
```

跳过 safe zone 不仅是性能优化，更是一种设计哲学：信任语言的保证，只关注语言保证失效的地方。这和安全工程中的"最小信任面"原则一致——你审查的范围越小，审查的质量越高。

## DangerSurface：从危险表面向外追踪

传统的静态分析是"扫描所有节点"，这在大型代码库上代价高昂。OmniScope 的 DangerSurface 算法做了一个关键转变：从危险表面出发，只追踪与危险相关的路径。

```zig
// src/pass/analysis/danger_surface.zig:31-258
// 核心逻辑（简化）：
// 1. 收集所有 danger surfaces —— FFI boundary 上的 CrossLangEdge
// 2. 如果没有 FFI 边界，early return（整个程序没有跨语言调用）
// 3. 对每个 surface，通过 call_arg/call_ret 边找到关联的指针
// 4. 只检查那些在 danger path 上的指针
```

这个算法的复杂度从 O(N x B)（N 个节点 x B 个边界）降到 O(E x avg_args)（E 条边 x 平均参数数量）。对于一个只有少量 FFI 调用但大量 safe Rust 代码的项目，这个差距是数量级的。

决策的核心洞察是：危险不在于内存本身，而在于内存跨越边界的行为。一块分配在 Rust 堆上、从未离开 Rust 管辖的内存，不需要任何审查。只有那些穿过 FFI 边界的指针才是真正的"危险表面"。

## Rust FFI Auditor：10 条规则

OmniScope 的 Rust FFI Auditor 实现了 10 条专门针对 Rust-C 交互的规则。这些规则不是凭空想象的——每一条都对应着真实世界中反复出现的 bug 模式。

Rust 专有规则覆盖了 `into_raw`/`from_raw` 的配对、`as_ptr` 的借用逃逸、跨语言 alloc/free 不匹配、所有权转移协议、以及 `as_ptr` 悬垂检测。通用 FFI 规则则处理 unsafe 块中的 FFI 调用、栈地址逃逸、回调所有权、const 指针写入、以及 use-after-free。

```zig
// src/pass/analysis/rust_ffi/rust_ffi_auditor.zig:60-340
// Fast path: 只有 FFI 候选函数才进入完整审计
const is_ffi_candidate = fir.calls.len > 0 or
    ctx.rust_into_raw_set.contains(func_name) or
    ctx.rust_from_raw_set.contains(func_name);
if (!is_ffi_candidate) return;
```

Fast path 的设计值得注意：通过检查函数是否包含 FFI 调用、是否使用 `into_raw`/`from_raw`，快速跳过大量无关函数。这是 DangerSurface 思路的延续——只在必要的地方做必要的工作。

Rule 3（跨语言 alloc/free 不匹配）是一个典型的例子。Rust 分配的内存必须由 Rust 释放，C 分配的内存必须由 C 释放。混用会导致堆损坏，而且往往不会立即崩溃——它安静地腐蚀着程序的状态，直到某个不相关的操作触发段错误。

但最常见的 FFI bug 其实来自 Rule 1 和 Rule 2。Rule 1 检测 `into_raw`/`from_raw` 的配对：`into_raw()` 将 `Vec` 或 `Box` 的所有权转移给 C 侧，返回一个裸指针，同时 Rust 放弃了这块内存的管理权。如果 C 侧从未调用对应的释放函数，或者调用了 `free()` 而不是 Rust 的 `from_raw()`，这块内存就永远无法被回收——一个安静的泄漏。Rule 2 检测 `as_ptr` 的借用逃逸：`as_ptr()` 返回的是一个借用指针，底层 `Vec` 仍然由 Rust 拥有。如果 Rust 侧的 `Vec` 在 C 仍然持有这个指针时被 drop，C 侧就持有了一个悬垂指针——经典的 use-after-free。这两类 bug 的共同特征是它们完全合法地通过编译，Rust 编译器无法判断一个裸指针在 C 侧的使用是否安全，它们是纯粹的逻辑错误，只能通过静态规则匹配或运行时追踪来发现。在实践中，开发者经常混淆这两个 API 的语义——`into_raw` 是所有权转移，`as_ptr` 是临时借用，选错一个就意味着要么泄漏、要么悬垂，而编译器对此完全沉默。

## memscope-rs 的 Memory Passport：运行时生命周期追踪

OmniScope 在编译时审查 FFI 边界，memscope-rs 则在运行时追踪每一块跨过边界的内存。它的核心抽象是 Memory Passport——一块内存的"护照"，记录了它从分配到释放的完整旅程。

```rust
// src/analysis/memory_passport_tracker.rs:15-54
pub struct MemoryPassport {
    pub passport_id: String,
    pub allocation_ptr: usize,
    pub lifecycle_events: Vec<PassportEvent>,
    pub status_at_shutdown: PassportStatus,
}

pub enum PassportStatus {
    FreedByRust,
    HandoverToFfi,      // 交给 C 了
    FreedByForeign,     // C 帮忙释放了
    ReclaimedByRust,    // 从 C 要回来了
    InForeignCustody,   // 交给 C 了但没释放 → 泄漏
    Unknown,
}
```

六种状态覆盖了内存跨 FFI 边界的所有可能命运。其中 `InForeignCustody` 是最关键的——它意味着一块内存被交给了 C，但既没有被 C 释放，也没有被 Rust 回收。这是一个确定的泄漏。

状态机的实现简洁而精确：

```rust
// src/analysis/memory_passport_tracker.rs:705-739
fn determine_final_status(&self, events: &[PassportEvent]) -> PassportStatus {
    let mut has_handover = false;
    let mut has_reclaim = false;
    let mut has_foreign_free = false;
    for event in events {
        match event.event_type {
            PassportEventType::HandoverToFfi => has_handover = true,
            PassportEventType::ReclaimedByRust => {
                has_reclaim = true; has_handover = false;
            }
            PassportEventType::FreedByForeign => {
                has_foreign_free = true; has_handover = false;
            }
            _ => {}
        }
    }
    if has_handover && !has_reclaim && !has_foreign_free {
        PassportStatus::InForeignCustody
    } else if has_foreign_free {
        PassportStatus::FreedByForeign
    } else if has_reclaim {
        PassportStatus::ReclaimedByRust
    } else {
        PassportStatus::FreedByRust
    }
}
```

注意 `has_handover = false` 的重置逻辑——每次 reclaim 或 foreign free 都会"关闭"当前的 handover 周期。这处理了同一块内存多次跨越 FFI 边界的场景。

## 两种守卫的互补

OmniScope 和 memscope-rs 不是竞争关系，它们覆盖了互补的维度：

| 维度 | OmniScope (静态分析) | memscope-rs (运行时追踪) |
|------|---------------------|------------------------|
| 检测时机 | 编译后 / IR 层 | 运行时 |
| 覆盖范围 | FFI 边界全覆盖 | 真实路径全覆盖 |
| 误报率 | 可能有（路径不可达） | 低（实际执行到了） |
| 漏报率 | 可能有（动态生成的 FFI） | 可能有（未执行到的路径） |
| 性能影响 | 零运行时开销 | 有运行时开销 |
| 最佳场景 | CI / code review | 开发 / 测试 |

静态分析的优势是覆盖率——它看到所有代码路径，包括那些运行时不会触发的边界情况。运行时追踪的优势是精确性——它只报告真实发生的事件，不会有误报。

考虑一个具体场景：一个 Rust 库封装了 C 的图像处理库，通过 `into_raw()` 将像素缓冲区交给 C 函数进行滤镜运算，然后期望 C 通过回调释放缓冲区。OmniScope 在 CI 阶段扫描 LLVM IR，发现 `into_raw()` 的返回值没有对应的 `from_raw()` 回收路径，标记为 Rule 1 违规——但此时你还不知道这个路径在真实执行中是否会被触发。memscope-rs 在集成测试中运行同一段代码，追踪到缓冲区的 Passport 状态最终停留在 `InForeignCustody`，确认泄漏真实发生。只有两者配合，才能从"可能存在风险"推进到"确认存在 bug"，然后定位到具体的函数和调用栈。

## 双通道检测

{% mermaid() %}
flowchart LR
    A[内存跨越 FFI 边界] --> B{检测方式}
    B --> C[编译时：OmniScope]
    B --> D[运行时：memscope-rs]
    C --> E[Zone 分类]
    E --> F{在哪个 zone？}
    F -->|safe| G[跳过]
    F -->|ffi/unsafe| H[10 条规则检查]
    D --> I[Passport 追踪]
    I --> J{生命周期事件}
    J -->|Handover → Reclaim| K[安全]
    J -->|Handover → 无后续| L[泄漏]
{% end %}

两条通道在 CI 和开发环境中交替运行：OmniScope 在每次提交时扫描，确保没有新的 FFI 风险引入；memscope-rs 在集成测试中运行，捕获那些只有特定执行路径才会触发的生命周期问题。实际工作流中，开发者先通过 OmniScope 的 CI 检查获得一份 FFI 风险报告，然后在本地用 memscope-rs 对报告中的高风险点做针对性验证。这个流程把静态分析的广度和运行时追踪的深度结合在一起——前者告诉你哪里可能有问题，后者告诉你问题是否真的会发生。单独依赖任何一方都会有盲区：只做静态分析，你会被误报淹没；只做运行时追踪，你会漏掉那些未被测试覆盖的路径。

## 如果今天重新设计

回溯这些决策，有三件事值得重新考虑。

**OmniScope 的 PassContext 过于庞大。** 它是一个 50+ 字段的巨大 struct，所有 pass 共享。这导致了隐式的依赖关系——你不知道一个 pass 读了哪些数据、写了哪些数据。更好的设计是让每个 pass 显式声明它的读/写依赖，用类型系统强制隔离。

**memscope-rs 的 Passport 存储可能成为瓶颈。** 所有 passport 存在一个 `Arc<Mutex<HashMap>>` 中。在高频分配场景下（比如解析器或网络服务器），这个锁竞争会成为性能问题。`DashMap` 或分片锁是更合适的选择。

**两个项目应该互相利用。** OmniScope 的静态分析结果可以指导 memscope-rs 的运行时追踪——只对静态分析标记为高风险的 FFI 边界启用运行时追踪，大幅减少运行时开销。反过来，memscope-rs 发现的真实 bug 可以反馈给 OmniScope，作为规则优化的依据。具体实现上，OmniScope 的 FFI Auditor 可以在分析完成后输出一份 `high_risk_ffi.json`，包含每个高风险调用点的文件路径、函数名、违规规则编号和风险等级。memscope-rs 启动时读取这份清单，在 `MemoryPassportTracker` 中只为清单上的 FFI 边界启用 Passport 追踪，其余边界只做轻量级的 alloc/free 计数。这样运行时开销从"追踪所有跨边界的内存"降到"只追踪静态分析怀疑有问题的那几个点"，在生产环境的性能开销可以忽略不计，同时保留了对关键边界的完整可观测性。

这不是事后诸葛亮——这些想法在设计阶段都讨论过，但被"先让它工作"的优先级压下去了。这是工程中常见的权衡：完美设计和可交付产品之间的距离，往往就是这些被推迟的重构和技术债务。

---

*系列完结。五篇文章，五个项目的决策回溯。抽象、并发、错误处理、工具设计、安全边界——每个决策背后都有一个信任模型在起作用。*
