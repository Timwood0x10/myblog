+++
title = "并发的本质是信任"
date = 2026-06-12
description = "memscope-rs 追踪内存分配，每秒数十万次事件。并发策略选错了，追踪器本身就成了性能瓶颈。从无锁到 Mutex，信任模型决定架构。"
weight = 2
[taxonomies]
tags = ["Rust", "Concurrency", "Lock-Free", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 并发的本质是信任

> **Problem**: 你要追踪别人的内存分配，但追踪器自己也有内存分配。你要检测性能问题，但追踪器不能成为性能问题。当每秒有数十万次 alloc/dealloc 事件涌入，并发策略选错了，追踪器本身就成了瓶颈。

memscope-rs 面临的困境是元级别的：一个性能分析工具，自己必须是高性能的。如果追踪器在高并发下退化，它测出来的数据就不值得信任——观察者效应会扭曲测量结果。

这个项目里同时存在无锁结构和 Mutex，不是因为架构不一致，而是因为**并发策略的选择本质上是对"这段代码会被谁访问"的信任判断**。

## 追踪器的悖论

一个内存追踪器要做什么？拦截每一次 `alloc` 和 `dealloc`，记录地址、大小、时间戳、调用栈。这意味着每一次内存操作都会触发追踪器的代码路径——这个路径必须足够快，否则用户程序的性能特征就被扭曲了。

但追踪器自身也需要内存：存储事件的队列、记录活跃分配的 map、统计计数器。这些数据结构在并发环境下的表现，直接决定了追踪器是"透明的"还是"侵入性的"。

这不是一个技术选型问题。这是一个信任问题：你有多信任调用者的访问模式？

## 无锁路径：ThreadLocalTracker

热路径上的追踪器选择了无锁数据结构：

```rust
// src/capture/backends/lockfree_tracker.rs:29-43
pub struct ThreadLocalTracker {
    thread_id: ThreadId,
    events: Arc<SegQueue<Event>>,                    // crossbeam 无锁队列
    active_allocations: Arc<DashMap<usize, usize>>,  // dashmap 无锁并发 map
    total_allocations: AtomicU64,
    total_allocated: AtomicU64,
    peak_memory: AtomicU64,
    // ...
}
```

三个选择，三种信任模型：

- **`SegQueue`**：crossbeam 的无锁队列。信任"多个生产者可以并发 push，消费者按序消费"。不需要外部锁，因为 CAS 操作保证了原子性。
- **`DashMap`**：分段锁并发 map。信任"key 天然去重"——同一个内存地址不会被两个线程同时分配。分段锁把竞争概率从全局降到 1/N。
- **`AtomicU64`**：原子计数器。信任"计数器的增量操作是独立的"——一个线程加 1 不依赖另一个线程的当前值。

但 `peak_memory` 的更新逻辑揭示了一个微妙之处：

```rust
// src/capture/backends/lockfree_tracker.rs:87-117
while new_active > current_peak {
    match self.peak_memory.compare_exchange_weak(
        current_peak, new_active, Ordering::Relaxed, Ordering::Relaxed,
    ) {
        Ok(_) => break,
        Err(actual) => {
            current_peak = actual;
            backoff_count += 1;
            if backoff_count < MAX_BACKOFF_ATTEMPTS {
                std::hint::spin_loop();
            } else if backoff_count < MAX_BACKOFF_ATTEMPTS * 2 {
                std::thread::yield_now();
            } else {
                std::thread::sleep(std::time::Duration::from_micros(1));
            }
        }
    }
}
```

三级退避——`spin_loop` -> `yield_now` -> `sleep`——是因为 peak_memory 的更新频率远低于 alloc/dealloc 计数器。分配计数器每秒可能更新数十万次，而峰值内存只在新记录超过旧记录时才需要 CAS。对高频计数器用 `Relaxed` ordering，对低频峰值用 CAS loop 加退避。**不是所有原子操作都需要相同的保证**，这是一个经常被忽略的精度选择。

## Mutex 路径：AsyncTracker

对比之下，AsyncTracker 走了完全不同的路：

```rust
// src/capture/backends/async_tracker.rs:167-172
pub struct AsyncTracker {
    allocations: Arc<Mutex<HashMap<usize, AsyncAllocation>>>,
    stats: Arc<Mutex<AsyncStats>>,
    profiles: Arc<Mutex<HashMap<u64, TaskMemoryProfile>>>,
    initialized: Arc<Mutex<bool>>,
}
```

四个字段，四个 `Mutex`。这不是偷懒，而是一个精确的信任判断。

AsyncTracker 追踪的是 tokio task 的生命周期事件——`task_start`、`task_end`、`task_spawn`。这些事件的频率远低于 per-allocation 事件。一个 tokio task 可能分配数百万次内存，但整个 task 的生命周期只有开始和结束两个事件。

在低竞争场景下，`Mutex` 的优势是明确的：代码简单、bug 可预测、调试容易。无锁结构的复杂性在低竞争场景下是纯粹的负担——你为"几乎不会发生"的高竞争场景付出了认知成本，却没有任何回报。

关键洞察：**并发策略不是"越快越好"，而是"匹配访问模式"**。

## 行业对比

| 方案 | 代表 | 优势 | 劣势 |
|------|------|------|------|
| 全 Mutex | 大多数原型项目 | 简单 | 热路径竞争严重 |
| 全无锁 | 高频交易系统 | 性能极致 | 代码复杂，bug 难查 |
| 混合策略 | memscope-rs | 按场景选最优 | 需要准确判断哪个路径是热的 |

全 Mutex 的问题是**在热路径上付出不必要的代价**。如果你的 alloc 回调每秒被调用 50 万次，每次都要拿锁，那锁的开销会吞掉追踪器 30% 以上的性能。

全无锁的问题是**代码复杂度在冷路径上是浪费**。如果你的 task 生命周期事件每秒只有几百次，用 DashMap 替换 HashMap 加 Mutex 是自找麻烦——你引入了更难调试的并发原语，却没有获得可测量的性能收益。

混合策略的代价是**需要准确判断哪个路径是热的**。判断错了，你就把 Mutex 放在了热路径上，或者把无锁结构放在了冷路径上——两种错误都是浪费。

以高频交易系统为例，全无锁架构的真实代价远超"代码复杂"这四个字。一个典型的订单簿更新路径会遇到 ABA problem：线程 A 读取地址 P 的值为 X，被挂起；线程 B 把 P 改成 Y 又改回 X；线程 A 恢复后 CAS 成功，但它操作的已经是不同的对象了。修复 ABA 需要引入 tagged pointer（高位存储版本号）或 hazard pointer，每种方案都增加了内存屏障和 cache line bouncing。更隐蔽的是 memory ordering 的微妙之处——`Acquire` 和 `Release` 的配对关系一旦写错，bug 只在特定 CPU 微架构、特定编译器优化级别下才复现，valgrind 和 ThreadSanitizer 都帮不上忙。memscope-rs 追踪的是内存分配事件，不是纳秒级的订单匹配。它不需要处理 ABA（每个分配地址天然唯一），不需要 tagged pointer（DashMap 的分段锁已经把竞争降到可接受范围），不需要纠结 `Acquire/Release` 配对（计数器的 `Relaxed` ordering 有明确的语义依据）。选对信任模型，就是选对了你需要解决的问题空间。这不是"偷懒用 Mutex"或"炫技用无锁"的问题——是你愿意为哪种复杂度买单的判断。

## 四层并发策略表

memscope-rs 的并发策略不是随意选择的，而是一个分层的信任模型：

| 组件 | 数据结构 | 信任模型 |
|------|---------|---------|
| ThreadLocalTracker | SegQueue + DashMap + AtomicU64 | 信任自己：单线程独占，零竞争 |
| MemoryTracker (core) | DashMap + AtomicU64 | 半信任：多线程读写，但 key 天然去重 |
| AsyncTracker | Arc<Mutex<HashMap>> | 不信任：多 tokio worker 线程共享 |
| GlobalTracker | RwLock<Option<Arc>> | 极不信任：全局单例，写少读多 |

信任层级从上到下递减，同步开销从上到下递增。这是正确的：你信任越多，你付出的同步代价越少。

`RwLock` 在 GlobalTracker 里的选择尤其精确：全局单例在初始化时写入一次，之后只被读取。`RwLock` 允许多个读者并发，写者独占——完美匹配"写少读多"的模式。如果用 `Mutex`，读者之间也会互斥，白白浪费性能。

## 策略自动选择

并发策略不应该由用户手动指定。memscope-rs 用运行时环境检测来自动选择：

```rust
// src/capture/backends/unified_tracker.rs:36-47
pub enum TrackingStrategy {
    GlobalDirect,     // 单线程：不需要同步
    ThreadLocal,      // 多线程：线程本地存储
    TaskLocal,        // 异步：task 本地存储
    HybridTracking,   // 混合：thread-local + task-local
}
```

```rust
// src/capture/backends/unified_tracker.rs:312-325
fn select_strategy(environment: &RuntimeEnvironment) -> MemScopeResult<TrackingStrategy> {
    match environment {
        RuntimeEnvironment::SingleThreaded => TrackingStrategy::GlobalDirect,
        RuntimeEnvironment::MultiThreaded { .. } => TrackingStrategy::ThreadLocal,
        RuntimeEnvironment::AsyncRuntime { .. } => TrackingStrategy::TaskLocal,
        RuntimeEnvironment::Hybrid { .. } => TrackingStrategy::HybridTracking,
    }
}
```

这个映射关系的本质是：**环境告诉你有多少线程，策略告诉你需要多少信任**。单线程不需要信任任何人，所以不需要同步。多线程需要信任"线程本地存储的隔离性"。异步运行时需要信任"task 边界的隔离性"。混合环境最复杂，需要同时信任两种隔离模型。边界情况是：如果用户程序同时包含同步多线程代码和异步代码（比如 tokio runtime 内部 spawn 了 `std::thread`），运行时环境检测会命中 `Hybrid` 分支，选择 `HybridTracking`——它同时维护 thread-local 和 task-local 两套追踪器，在合并阶段做去重，确保不遗漏也不重复计数。这个设计的精妙之处在于：两套追踪器各自使用最适合自己的并发策略，互不干扰，合并时的去重逻辑才是唯一需要协调的地方。

## 决策树

{% mermaid() %}
flowchart TD
    A[数据被几个线程访问？] --> B{访问模式}
    B -->|1 个线程| C[无同步，直接操作]
    B -->|N 个线程，key 去重| D[DashMap 分段锁]
    B -->|N 个线程，复合操作| E[Mutex]
    B -->|N 个线程，读多写少| F[RwLock]
    C --> G[ThreadLocalTracker ✓]
    D --> H[MemoryTracker ✓]
    E --> I[AsyncTracker ✓]
    F --> J[GlobalTracker ✓]
{% end %}

## 如果今天重新设计

回顾这些决策，有三处可以做得更好：

**AsyncTracker 的 Mutex 可以替换**。当时用 `Mutex<HashMap>` 是因为"不想花时间评估"。实际上 tokio 的 `task_local!` 已经隔离了大部分并发——每个 task 有自己的 `TaskLocalTracker`，真正需要跨 task 共享的只有 `task_start` 和 `task_end` 事件。这部分竞争可以用 `DashMap` 解决，去掉大部分 `Mutex`。

**ThreadLocalTracker 的 `RefCell` 有隐藏成本**。`thread_local! + RefCell` 的组合在设计上是对的——单线程独占，运行时 borrow check 保证安全。但 `RefCell` 的运行时 borrow check 在热路径上有成本：每次 `borrow()` 内部执行一次 `AtomicIsize` 的 `load`（虽然是 `Relaxed` ordering，但仍然是原子指令），再跟 0 比较判断是否存在活跃的 `borrow_mut()`；`borrow_mut()` 则需要 `compare_exchange` 把引用计数从 0 设为 -1。在每秒数十万次的 alloc 回调里，这个检查是可观测的。更关键的是，这些检查是纯粹的冗余——`thread_local!` 保证了单线程访问，`RefCell` 的 borrow check 永远不会 panic，却每次都在付出成本。替代方案是直接使用 `unsafe Cell`：

```rust
// 替代 RefCell 的 unsafe Cell 方案
thread_local! {
    static TRACKER: UnsafeCell<ThreadLocalTracker> = UnsafeCell::new(...);
}

// 安全理由：thread_local! 保证单线程访问，无需 borrow check
fn record_event(event: Event) {
    TRACKER.with(|ptr| {
        let tracker = unsafe { &mut *ptr.get() };
        tracker.push(event);
    });
}
```

这里的 `unsafe` 边界是良性的：`thread_local!` 提供了单线程保证，`Cell` 的 `get()` 返回的是指针而非引用，不存在 aliasing 问题。代价是丧失了编译器的 borrow check 保护——如果未来有人错误地在闭包内创建两个 `&mut` 引用，UB 就会出现。这需要通过代码审查和文档约束来弥补，是用安全检查换性能的经典权衡。

**`Ordering::Relaxed` 需要文档**。所有计数器用 `Relaxed` ordering 是正确的——计数器的增量操作是独立的，不需要 happens-before 保证。但代码里没有解释为什么选择 `Relaxed`。这是给未来维护者的信任声明：你必须理解"为什么不需要更强的 ordering"，才能在修改时不引入错误。缺失的注释是一种技术债。

---

*Next: [错误是设计的镜子](@/log/decision-archaeology/03-errors-are-mirrors.md) -- goagent 的 Agent Recovery + CodeTribunal 的 Troublemaker：系统怎么对待失败，暴露了什么设计哲学？*
