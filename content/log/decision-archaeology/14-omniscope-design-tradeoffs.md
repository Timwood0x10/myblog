+++
title = "OmniScope：从拒绝巨额白名单到妥协"
date = 2026-07-16
description = "OmniScope 选了 LLVM IR 层做跨语言 FFI 安全分析。它的设计史是一场持续的'拒绝—妥协'：拒绝 C++（不会写）、嫌 Rust 编译慢、用 Zig 写下第一个工具，最后又回到 Rust（omniscope-rs）；拒绝 AI 建议的巨型白名单，转而建 MemoryGraph + CallGraph 做上下文感知。这篇考古的是——为什么'不穷举危险函数'才是更诚实的静态分析。"
weight = 14
[taxonomies]
tags = ["Zig", "Rust", "LLVM", "FFI", "Static Analysis", "OmniScope", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# OmniScope：从拒绝巨额白名单到妥协

> **Problem**: 跨语言 FFI 是内存安全最大的盲区。但"分析 FFI"有太多做法——按语言逐个适配？维护一张危险函数黑名单？还是下沉到 LLVM IR？OmniScope 的设计史，就是一部不断拒绝"看起来最省事"方案、再被迫妥协的历史。

这篇我想诚实地把 OmniScope 的**每一次犹豫和每一次打脸**都写出来。因为它不是一个"我设计得很好"的故事，而是一个"我试了很多蠢办法，才慢慢逼近正确"的故事。它有三个真实的转折：语言选型、拒绝白名单、以及把妥协走成架构。

## 转折一 · 语言之路：C++ → Rust → Zig → Rust

第一个决策是"用什么写"。设计文档（`000-design.md`）里写得很坦诚，我一字没改：

> Initially, I didn't know what to do, choosing between Rust and C++. However, Rust's compilation speed was too slow... As for C++, I'm sorry, I'm not very good at it. So I switched to Zig.

这不是技术宣言，是诚实的取舍记录：

| 候选 | 结局 | 真实原因 |
|---|---|---|
| **C++** | 直接否 | "我不太会写"——不装懂 |
| **Rust** | 暂时搁置 | 编译太慢；而且分析 unsafe 本身要写大量 unsafe，和它的安全模型拧着 |
| **Zig** | 第一个工具落脚点 | 编译快、手动内存控制、我第一次用它写东西 |
| **Rust（omniscope-rs）** | 后来回归 | 生态成熟后做了一个平行的 Rust 实现 |

这条 C++ → Rust → Zig → Rust(omniscope-rs) 的路线，**不是朝三暮四，每一步都是在为同一个约束投降**：跨语言 FFI 的安全责任，必须下沉到"语言层以下"才能看清。谁当宿主语言不重要，只要它能帮我吃下 LLVM IR，就都能接受。

> 语言不是信仰，是工具。我在 Web3 是 Go，做内存工具在 Rust 和 Zig 之间流浪——**流浪不是没主见，是我把"看清 IR"这件事看得比"忠于某门语言"更重。**

## 为什么是 IR，不是 AST

很多 FFI 实现不限于 Rust↔C，还有 C↔C++、Go↔C。如果为每种语言各适配一套语法分析，是灾难级工作量。我意识到一个共同点：

> 这些语言都拿 LLVM 当编译器后端。所以 IR 层才是它们的交汇点。

于是 OmniScope 吃 `.ll` / `.bc`，不在源码目录上跑。入口在 `src/main.zig:73`，单模块分析由 `src/main.zig:171` 的 `runModulePipeline` 驱动；源码先被降成 LLVM IR，再被抬升回分析事实（`src/pipeline/pipeline.zig:66` 的 `PassContext` 建立共享事实空间）。

**选 IR 的代价也很清楚**：你放弃了源码级的变量名和注释，换来的是"一次理解、多语言通吃"。这是一笔我愿意付的账。

## 转折二 · 拒绝巨额白名单

这是整段设计史里最精彩的一次"拒绝—妥协"。

最初 TP（真阳性率）很低，低到我"甚至考虑过放弃"（设计文档原话）。我去问 AI，AI 建议加**白名单**。我同意了，实现了，然后发现：

> maintaining a very large whitelist was necessary, which wasn't what I wanted.

白名单的诱惑在于"立刻能降噪"。但它的代价是一座你永远维护不完的监狱——每支持一种语言、一个库，就要往名单里塞更多条目。名单越长，误报越少，可维护性越差，直到没人敢动它。

我拒绝了这座监狱，回头翻自己的笔记，做了一个更贵的决定：**建 MemoryGraph + CallGraph，在 IR 扫描时顺手记录完整调用栈，然后分析这张图**。只盯 FFI 部分，别的它不管。

结果 "surprisingly good"。这比白名单诚实：

> 白名单是"我枚举了所有危险函数"；图模型是"我理解了这段代码的上下文，能判断这个指针是不是正走在危险路径上"。前者是穷举，后者是理解。

## 图模型到底怎么判断"危险"

拒绝白名单只是口号，真正要回答的是：**一个指针，凭什么说它危险？** OmniScope 的核心答案在 `MemoryGraph.isOnDangerPath`（`src/semantics/memory_graph.zig:892`）——源码注释直接把它叫做"决定一个指针要不要管的那 ONE question"：

```zig
pub fn isOnDangerPath(...) DangerPathKind {
    // 1. 先看调用边：这个指针有没有作为 FFI 函数的实参？
    const arg_indices = graph.getCallArgsForPtr(ptr_val);
    for (arg_indices) |idx| {
        if (set.contains(graph.call_args.items[idx].callee_name)) return .ffi_arg;
    }
    // 2. 再看返回边：它是不是 FFI 函数的返回值？
    const ret_indices = graph.getCallRetsForPtr(ptr_val);
    for (ret_indices) |idx| {
        if (set.contains(graph.call_rets.items[idx].callee_name)) return .ffi_ret;
    }
    // 3. 最后看分配节点：是不是在 unsafe 区分配的？跨语言释放？
    const node = graph.nodes.get(ptr_val) orelse return .none;
    if (node.zone == .unsafe) return .unsafe_alloc;
    if (node.freed and node.alloc_lang != node.free_lang.?) return .cross_lang_lifecycle;
    // alias closure follows...
}
```

**这个顺序是决策，不是随便排的**：调用边必须排在分配节点前面。因为很多 FFI 实参根本没有分配记录——它们来自函数参数、外部返回、或早期 pass 没能恢复的源头。如果要求先有 `AllocNode`，就会漏掉最重要的边界流动情况。

一个指针在 LLVM IR 里经过 bitcast、load、store、传参、返回之后，会以好几个 SSA 值出现。所以还要做 **alias closure**（`traceAliasClosure`，`src/pass/analysis/danger_surface.zig:144`）——只标记原始指针会漏掉后续用法。这不是完整的别名分析，是**针对 FFI 指针家族的聚焦传播**。

{% mermaid() %}
flowchart LR
    A[潜在内存问题] --> B{在危险路径上?}
    B -->|否| C[过滤 / 降级为本地问题]
    B -->|是| D[FFI 相关问题]
    D --> E[更高审查优先级]
{% end %}

一个本地的 C `malloc`/`free` 配对，优先级可以很低；但一个指针穿过 FFI 参数、返回或回调，就值得人来看。**这就是"上下文感知"替代"危险函数穷举"的落地。**

## 转折三 · 妥协如何成熟：v0.2.0 的上下文架构

拒绝白名单不是终点，是起点。v0.2.0 把"图模型替代白名单"这条路走成了完整架构：

- **SurfaceClassifier**（`src/semantics/surface_classifier/...`）：先把函数分成 `user_code` / `dependency` / `boundary` / `standard_library` / `compiler_generated` / `runtime` / `unknown`。`boundary` 优先级最高，标准库和运行时默认跳过——本质是用"**可推理的分类**"替代"手维护的白名单"。
- **Issue Gate**（`src/pass/filter/issue_gate.zig`）：每条诊断在发出前过一遍语义证据门，置信度阈值 `0.85`。冲突或低置信度的证据**放行而非隐藏**——这又是对"白名单式一刀切"的拒绝。
- **Resource Contracts**（`src/resource/ffi_contract_db.zig`）：从"看见一个 `free`"升级到"释放配对是否正确"，例如 `SSL_new` 必须匹配 `SSL_free`，不是随便一个 free-like 函数。
- **SymbolGraph**（`src/ffi/symbol_graph.zig`）：模块级语言检测下沉到符号级，避免把一个混编 LLVM 模块当成单一语言。

一句话总结 v0.2.0：**从"找可疑模式"升级到"在报告之前，先理解语言边界、资源所有权和语义上下文"。**

## 藏在 pass 系统里的一个细节：一个 pass 挂了，不能瞎掉整个工具

真实世界的 IR 是脏的——链接不全、优化等级不同、缺 debug info、编译器差异。OmniScope 的 `PassManager.run`（`src/pass/manager.zig:193`）做了一个我很得意的决定：**graceful degradation**。

```zig
for (self.resolved_order.?) |idx| {
    self.passes.items[idx].run_fn(ctx, diag) catch |err| {
        diag.warn("pass '{s}' failed: {any}, degrading gracefully", .{ pass_name, err });
        pass_failures += 1;  // 记一笔，然后继续跑后面的 pass
    };
}
```

这不是"吞异常"。它背后是一个价值判断：

> 一个分析阶段挂了，不该把无关的证据一起清零。宁可交出"部分但真实"的结果，也不要因为一个不认识的 IR 模式就交白卷。

pass 之间的依赖用 Kahn 拓扑排序解（`src/pass/manager.zig:86`），缺依赖直接报 `MissingDependency`——因为**错误的 pass 顺序不只是配置错，它会产出错误的事实**。这和白名单的哲学一脉相承：宁可慢、宁可少，也不要"看起来对但其实错"。

## 这个决策欠了什么债

- **复杂度债**：MemoryGraph + CallGraph + 一整套 pass 流水线，比"一张白名单"重得多。早期 TP 低到我"甚至考虑过放弃"。
- **噪声债**：IR 优化、符号缺失、wrapper 横飞时，能恢复出的语义会变少——静态分析永远有天花板，`MemoryGraph` 的质量直接决定下游每个 pass 的质量。
- **学习债**：我自陈"甚至不太懂编译器"。下沉到 IR 层，等于在自己不熟的领地里开荒（这笔债其实从 12 篇离开 Web3 那天就开始欠了）。

但白名单的债更贵：**它随语言增长成线性膨胀的维护成本，且永远覆盖不了"名单之外的新模式"**。图模型至少让你"理解一次，覆盖一类"。

## 结论

> 白名单是静态分析的舒适区——它让你觉得自己在做事，其实只是在穷举。我拒绝当白名单的囚徒，妥协去建图：用"上下文感知"替代"危险函数穷举"。

OmniScope 的语言流浪（C++→Rust→Zig→Rust）和它对白名单的拒绝，是同一枚硬币的两面：**都不接受"看起来最省事"的答案**。白名单省事但会烂尾；Zig 顺手但后来还是回到 Rust 做平行实现——每一次"不将就"，都是在为"FFI 安全责任必须下沉到语言层以下"这个约束买单。

这正好呼应 10「重写还是演进」：不是旧的不好，是新的问题配不上旧的家。也呼应 13——13 在运行时看 Rust 内部的 ownership，14 在 IR 上看跨语言的 ownership，**它们是同一道题在信任边界两侧的两个投影**。

---

*Next: [把代码评审变成一场戏](@/log/decision-archaeology/15-code-review-drama.md) -- 从静态分析转到人：当评审结论太平，人就会自动忽略。CodeTribunal 的解法是往评审团里塞一个故意说错话的 agent。*
