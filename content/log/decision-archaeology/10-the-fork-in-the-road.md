+++
title = "重写还是演进"
date = 2026-06-12
description = "OmniScope 最早是 Zig 原型，后来改写成 Rust（omniscope-rs）；ARES 的前身叫 GoAgentX，整条系列从 GoAgentX 改名而来。每个项目都会撞上同一个岔路口：推倒重写，还是渐进演进？这篇文章考古的是——什么信号出现时，重写才不是傲慢，以及我分别在 OmniScope 和 ARES 上怎么走的这条路。"
weight = 10
[taxonomies]
tags = ["Rust", "Go", "Architecture", "Rewrite", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 重写还是演进

先讲一段我自己都觉得好笑的开场。OmniScope 最早选型时，我在 Rust 和 **C++** 之间犹豫。原话是：「I'm sorry, I'm not very good at it」——我不太会写 C++。于是先看 Rust，又嫌 **Rust 编译太慢**，改用了 **Zig** 写下第一个工具，后来才出 **omniscope-rs（Rust 重写）**。

所以 OmniScope 的语言路线是：C++ → Rust（太慢）→ Zig → Rust（omniscope-rs）。这不是朝三暮四，是每一步都在为一个约束投降。

> **Problem**: OmniScope 最早是 Zig 原型，后来改写成 Rust（omniscope-rs）；ARES 的前身叫 GoAgentX，整条系列从 GoAgentX 改名而来。每个项目都会撞上同一个岔路口：推倒重写，还是渐进演进？这条线到底该画在哪？

## 重写是最性感的逃避

程序员对重写有种本能的浪漫。现有代码「太脏了」「当时不懂」「架构不对」——重写的诱惑在于，它让你假装过去的自己不存在，从一张白纸重新开始。

但重写是最贵的决策之一。你丢掉的不只是代码，还有**代码里那些没写进文档的、靠踩坑换来的约束**。每一次 `// FIXME: don't remove this, it breaks X` 都是前任（往往就是你自己）用生产事故买的教训。重写时这些教训最容易一起被丢进垃圾桶。

所以「重写还是演进」从来不是技术审美问题，是**风险分配问题**。

## 真实的信号：约束变了，不是代码脏了

看 OmniScope 的改写。omniscope-rs 的起点是盯着 Rust 的 `CString::into_raw` 发呆——

> After that pointer is sent out, who is supposed to free it? Rust's allocator? C's `free`? Or some third-party library?

这个追问不是「代码写得丑」，而是**问题域的约束被重新认识了**：跨语言 FFI 的内存安全责任边界，比最初原型设想的更锋利。Zig 原型验证了这个方向值得做，但真正要落地 21 个分析 pass、处理真实的多语言调用图时，语言级的内存安全保证从「nice to have」变成了「前提条件」。

**重写的合理信号是：底层约束变了，旧代码的根基假设已经不成立。** 而不是：旧代码难读了、你想用新框架了、上级要求了。

这里还有个细节值得单独拎出来。AI 当初建议给 OmniScope 加一个**白名单**来识别危险函数，我实现了，结果发现——

> maintaining a very large whitelist was necessary, which wasn't what I wanted

维护一个巨型白名单不是我想要的。于是我回头，建了 **MemoryGraph + CallGraph** 做上下文感知，用「图模型」替代「穷举危险函数列表」。这同样是个「重写式」的决策：不是推倒代码，是推倒「白名单能解决问题」这个假设。

## 演进的代价被低估

反过来，渐进演进的陷阱是：你永远在给一个错误的根基打补丁。ARES 从 GoAgentX 改名这件事本身就有信息量——改名意味着**对外契约变了**，但底层还是同一套 Go 代码在演进。这不是重写，是「演进到一定程度，连名字都装不下自己了」。

ARES 自己在这条路上也踩过坑。最早我想让 Agent「长命且坚韧」，试过熔断、重试循环、优雅降级——

> It worked — until it didn't.

问题是你预测不了每一种失败模式。一个 goroutine 泄漏、一个死锁、一次 OOM kill——再多的防御性编码也覆盖不全。所以 ARES 最后选了**让 Agent 可丢弃**：它死了，Runtime 就造个新的，从 EventStore 恢复状态。这反而是最诚实的演进：与其给一个会错的根基不断打补丁，不如承认「任何失败都可恢复，因为你永远有个干净的起点」。

## 连 ARES 自己，也被「重写」反噬过

ARES 的诞生本身也是一次重写——从 Python 到 Go。我当初的动机很私人：有 HR 说我不会 Go、没有 Go 项目。作为一个有职业骄傲的开发者，**我必须选 Go，堵住所有质疑**。

这话现在看有点赌气，但它也是「重写信号」的反面教材：我重写，有一部分动力不是「约束变了」，而是「想证明自己」。这类重写往往最贵，因为它带着情绪，容易 over-engineer。

更要紧的是 ARES 自己的诚实复盘（第一篇）：

> The codebase is bigger than it needs to be... the periphery is still finding its shape.

量化交易模块、面试 demo、MCP dashboard——这些本该住在独立仓库里的实验，全塞进了 ARES。核心（Runtime + Workflow + Memory + Events）是扎实的，外围还在找形状。也就是说，**即使那次从 Python 到 Go 的重写方向是对的，它也没能躲开「重写会膨胀」这个老毛病**。重写修好了根基，但新家的墙一样会越垒越多。

把这件事和 OmniScope 放一起看更有意思：OmniScope 的重写（Zig → Rust）信号是**技术约束**（FFI 安全责任必须下沉到语言层），ARES 的重写（Python → Go）信号里混着**个人赌气**。前者我至今觉得诚实，后者我至今觉得「方向对、动机脏」。值不值得重写，不但要看约束，还得看你自己是不是在借题发挥。

## 我当时怎么想的，又错在哪

我重写 ARES 时（从 Python 到 Go），理由是「Python 并发又慢又乱，内存管理是灾难，工作流逻辑退化成回调和状态机的意大利面」。这个重写是对的——新约束（要并发、要长运行、要可观测）旧根基确实扛不住。

但我必须诚实：**ARES 的代码库比它需要的更大**。量化交易模块、面试 demo、MCP dashboard——这些是应该住在独立仓库里的实验。核心（Runtime + Workflow + Memory + Events）是扎实的，外围还在找形状。

> 真实项目就是这样工作的。你不会在第一天设计出完美架构。你解决问题、累积代码、偶尔停下来重构。

所以「重写还是演进」这道题，我现在的答案比开头那句「重写最性感」复杂得多：**重写不是对旧代码的审判，是对新约束的投降。** 值不值得，只看那个新约束是不是真的「旧根基成立不了」，而不是「旧代码我不喜欢了」。

## 结论

判断重写与否，我只看一个问题：**你是在逃避过去的决策，还是在响应一个过去不存在的约束？**

- 如果是前者——你只会把同样的坑再踩一遍，只是换身衣服。
- 如果是后者——比如 OmniScope 发现 FFI 安全责任必须下沉到语言层以下，比如 ARES 从 GoAgentX 长成连名字都装不下——那重写不是傲慢，是诚实。

> 重写不是对旧代码的审判，是对新约束的投降。

值得重写的系统，往往不是最烂的系统，而是**最诚实地暴露了一个它诞生时还不存在的问题**的系统。OmniScope 从 C++ 流浪到 Zig 再回 Rust，GoAgentX 长成 ARES，都是这个样子——不是旧的不好，是新的问题配不上旧的家。

---

*Next: [你跳过的那条测试](@/log/decision-archaeology/11-the-test-you-skipped.md) -- ARES 用 Arena 主动「谋杀」运行中的 Agent 来验证自愈（第九篇）。但大多数团队跳过了最该测的东西——不是功能，是「它死的时候怎么办」。哪些测试你明知道该写却没写？*
