+++
title = "撒谎的设计模式"
date = 2026-06-12
description = "工厂、策略、观察者——教科书说它们解耦。可真实负载下，模式常常反噬：你为了「可扩展」引入了现在用不上的抽象。ARES 的 LLMService 七个方法（第一篇）、AHP 的通信协议（第二篇）落地时都跟教科书长得很不一样。这篇考古的是——设计模式什么时候从解药变成了新的债务，以及 ARES 哪次是被模式骗了。"
weight = 8
[taxonomies]
tags = ["Go", "Rust", "Design Pattern", "Architecture", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 撒谎的设计模式

先讲一个让我肉疼的故事。ARES 最早做多 Agent 通信时，我没用 Go channel，而是花了**整整两天**跟 RabbitMQ 搏斗——第一天装 Erlang、配 vhost、建 exchange、映射 binding key；第二天写了 200 多行胶水代码，就为了把一条消息从 Agent A 送到 Agent B。

等我终于跑完基准测试，端到端延迟从 **<1μs（Go channel）涨到了 2ms+——那是 2000 倍的减速**。而且这还不是网络延迟造成的，因为两个 Agent 就在同一个进程里。纯序列化和路由开销。

那一刻我想的是：**同一个进程、两个 goroutine，发个消息还得走网络？这他妈太荒谬了。**

于是我把 RabbitMQ 全删了，写了 AHP——一个不碰网线的纯进程内通信协议。这就是设计模式撒谎最典型的一课。

> **Problem**: 「要面向接口编程」「用策略模式解耦」「观察者模式降低耦合」——教科书句句是真理。可 ARES 的 `LLMService` 接口（第一篇）、AHP 的通信协议（第二篇），落地时都跟教科书长得很不一样。设计模式什么时候开始撒谎？

## 模式贩卖的是「未来的可能性」

每个设计模式推销时都带着一个隐藏状语：**「当你未来需要……的时候」**。

- 工厂模式：「当你未来要创建 N 种实现时。」
- 策略模式：「当你未来要切换算法时。」
- 观察者模式：「当你未来要加 N 个监听者时。」

问题来了：你**现在**需要吗？大多数情况下不需要。但你买了，因为「万一呢」。于是模式在你用不上的地方提前支取了复杂度。

ARES 第一篇讲的「抽象的债务」就是同一个病：抽象到什么粒度？做多了，接口本身变成维护负担。设计模式是抽象的具名版本——它比裸抽象更危险，因为它披着「最佳实践」的外衣，让你不好意思质疑。

## 真实负载会撕掉模式的包装

看 ARES 的 AHP 协议（第二篇）。教科书会建议你用消息队列 / 观察者模式做多 Agent 通信。我**真试过**——就是上面那两天。

> 我花了两天跟 RabbitMQ 搏斗……端到端延迟从 <1μs（Go channel）涨到 2ms+——2000 倍的减速。

消息队列这个「模式」在同一进程内是撒谎的：它解决的是「不同进程/机器要通信」的问题，而你面对的是「同一进程两个 goroutine」。模式答非所问，你还以为是自己用错了。

AHP 最后落在了 `internal/ares_ahp/message_queue.go` 里一个基于带缓冲 channel 的 `MessageQueue`，入队是非阻塞的：

```go
func (q *MessageQueue) Enqueue(ctx context.Context, msg *AHPMessage) (retErr error) {
    if q.closed.Load() { return errors.ErrQueueClosed }
    defer func() {
        if r := recover(); r != nil { retErr = errors.ErrQueueClosed }
    }()
    select {
    case q.messages <- msg:
        return nil
    default:
        return errors.ErrQueueFull
    }
}
```

非阻塞、锁无关地检查关闭标志、`defer recover()` 兜住 `send on closed channel` 的 panic——这些细节都不是「消息队列模式」教科书会告诉你的。它们是**同一个进程、同一个内存空间**这个真实约束逼出来的。

**模式不撒谎的时候，是你的问题恰好匹配它预设的场景。** 不匹配时，它比没有模式更糟——因为它用一套你不懂的间接层，把你简单的问题藏了起来。

## 模式用对的那次

也不是所有模式都在 ARES 里翻车。ARES 第一篇的 `LLMService` 接口就是用对了的例子——它抽象的是**行为**，不是数据：

```go
type LLMService interface {
    Chat(ctx context.Context, req ChatRequest) (ChatResponse, error)
    Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error)
    // ...
}
```

四个 provider（OpenAI / Ollama / DeepSeek / 本地）的差异是**真实存在的**，不是假想的未来需求。抽象它，是因为我明天就可能要切 provider，而调用方的业务代码一行都不用改。这跟 AHP 用 channel 而不是 MQ 是同一个判断：**通信双方就在同一进程，这是被实测确认的场景，不是想象。**

两条规律：

- 模式只为**已经存在的差异**服务，不为想象中的差异预支。
- 模式的价值在**它消除的重复**，不在它增加的「可扩展性」。

## 我当时信了模式，后来被打脸的地方

AHP 我自己写完后，诚实列过它的短板（第二篇的「What's Missing」一节），有几条是模式教我的反面教材：

- **没有广播**：想给多个 Sub Agent 发消息？你只能在 Leader 侧写 for 循环一个个发。有一次我要同时通知 6 个 Sub，等 Leader 发到第 3 个时，第 1 个已经执行完了——串行发送成了整个工作流的瓶颈。
- **重试策略太天真**：DLQ 的重试间隔是固定的，没有指数退避。有一次下游 API 挂了 10 分钟，DLQ 用固定间隔疯狂重试，把本就脆弱的局面搞得更糟。我事后才加了熔断逻辑——这本该从一开始就做。
- **「换个实现就行」是个谎言**：AHP 的很多语义（非阻塞入队、备份缓冲、共享内存心跳）都依赖 channel 的同步特性。等你真去换 gRPC 或 RabbitMQ，移植这些行为远比纸面上难——你需要重新实现一整套「看起来像 channel」的异步语义。抽象层能隔离接口，隔离不了语义差异。

> 我差点信了「换个 transport 就行」这句话。直到我认真想换 gRPC 时才发现：channel 的同步语义和异步网络消息队列根本不是一回事，那些我以为是「实现细节」的东西，恰恰是 AHP 能跑起来的原因。

## 结论

设计模式最大的谎言，是它让你觉得「用了就专业了」。事实上，**一个用对的简单 switch，胜过一个用错的设计模式一万倍**。

> 模式是工具，不是勋章。挂在身上不用的模式，和挂在墙上的猎枪一样——除了显摆和走火，没别的用。

判断一个模式该不该用，只看一句：**删掉它，明天会不会真的痛？** 如果答案是「不会，只是感觉不优雅」——那它就是在撒谎，删掉。

AHP 那 2000 倍的减速，是我交过最贵的「为想象中的未来预支复杂度」的学费。它教会我一件事：**模式对的时候，是你的问题刚好撞上它预设的场景；模式撒谎的时候，是你的问题还没到那个场景，你却提前把间接层买了单。**

---

*Next: [何时对异步说不](@/log/decision-archaeology/09-when-to-say-no-to-async.md) -- AHP 用 Go channel 做亚微秒级通信，goroutine 到处飞。但异步不是免费的信仰：ARES 的 Leader 曾因一个 goroutine 泄漏静默死亡 20 分钟才被发现。什么时候同步反而更诚实？*
