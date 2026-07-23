+++
title = "在\"以安全著称的 Rust\"里做内存工具"
date = 2026-07-16
description = "memscope-rs 追踪 Rust 程序的内存，而 Rust 恰恰以内存安全著称。悖论在哪？Arc<Rc> 是安全的抽象，却让所有权更难被观测——分配器只看到一个堆分配，逻辑上却是三个智能指针共享。这篇考古的是：为什么最安全的语言，反而最需要一个内存工具；以及同一道题，在越过 unsafe/FFI 信任边界后会变成什么样。"
weight = 13
[taxonomies]
tags = ["Rust", "Memory Safety", "Arc", "Rc", "memscope-rs", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 在"以安全著称的 Rust"里做内存工具

> **Problem**: Rust 的卖点就是内存安全——编译器保证没有 use-after-free、没有 data race。那在一个"已经安全"的语言里做一个内存追踪工具，是不是多此一举？memscope-rs 存在的理由，恰恰藏在 Rust 安全模型的盲区里。

## Rust 的安全，保的是"不 UB"，不是"可观测"

这是最大的认知陷阱。人们以为"Rust 不会内存泄漏，所以不需要内存工具"。错。Rust 的 borrow checker 保证的是**运行期不会出未定义行为**，它不保证你能**看见**自己的程序在做什么。

memscope-rs 的 `Arc/Rc` 检测篇开宗明义就点破了这件事：

> `Arc<T>` and `Rc<T>` are safe Rust abstractions, but they make ownership harder to observe.

安全抽象和可见性，是两件事。Rust 给了你前者，顺手拿走了后者的一部分。更讽刺的是：**Rust 越安全，ownership 越容易被它的安全抽象吃掉**——`Arc<Rc<Box<T>>>` 这种嵌套，Valgrind 只看得到最底下的那次 `malloc`，上面三层"谁共享了谁"它一概不知。

## 数据从哪来：两层叠加，不是一层魔法

很多人以为这类工具是"自动理解你的 Rust 程序"。不是。memscope-rs 把数据分成两个互补的来源，这个分层本身就是个决策：

1. **`GlobalAlloc` 抓运行时事实**：指针、大小、分配/释放事件——这是 ground truth；
2. **`track!` 宏 + `Trackable` trait 补 Rust 语义**：变量名、类型、源码位置——这是显式注入的上下文。

底层包装系统分配器，每次 `alloc`/`dealloc` 都记一笔：

```rust
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let _ = tracker.track_allocation(ptr as usize, layout.size());
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = tracker.track_deallocation(ptr as usize);
        System.dealloc(ptr, layout);
    }
}
```

真实实现里还藏了一个细节：分配器自己也会分配内存（记录元数据时就分配），所以要有一个 **thread-local 守卫** 临时关掉追踪，否则会无限递归。

```rust
thread_local! {
    static TRACKING_DISABLED: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}
```

这一层给的是**高置信度**数据：指针地址、分配大小、分配事件、释放事件、时间戳、线程 ID。但它**不知道**一个指针属于 `Vec<T>`、`String`、`Box<T>` 还是你自定义的类型。

## 最简方案：分配器视角的盲区

如果只从分配器（`GlobalAlloc`）的视角看，一段代码长这样：

```rust
let root = Arc::new(vec![1, 2, 3]);
let worker_a = Arc::clone(&root);
let worker_b = Arc::clone(&root);
```

分配器层面，**只看到一次堆分配**——`Arc::new` 那一下。另外两个 `Arc::clone` 不分配新用户对象，它们只是创建指向同一份堆数据的智能指针。

但从所有权视角看，现在有三个智能指针值共享同一块堆数据。问题从"内存分配在哪"变成了：

> 哪些被追踪的智能指针，指向了同一块堆数据？

分配器答不上来。它不知道 `Arc` 的存在，只知道"有人要了一块内存，又还回来了"。这就是为什么需要第二层——`track!` 把变量名、类型、文件、行号显式注入：

```rust
let users = vec![User::new("Alice"), User::new("Bob")];
track!(tracker, users);
// 宏展开后注入：变量名、file!()、line!()、module_path!()
```

这是**刻意显式**的设计——工具不假装能自动理解程序里每个变量。

## TrackKind：把 Rust 类型分成"内存角色"

不同的 Rust 类型，不该被当成同一种"伪堆分配"来建模。`TrackKind` 这个枚举是 memscope-rs 对类型语义的核心分类：

```rust
pub enum TrackKind {
    HeapOwner { ptr: usize, size: usize },
    Container,
    Value,
    StackOwner { ptr: usize, heap_ptr: usize, size: usize },
}
```

映射关系很讲究：

- `Vec<T>` / `String` / `Box<T>` → **`HeapOwner`**：它们真的在堆上拥有一块数据（用 `as_ptr()` + `capacity()` 估算大小）；
- `HashMap<K,V>` / `BTreeMap` / `VecDeque` → **`Container`**：故意保守，只报元数据，**不暴露内部容器指针**——免得把不稳定的内部布局当成用户堆缓冲；
- `i32` / `bool` 这类简单值 → **`Value`**：根本没有堆分配；
- `Arc<T>` / `Rc<T>` → **`StackOwner`**：智能指针值在栈上，但指向一份共享堆数据。

自定义类型用 derive 宏处理——它沿着实现了 `Trackable` 的字段走，估算大小。这不是完美的 layout 重建，但对应用层对象是务实的语义层：

```rust
#[derive(Trackable)]
struct UserProfile {
    id: u64,
    name: String,
    tags: Vec<String>,
}
```

## 真实开销：不是零成本，但要诚实

benchmark 日志显示，单变量追踪对小型被追踪值通常是亚微秒级：

| Benchmark | 近似耗时 |
|---|---:|
| `track_single/vec/64` | ~653 ns |
| `track_single/vec/1024` | ~666 ns |
| `track_single/vec/1048576` | ~4.93 µs |
| `track_multiple/variables/1000` | ~669.67 µs |
| `track_multiple/variables/10000` | ~6.59 ms |

诚实的解读是：绝对延迟对 profiling 够用，但日志里也包含相对历史运行的回归。性能要**按实测、且在演进中**来描述，而不是吹成"零成本抽象"。这点我特意不美化——一个内存工具自己如果开始撒"零成本"的谎，那它和那些被它揭穿的抽象没区别。

## memscope-rs 的回答：StackOwner 模型

项目没有去读 `ArcInner` 的私有布局（那是脆弱的——Rust 版本一升级，偏移量就可能变）。它用了一种可观测的关系建模：

```rust
impl<T> Trackable for std::sync::Arc<T> {
    fn track_kind(&self) -> TrackKind {
        let stack_ptr = self as *const _ as usize;     // 智能指针值的地址
        let heap_ptr = &**self as *const T as usize;   // 它指向的堆数据
        TrackKind::StackOwner { ptr: stack_ptr, heap_ptr, size: std::mem::size_of::<T>() }
    }
    fn get_ref_count(&self) -> Option<usize> { Some(std::sync::Arc::strong_count(self)) }
}
```

关键的区分在 `StackOwner` 里：`ptr`（stack_ptr）标识**智能指针值本身**的地址；`heap_ptr` 标识**它指向的共享堆数据**。`Rc<T>` 用完全相同的模型。这套做法**不读取私有的 `ArcInner` 布局**，它只观察"多个被追踪的智能指针值，指向了同一份堆数据"这个可观测关系。这是刻意的工程取舍：宁可少一点编译器级别的精确，也要避开随 Rust 版本漂移的脆弱假设。

关系推断时，按 `heap_ptr` 分组：

```text
root      stack_ptr = S1, heap_ptr = H
worker_a  stack_ptr = S2, heap_ptr = H
worker_b  stack_ptr = S3, heap_ptr = H
// 三个 StackOwner 共享 heap_ptr = H → 构成共享所有权组
```

同一个 `heap_ptr` 出现多次，就是一次 `ArcClone` 关系候选。循环引用、泄漏、所有权扇出，都从这条线索里长出来。

这一层能确信什么、不能确信什么，memscope-rs 自己写得很老实：

- **高置信度**：指针地址、分配大小、分配/释放事件、时间戳、线程 ID；
- **显式元数据**：变量名、类型名、源文件、行号、语义角色；
- **不直接知道**：每一次 borrow、每一次 move、每一次所有权转移——除非你显式 `track!` 了。

## 同一道题，越过信任边界之后

13 篇讲的是"Rust 内部"的 ownership 可见性。但 Rust 是**安全，直到你越过边界**——那个边界可能是 `unsafe` 块、裸指针、`std::alloc::alloc`、C 的 `malloc/free`，或者一个外部库返回的指针。

memscope-rs 没有声称能证明 unsafe 代码正确，它做的是给越过信任边界的内存发一张"护照"（memory passport）：

```rust
pub struct MemoryPassport {
    pub passport_id: String,
    pub allocation_ptr: usize,
    pub size_bytes: usize,
    pub type_name: String,
    pub var_name: String,
    pub status_at_shutdown: PassportStatus,
    pub lifecycle_events: Vec<PassportEvent>,
    // ...
}
pub enum AllocationSource {
    RustSafe,
    UnsafeRust { unsafe_block_location: String, call_stack: CallStackRef, risk_assessment: RiskAssessment },
    FfiC { resolved_function: ResolvedFfiFunction, call_stack: CallStackRef, libc_hook_info: LibCHookInfo },
    CrossBoundary { from: Box<AllocationSource>, to: Box<AllocationSource>, transfer_timestamp: u128, transfer_metadata: TransferMetadata },
}
```

它要回答的不是"有没有 malloc/free"，而是：

> 这块内存谁创建的？交给了外部代码吗？是 Rust 释放的还是外部释放的？它现在还押在外国 custody 里吗？

这正是 14 篇 OmniScope 要处理的问题的**静态版本**——只不过 13 是在运行时看 Rust 内部 + FFI 边界，14 是在编译后的 LLVM IR 上，看跨语言指针到底走了哪条危险路径。两者是同一道题的两面：**ownership 一旦被语言藏起来或越过边界，就需要专门的工具去重新照亮它。**

## 这个决策欠了什么债

- **覆盖债**：只有被 `track!` 显式追踪的 `Arc/Rc` 才会出现为 `StackOwner` 记录。你没 track 的 clone，它永远看不见（文章里也诚实写了 "cannot guarantee detection of clones that were never passed to `track!`"）。
- **精度债**：它检测的是"被观测到的共享所有权"，不是完整的 borrow/move 语义。它是一面放大镜，不是编译器。
- **心智债**：使用者必须主动在关键变量上插 `track!`，这本身是个负担——和 Rust "零成本抽象"的哲学有点拧着。
- **信任边界债**：unsafe/FFI passport 能做到"记录生命周期、识别可疑模式"，但做不到"证明外部代码遵守了所有权契约"。它是运行时可观测，不是形式化验证。

但这些债的对手方很清楚：**Rust 编译器在运行期把所有权交还给你之后，就什么都不看了。memscope-rs 不做这层，那段被藏起来的共享关系，就真的谁都看不见。**

## 结论

在 Rust 里做内存工具，听起来像个笑话——"语言都帮你管好了还管什么？"但这句话暴露的，是对"安全"两个字的误解。

> Rust 的安全是消极的：它承诺"我不会让你做错事"，从不承诺"你会看见自己在做什么"。而内存 bug 最阴险的地方，恰恰是你做"对"了事、却看不见自己埋下了什么。

Arc/Rc 是安全的，正因如此，它们把所有权扇出藏进了一个分配器看不到的层。`Arc<Rc<Box<T>>>` 这种嵌套，Valgrind 只看得到最底下的那次 `malloc`，上面三层"谁共享了谁"它一概不知——这正是 memscope-rs 存在的全部理由。

**最安全的语言，反而最需要一个能看穿它自己安全抽象的工具。** 因为那里的 ownership，最容易被安全本身吃掉。而在越过 FFI 边界之后（那是 14 篇的领地），这道题会从"运行时观测"升级为"静态分析能不能看清跨语言的指针契约"——答案同样残酷：大多数工具选择放弃，OmniScope 选择不将就。

---

*Next: [OmniScope：从拒绝巨额白名单到妥协](@/log/decision-archaeology/14-omniscope-design-tradeoffs.md) -- 同一道题跨到语言边界：静态分析怎么在不读每个语言语法的情况下，看清跨 FFI 的所有权协议？*
