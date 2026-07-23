+++
title = "离开 Web3 的那天"
date = 2026-07-16
description = "ethermint 是我 fork Evmos、把 Tendermint 移植到 sei-tendermint 写下的 EVM 链，Go 1.19、1465 次提交、跑了三年。写了三年共识代码之后，我离开了 Web3——不是因为它不好，是因为我终于承认：我根本不在乎谁先出块，我在乎的是 Valgrind 看不懂 Arc<Rc<Box>>>。"
weight = 12
[taxonomies]
tags = ["Go", "Web3", "EVM", "Memory Safety", "Career", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 离开 Web3 的那天

> **Problem**: 我 fork 了 Evmos 的 ethermint，把 Tendermint 共识移植到 sei-tendermint，写了一条 EVM 兼容链。共识、出块、状态机、EVM 兼容层——全栈都碰过，最后一条提交停在 2023-05-08，共 1465 次提交。然后某个时刻我意识到：这条路上最让我兴奋的，不是"谁先出块"，而是"为什么这段 Rust 代码的内存我看不见"。离开 Web3，是哪个决策？

## 先说清楚：以太网不是我随手写的玩具

它不是我 fork 来练手的 demo。仓库标题原话是：

> "fork from evmos and change tendermint to sei-tendermint"

分支名叫 `switch_consensus_to_sei_tendermint`。上游 ethermint 是什么？README 自己写的是：

> "Ethermint is a scalable and interoperable Ethereum library, built on Proof-of-Stake with fast-finality using the Cosmos SDK which runs on top of Tendermint Core consensus engine."

也就是说，这是一条**跑在 Cosmos SDK 上、用 PoS 拿快速最终性、但把 EVM 当状态机**的链。我的工作是把地基从 Tendermint Core 换到 Sei 定制的 sei-tendermint。技术栈是 Go 1.19+，依赖里 geth 升到了 v1.10.25、cosmos-sdk 固定在 0.46.11、iavl 0.19.4，协议层还把 LGPLv3 重新授权过（那次 relicensing 是 #800）。

我在这个仓库里动过的东西是具体的：

- **共识切换**：把整条链的出块引擎从 Tendermint 换到 sei-tendermint，意味着 proposal / prevote / precommit 那套 BFT 时序要重新接，出块间隔、超时参数、状态机 fork 逻辑都得重新校准；
- **EVM 兼容层**：`x/evm` 模块的 EIP-712 算法从 Evmos 迁过来（#1746），params 重构到单一 key 下（#1617）；
- **客户端边界**：`rpc` 默认绑定从 `0.0.0.0` 收紧到 `localhost`（#1613），`cmd` 支持自定义 db opener（#1615）；
- **依赖与安全**：因为安全修复 bump 了 btcd 和 cosmos-sdk（#1716）。

这些都是**扎实的分布式系统工程**。Tendermint 用 BFT 把"互不信任的节点如何就同一份账本达成一致"解决得很漂亮，调出块间隔、改状态机、处理 EVM 边界——没有一行是糊弄的。

## 但"扎实"不等于"让我在乎"

三年下来，一个事实越来越清楚：**共识解决的是"别人值不值得信"，而我真正睡不着觉的问题是"我自己的程序到底有没有偷偷漏内存"。**

前者是分布式系统的尊严，后者是每一个写 Rust 的人都在疼、却很少有人正面去治的伤口。我在 Web3 的每一天都在和"节点会不会分叉""状态机边界对不对"缠斗，但收工之后回过头，真正让我兴奋的瞬间，是看一段 Rust 代码时那个挥之不去的念头——

> 这块内存到底被几个智能指针共享了？循环引用是不是悄悄长出来了？编译器说"安全"，可它根本没告诉我它在干什么。

一个诡异的认知错位：我白天在 Go 里写共识，夜里却对 Rust 的内存模型念念不忘。语言错位本身就是信号——我的问题域，从来不在"谁先出块"。

## 那个刺痛我的瞬间

memscope-rs 的创立动机，我自己在项目里写得很直白：

> Valgrind doesn't know what `Arc<Rc<Box<...>>>` means, and someone has to fix that.

这句话是离开 Web3 的真正分水岭。Valgrind、AddressSanitizer 是内存工具的王者，但它们工作在 C/C++ 的抽象层。当 Rust 用 `Arc<Rc<Box<T>>>` 这种层层智能指针把所有权包起来时，传统工具**看不懂**——它们看到的是最底层的那次 `malloc`，上面三层"谁和谁共享了同一块数据"的语义，它们一无所知。

Web3 让我写了无数共识代码，可共识从不需要回答"这块内存被几个智能指针共享、循环引用有没有悄悄长出来"。那个问题，Valgrind 答不上来，Rust 编译器也只在编译期保证"不 UB"，运行期它把所有权交还给你，就不再管了。

GitHub 的 bio 我现在写的是 "former Web3 software engineer"。former 这个词不是否定，是归档——Web3 给了我工程纪律（一个 off-by-one 能让整条链分叉，这种对"正确性"的执念是刻进骨头的），但内存安全给了我一个**值得用余生去解决的问题**。

**所以离开不是逃离，是归位。** 我把在 Web3 练出来的"和复杂系统缠斗"的能力，搬到了一个更让我在意的主战场。

## 这个决策欠了什么债

诚实地说，离开是有成本的，而且成本不小：

- **语境债**：Web3 的分布式经验在内存安全领域大部分用不上。我从一个"知道 Tendermint 每个阶段在干嘛"的人，变回了一个要在 LLVM IR 里重新学起的新手（这一点在 OmniScope 篇会讲得更痛——光是读 IR 就够喝一壶）。
- **信号债**：外界看你的标签还是"Web3 工程师"，而你要做的工具面向的是系统程序员。解释"为什么一个前 Web3 的人在做内存追踪"本身就要消耗精力，而且很多人听完的潜台词是"你是不是 Web3 凉了才转行的"。
- **复利债**：共识领域我已经有深度，切换意味着那部分复利停了。1465 次提交攒下的直觉，在新的领域要从零开始计息。
- **社交债**：圈子里的人脉、讨论的语境、招聘市场的标签，全部要重建。

但这些债的对手方是：**每天做一件自己不在乎的事，复利再高也是空的。** 我在 10「重写还是演进」里写过——重写的正当信号是"过去不存在的约束出现了"。离开 Web3 不是重写一段代码，是重写我自己的问题域：约束从"如何在不信任的网络里达成共识"变成了"如何让一块被智能指针藏起来的内存变得可见"。问题域一换，旧标签的复利自然就清零了，拖着它反倒累赘。

## 如果今天重新选

我不会更早离开，也不会更晚。

早了，我还没有足够的系统功底去治那个我真正在乎的病——连 LLVM IR 都读不顺，谈什么内存追踪？晚了，沉没成本会让我连承认"我不在乎共识"都不敢，最后变成一边写链、一边在业余时间敷衍地搞工具，两头都做不深。

离开的时机刚好卡在：我在 Web3 攒够了"和复杂系统缠斗"的硬功夫，又还没被标签焊死。Web3 给我的最宝贵的东西不是技术，是**一种对"正确性"的执念**——分布式系统容不得含糊，一个 off-by-one 能让整条链分叉。这种执念搬到内存安全上，正好：内存 bug 也是那种"平时安静、爆发时毁灭性"的问题，和共识层的 bug 是同一类怪物，只是换了个战场。

> 我没有离开工程，我只是从"让互不信任的人达成一致"，搬到了"让一段被藏起来的内存重新被看见"。后者的观众更少，但我更想为它鼓掌。

---

*Next: [在"以安全著称的 Rust"里做内存工具](@/log/decision-archaeology/13-safe-rust-memory-tool.md) -- memscope-rs 的悖论：Rust 保的是"不 UB"，不是"可观测"。最安全的语言，反而最需要一个能看穿它自己安全抽象的工具。*
