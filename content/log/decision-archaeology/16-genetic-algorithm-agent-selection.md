+++
title = "用遗传算法给 Agent 选策略"
date = 2026-07-16
description = "ARES 的进化系统一开始是'单亲繁殖'：一个父策略突变出几个孩子，挑最好的替换自己。跑了几天发现 genetic drift——种群大小为 1，等位基因必丢。于是改写成'种群 + 交配'，再到 7 种选择算子、NSGA-II 多目标。而最深的一课不是算法，是一个漏写的初始化字段——它让我在博客里写了一个完全错误的结论，代价 26.97 分。"
weight = 16
[taxonomies]
tags = ["Go", "Agent", "Genetic Algorithm", "Evolution", "ARES", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 用遗传算法给 Agent 选策略

> **Problem**: ARES 要给 Agent 选"最好的策略参数"——temperature、top_k、tool_selector、search_depth…… 你怎么选？网格搜索？手调？还是让进化算法自己选？ARES 选了后者，且一路改了两次架构，还栽过一个让我公开打脸的跟头。

这篇的犀利点不在"GA 多厉害"，而在**我承认自己不知道答案**——包括不知道最佳参数，也包括曾经不知道自己代码里漏了一行。

## 最简方案：单亲繁殖

最开始的 GA 简单得像个玩具。进化系统（DreamCycle）已经有个 Mutator——把一个父策略突变成几个孩子，挑最好的，替换父策略：

```text
Parent → Mutate → [Child A, Child B, Child C] → Arena PK → Best Child → Replace Parent
```

每次只保留一个最优解。简单、高效。我当时反对"搞种群"的理由很直白：

> What's the point of a population? Only one strategy is deployed at a time — keeping suboptimal ones around just wastes memory.

听起来没错。直到跑了几天，问题浮出来了。

## 第一次改写：population=1 是致死剂量

第一次进化：temperature 从 0.7 突变成 0.3（赢了）。第二次进化：temperature 只能从 0.3 继续突变。如果 0.3 其实是个局部最优呢？**你已经把 0.7 这个等位基因弄丢了，永远拿不回来。**

这就是经典的 **genetic drift**——小种群 + 强选择压力 = 基因池快速萎缩。生物学里，种群跌破阈值后，等位基因会因随机采样丢失。我的系统种群大小是 1，**等位基因丢失是必然**。

于是第一次升级：从"单亲繁殖"改写成"种群 + 交配"。

```go
// internal/ares_evolution/genome/population.go
type Population struct {
    Agents      []*mutation.Strategy // 当前个体
    Size        int                  // 目标大小（默认 20）
    Generation  int
    rng         *rand.Rand           // 确定性随机源
    bestScore   float64
    paretoFront []*mutation.Strategy // NSGA-II 帕累托前沿
}
```

20 是 GA 领域的经验值：太小（<10）会 genetic drift，太大（>50）收敛太慢。

## 第二次改写：不是复杂度问题，是多样性问题

第一次升级后，GA 跑起来了：种群 20、精英保留、tournament 选择、uniform 交叉，一切正常。但几百代之后，第二个问题出现：

> 种群不再丢基因了，但收敛太快。Gen 1-5 多样性从 35% 掉到 12%，Gen 10+ 稳定在 8% 左右——所有个体长得一样。

这不是 bug，是 GA 的本性：**选择压力越强，收敛越快**。但快收敛不一定是好事——那个收敛点可能只是个局部最优。

我第一反应是调参数：提高突变率、降低存活率、增加精英数——收效甚微。直到意识到问题不在参数，在**机制**：只有 tournament 一种选择、只有 uniform 一种交叉、没有任何多样性保护（fitness sharing / crowding distance）。

于是第二次升级不是"加更多配置旋钮"，而是建一个**可插拔的算子架构**。现在的 GA 引擎有 **7 种选择算子、3 种交叉（含 3 种 prompt 继承模式）、4 种突变（含自适应分布），以及多目标 NSGA-II 优化**——全是可替换的策略，不是配置参数。

## 一个没人夸但很关键的层：打分怎么才不烧钱

GA 每代要给成百上千个策略打分。如果每个都调 LLM，账单会爆炸。所以 `TieredScorer`（`internal/ares_evolution/scoring/tiered_scorer.go`）用三层流水线——**能用便宜的一层，就绝不惊动贵的那层**：

```text
Tier 1: Cache      O(1) 命中，零成本
Tier 2: LLM        预算控制，准但贵
Tier 3: Heuristic  永远可用的兜底
```

其中预算控制那一层，我用了无锁的 CAS 自旋，而不是 Mutex——因为有 50+ goroutine 在并发打分：

```go
func (b *Budget) TryRecordLLMCall() bool {
    used := b.UsedLLMCalls.Load()
    for used < b.MaxLLMCalls {
        if b.UsedLLMCalls.CompareAndSwap(used, used+1) { return true }
        used = b.UsedLLMCalls.Load()
    }
    return false  // 预算用尽，自动降级到 Heuristic
}
```

效果很实在：在一台 M3 Max 上，每代评估 1000 个策略，只用 10-100 次 LLM 调用（取决于预算），其余全靠 cache + heuristic 兜底，整代开销约 32µs。**这是"承认不知道最佳答案"的配套设施——你要让系统敢于大量试错，前提是试错足够便宜。**

## 最狠的一刀：上线后"最佳策略"消失了

NSGA-II 多目标优化带来的，是最反直觉、也最诚实的改变。

GA 默认是单目标最大化：score 越高越好。但现实里策略质量不是一维的——成功率、质量、成本、延迟，四个维度互相拉扯：

| 维度 | 方向 | 权重 |
|---|---|---:|
| `success_rate` | 最大化 | 0.40 |
| `quality` | 最大化 | 0.25 |
| `cost` | 最小化 | 0.20 |
| `latency` | 最小化 | 0.15 |

单目标优化要求你把这些维度手动加权成一个分数——**可权重怎么定？** 不同任务类型可能需要不同权重。NSGA-II 的解法（`internal/ares_evolution/genome/multi_objective.go`）是非支配排序 + 拥挤度距离：

```go
// Pareto 支配：a 在 >=1 维严格优于 b，且任何维不更差
func ParetoDominance(a, b *mutation.Strategy) bool { ... }
```

跑 NSGA-II 和单目标 GA 最大的区别是：**不再有"Best Score"这回事了**。你得到的是一条 Pareto 前沿——前沿上每个策略都是"最优"，只是最优在不同维度上。那四个权重只在"需要一个标量分数来汇报"时才用，选择本身完全跑在 Pareto 排序上。

> 这对产品经理可能是灾难（"我到底用哪个？"），但对工程师是诚实的：现实里的策略质量天然是多维的。强行压成一维，只是把复杂度藏起来。

## 最深的一课，其实和 GA 无关：一行没写的初始化

我本可以把这篇写成一个漂亮的成功故事。但那不真实。真实的是——**我曾经基于错误数据，在博客里写下一个自信而错误的结论。**

当时我对比两种模式：Non-Wired（89.47 分）和 Wired（62.50 分）。差距 26.97 分，结论斩钉截铁：

> "Wired 模式是 GA 的探索瓶颈。别用它。"

我错了。不是分析草率，而是 `CreateWiredSystem`（`internal/ares_evolution/genome_wiring_system.go`）漏了一行初始化：

```go
// Before (buggy)：PromptTemplates 从没被赋值
wiredSystem := &WiredSystem{
    Population: pop, Genealogy: genealogy, Generation: generation,
    // PromptTemplates: PromptPool  ← MISSING
}
// After (fixed)：
wiredSystem := &WiredSystem{
    Population: pop, Genealogy: genealogy, Generation: generation,
    PromptTemplates: PromptPool,  // ← 就这一行
}
```

就这一行。没有它，所有 prompt 模板映射都是空的，**prompt 突变从未真正发生过**。症状是残酷的：

```text
Prompt mutations: 0 (0%)    ← 有 bug 的那次运行
Prompt mutations: 51 (17%)  ← 修复后
```

修复之后，结论彻底翻转：

| 场景 | 旧（带 bug） | 新（修复后） |
|---|---:|---:|
| Non-Wired | 89.47 | **79.41** |
| Wired（LLM final） | 62.50 | **85.90** |

那个 26.97 分的差距从来不存在。**它是个幽灵——一个漏写字段的产物。** 原来的结论"Wired 是瓶颈"完全反了：修复后 Wired 反而赢了 6.49 分。

这一课我愿意公开写出来，因为它比任何 GA 理论都值钱：

> 当你的 A/B 实验跑出一个让你意外的结果，第一个问题不该是"架构哪里错了"，而该是"我的初始化路径对吗"。你的数据，只和你的初始化路径一样可靠。

## 这个决策欠了什么债

- **复杂度债**：7 种选择 × 3 种交叉 × 4 种突变 × 多目标，引擎本身是头怪兽。新人上手成本极高。
- **不确定性债**：进化结果不保证可复现（虽然有确定性随机源，但选择/突变的随机性仍在）。它适合"探索策略空间"，不适合"我要一个确定答案"。
- **解释债**：当没有单一"最佳"，你怎么向老板汇报"Agent 现在用哪个策略"？NSGA-II 逼你面对这个原本被单目标分数藏起来的问题。
- **验证债**（最贵的一笔）：只要对比双方有一方"静默地少跑了一个组件"，你的对比就毫无意义——无论其余数据多干净。

但手调参数的债更贵：**它假设你（或我）知道答案**。而我越来越清楚，我不知道哪个 temperature / top_k / tool_selector 组合最好——尤其当任务分布随时间变化时。

## 结论

> 手调参数是你以为自己知道答案；遗传算法是你承认不知道，并让参数自己交配、自己淘汰。

ARES 的 GA 哲学贯穿始终：**别替用户做选择，给他们做选择的工具**（`genome_wiring_system.go` 的 `WiredEvolutionSystem` 只负责把 10+ 组件接起来，不预设"最佳配置"）。你不会在引擎里找到"最佳预设"，只会找到 7 种选择、3 种交叉、可定制参数范围、可插拔打分函数——组合起来，能应付从"快收敛"到"广探索"到"多目标权衡"的几乎所有场景。

这呼应 07「状态还是行为」：单亲繁殖是"我只信当前最优"；种群 + 交配是"我承认当前最优可能是局部，所以要保留多样性等未来翻盘"。也呼应 11「你跳过的测试」——那个 26.97 分的幽灵，本质就是一次没被验证的初始化假设。GA 不是"参数调优工具"，是**策略生成器**：它发现人类想不到的参数组合，持续适应变化的任务分布，并基于历史经验优化自己的进化方向。而它教我最狠的一课是——**先怀疑自己的设置，再怀疑世界。**

---

*（系列此分支暂告一段落。从离开 Web3、在 Rust 里做内存工具、OmniScope 的拒绝与妥协，到代码评审的戏剧与 Agent 的进化——它们的主线始终是同一句话：**谁拥有什么，以及如何看见那些被语言藏起来的所有权。** 而贯穿全部的态度只有一个：**承认自己不知道，然后造一个能看见的工具。**）*
