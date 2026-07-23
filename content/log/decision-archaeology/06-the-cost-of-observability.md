+++
title = "可观测性的代价"
date = 2026-06-12
description = "ARES 用事件溯源把 Agent 每一步都记成不可变事件，崩溃后能靠重放重建状态；Flight Recorder 给 Agent 装了黑匣子。但记录不是免费的：事件存储无限增长、全量 dump 会把人淹死。这篇考古的是——记到什么程度才不算过度，以及「敢忘多少」才是可观测性的真正上限。"
weight = 6
[taxonomies]
tags = ["Go", "Observability", "Event Sourcing", "Flight Recorder", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 可观测性的代价

我见过最吓人的 bug，不是崩溃，是**「活着，但死了」**。

有一次生产环境里一个 Agent 就这么停了——没崩溃、没 OOM，进程好好的，goroutine 也活着，就是不干活。我查日志，日志说一切正常；查 LLM 调用，返回也正常；查工具调用，全都成功。最后花了**两天**才定位到：Agent 把 LLM 的 JSON 结果解析错了，重试了五次全失败，然后落进一个**没人想到要去检查的分支**——它静默跳过了剩下的所有步骤，没有报错、没有重试、没有任何失败迹象。

那两天教会我三件事：日志里写「一切正常」，通常意味着你记错了东西；最危险的系统故障不是崩溃，是**静默地什么都不做**；以及，我得给 Agent 装个黑匣子。

但黑匣子这个念头，又来自更早的一次痛。一个 Agent 下午在生产环境跑了一整个下午，处理了 30 多个用户请求，每个都涉及多轮对话和工具调用。然后进程被 OOM 杀掉，日志里只有一行 `signal: killed`。所有状态全没了——没有 checkpoint、没有恢复路径、不知道它死的时候在干什么。用户来问「Agent 怎么不回话了」，我只能说「它失忆了」。

这两件事，正是 ARES 事件溯源和 Flight Recorder 的出生证。也是这篇要考古的起点：**记录一切的诱惑，和它背后那笔迟早要还的账。**

> **Problem**: 既然把每一步都记下来能救命，为什么不记更多？每步都打点、每个分支都埋日志、每个 goroutine 都上 trace。记少了出事查不到，记多了可观测性本身成了瓶颈——不压缩的事件存储会反噬，全量的原始 dump 会把人淹死。记录到底该做到什么程度？

## 记录一切的诱惑，和我踩过的第一个坑

事件溯源的思路很迷人，一句话就能讲清：**不要存当前状态，存每一个改变状态的操作。想要当前状态？自己重放去算。**

ARES 的 `internal/ares_events/types.go` 里，每个事件都被打上 `ModuleName`：

```go
type Event struct {
    ID         string         `json:"id"`
    StreamID   string         `json:"stream_id"`
    Type       EventType      `json:"type"`
    ModuleName string         `json:"module_name,omitempty"`
    Payload    map[string]any `json:"payload"`
    Metadata   map[string]any `json:"metadata,omitempty"`
    Version    int64          `json:"version"`
    Timestamp  time.Time      `json:"timestamp"`
}
```

`ModuleName` 记的是「这条事件是谁发出的」——runtime、workflow、memory。这东西听起来不起眼，直到你试着重放一条事件流，发现你分不清 `step.started` 是 workflow 引擎发的还是插件总线发的。没有它，你得靠 payload 的形状反推来源；有了它，你一看就知道。

这很容易让人上头。既然记下来能救命，那为什么不记更多？我把记录当成银弹，结果差点把自己淹死——**可观测性不是免费的。**

## 不压缩的事件存储，会反过来咬你

ARES 事件系统自己就承认了这件事。`internal/ares_events/compactor.go` 里的 `CompactionConfig` 是这么定义的：

```go
type CompactionConfig struct {
    Threshold              int           // Events triggering compaction (default: 500)
    KeepRecent             int           // Raw events to retain (default: 100)
    MaxSummariesPerStream  int           // Max summaries per stream
    SummaryTTL             time.Duration // Summary retention (default: 30 days)
    EnableTrimming         bool          // Delete raw events after compaction
}
```

默认行为：当一个 stream 超过 500 条事件，把最旧的 400 条压缩成一个 summary，只保留最近 100 条原始事件。

这暴露了一个自我否定的闭环：**为了能重建状态而记录一切，结果记录本身需要被「遗忘」才能活下去。** 事件流是只追加（append-only）的，Agent 跑得越久，事件越多，存储无限增长。Compactor 的存在就是证据——它把旧事件压缩成快照，否则事件存储本身会变成系统最严重的内存/磁盘负债。

一个不敢删数据的系统，终将被自己记录的东西压垮。ARES 的诚实之处，在于它没把事件溯源当成银弹——它建了 Compactor，等于亲口承认**遗忘是可观测性的一部分**。

## 记什么，比记多少更重要

Flight Recorder 刚设计时也喊过「记录一切」。任何事件都能进 Timeline。但我后来发现：**不是所有数据都值得记。** 真正该问的不是「能不能记」，而是「从这些数据里能不能挖出有用的调试信息」。

Flight Recorder 现在记这些：

| 记录项 | 例子 | 为什么值得 |
|---|---|---|
| 每次 LLM 调用的起止和 token 消耗 | type=llm.call | Timeline 里能看到耗时分布 |
| 每次工具调用的参数和结果 | type=tool.call | 出错时能定位是哪个工具 |
| 每个 Agent 决策 | Candidates/Selected/Reason/Confidence | 调试「为什么选了这个工具」的黄金数据 |
| 记忆蒸馏的输入/输出比 | CompressionRatio | 知道压缩了多少 |

它**不记**这些：

| 不记项 | 原因 |
|---|---|
| LLM 的完整回复文本 | 几十 K token 的原始文本你永远不会去读 |
| 工具的完整输出 | 太臃肿、太噪，对黑匣子没用 |
| 每一次细粒度状态迁移 | 廉价噪声，淹没真正有用的元数据 |

这里有个很妙的实现细节。Timeline 算总时长，用的不是「所有 Duration 简单相加」，而是时间轴范围 `max(EndAt) - min(StartAt)`：

```go
if len(t.events) > 0 {
    minStart := t.events[0].StartAt
    var maxEnd time.Time
    for _, e := range t.events {
        if e.StartAt.Before(minStart) { minStart = e.StartAt }
        if !e.EndAt.IsZero() && (maxEnd.IsZero() || e.EndAt.After(maxEnd)) {
            maxEnd = e.EndAt
        }
    }
    if !maxEnd.IsZero() && maxEnd.After(minStart) {
        summary.TotalDuration = maxEnd.Sub(minStart)
    }
}
```

好处是：**事件之间的空隙（空闲/等待时间）被算进去了**。一次 LLM 调用花了 3 秒，一次工具调用花了 2 秒，中间 Agent 闲等了 5 秒——相加只给你 5 秒，而 `maxEnd - minStart` 给你 10 秒。那 5 秒的空闲，恰恰是你最该去查的等待/阻塞。

> 可观测性的上限，不是你能记多少，而是你敢忘多少。

代价也得摊开讲。Timeline、Graph、DecisionLog 的每次读操作，返回的都是内部 slice 的**深拷贝**（defensive copy），保证调用方随便改返回数据都不会破坏 Flight Recorder 的内部状态。但代价是每次读都是 O(n) 的内存分配和拷贝。Dashboard 每 5 秒轮询一次、每次返回 5000 条事件——那就是每 5 秒一次 `make([]TimelineEvent, 5000)` + `copy`。高频率轮询下，这东西会成瓶颈。我留了个 `EventsSince(t)` 的优化口子，但说实话，我到现在还没去填。

## 我当时怎么想的，又错在哪

我最早以为可观测性就是「能记多少记多少」，越多越安全。后来被两件事打脸：

一是事件存储无限增长，不压缩就把自己压死——我建的 Compactor 就是承认「我记太多了，得忘一点」。

二是我一度想把所有原始数据都塞进黑匣子，结果发现 LLM 那几十 K token 的回复文本，从来没人去读。真正救人的是「为什么选了这个工具」这种**结构化、可归因的元数据**，不是原始流量。

所以 Flight Recorder 真正的原则，不是「记录一切」，而是**「记录每一个可调试的元数据」**——关键词是元数据。原始数据对黑匣子来说太臃肿、太噪；提取过、分类过、归因过的元数据，才配进黑匣子。

## 结论

大多数团队在可观测性上犯的错，不是「记太少」，而是**记得太民主**——把所有信号一视同仁地塞进同一个管道，然后被自己的数据淹死。

这跟「抽象的债务」是同一个命题的两种说法：抽象要画一条线，记录也要画一条线。线画错了，救命的工具就变成慢性自杀。

> 事件溯源让你能重建过去，但 Compactor 提醒你：连「重建过去」这件事，都需要你先学会丢掉大部分过去。

ARES 的聪明，不是它记了多少，而是它在同一个系统里同时承认两件事——**记录一切是必要的，敢忘一部分更是必要的**。一个不敢删数据的可观测系统，和一个不敢删代码的架构一样，迟早会把自己撑爆。

---

*Next: [状态还是行为](@/log/decision-archaeology/07-state-vs-behavior.md) -- 事件溯源把状态重放出来、记忆蒸馏把上下文压缩掉：同一个 ARES，在两端站着回答同一个问题——什么该固化成状态，什么该保留成可重放的行为。*
