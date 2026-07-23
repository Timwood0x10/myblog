+++
title = "状态还是行为"
date = 2026-06-12
description = "配置要落盘吗？缓存算状态吗？Agent 的会话历史是状态还是行为？ARES 一边用事件溯源把状态重算出来（第八篇），一边用记忆蒸馏把上下文压缩掉（第三篇）——这两个相反的动作，其实在回答同一个问题：什么该固化成状态，什么该保留成可重放的行为。这篇考古的是这条线的两端，以及为什么 ARES 必须同时站在天平两边。"
weight = 7
[taxonomies]
tags = ["Go", "State", "Memory", "Event Sourcing", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 状态还是行为

先讲一段我自己的弯路。ARES 的记忆系统，最早我没想搞三层架构，我想的是**词频分析**——把对话历史切成词，数哪个词出现得最频繁，出现得多就值得记住。

当时我撸了个极简版本，觉得自己美极了：O(n) 扫一遍，一个 `map[string]int` 全搞定，不需要 LLM、不需要数据库、甚至连网络请求都不用发。

```go
func (e *KeywordExtractor) Extract(ctx context.Context, messages []Message) ([]Keyword, error) {
    freq := make(map[string]int)
    for _, msg := range messages {
        for _, word := range tokenize(msg.Content) {
            if !e.stopwords[word] {
                freq[word]++
            }
        }
    }
    // Sort by frequency, take top-K
    var keywords []Keyword
    for word, count := range freq {
        keywords = append(keywords, Keyword{Word: word, Freq: count})
    }
    // ...
}
```

这段代码现在看很蠢，但当时我觉得它漂亮。问题在哪？词频只看「出现多少次」。Agent 对话里出现最频繁的词永远是「你好」「好的」「谢谢」——你过滤掉停用词，真正有价值的概念（「数据库连接池」「索引优化」「查询超时」）出现的频率比「好的」低一个数量级。你只能知道「哪个词出现得多」，却不知道「用户遇到了什么问题、Agent 怎么解决的」。

> 词频分析为什么不行，一句话就能说清：**Agent 记忆要解决的不是「哪些词出现过」，而是「哪些经验值得复用」。** 这两个问题差着一个维度——前者是统计问题，后者是语义问题。

这段弯路，正是「状态 vs 行为」这个决策最鲜活的注脚。

> **Problem**: 配置要落盘吗？缓存算状态吗？Agent 的会话历史是状态还是行为？ARES 一边用事件溯源把状态重算出来（第八篇），一边用记忆蒸馏把上下文压缩掉（第三篇）——这两个相反的动作，其实在回答同一个问题：什么该固化成状态，什么该保留成可重放的行为？

## 一个被混淆的二分法

大多数工程师把「状态」和「行为」当成数据和函数的老生常谈。但决策层面上，它们是**两种对待时间的方式**：

- **状态**是对过去的**定论**：一个值，代表「到此为止的结果」。
- **行为**是对过去的**保留**：一串动作，代表「如果想知道结果，可以重来」。

ARES 的事件系统选了行为端：不存当前状态，存每个改变状态的操作，想要状态就重放（`internal/ares_events/types.go` 里那条只追加的不可变日志）。记忆蒸馏却选了状态端：对话历史太长会撑爆上下文窗口，所以要教 Agent 学会遗忘和提炼（`internal/memory/distillation/service.go` 里的 `Experience`）。

```go
type Experience struct {
    ID               string
    Problem          string           // The user's problem/request
    Solution         string           // The Agent's solution
    Confidence       float64          // Confidence [0, 1]
    ExtractionMethod ExtractionMethod // direct / summary / pattern
    Vector           []float64        // Vector embedding
    // ...
}
```

注意 `Problem` + `Solution` 的分开存储——这是最有价值的知识形态：不是「用户说了什么」，而是「用户遇到了什么问题、Agent 怎么解决的」。

同一个框架，在两个模块里站在了天平两端。这不是矛盾，是诚实——因为两个模块面对的时间尺度不同。

## 行为端：事件溯源为什么敢不存状态

事件溯源选行为，是因为 Agent 的崩溃不可预测。你不知道它死在哪一步，所以必须把每一步都留着，死了能从任意点重建。

最狠的一个真实案例：一个 Agent 跑一个复杂的多步工作流，中途崩溃了。搁以前，我对着日志瞎猜——是 prompt 问题？LLM 幻觉？工具参数错了？猜、改、重跑，来回三四个循环才定位。这次我打开 Dashboard，找到那个 Agent 的事件流，从开头一步步重放。到第 7 个事件我就笑了——`tool.call:7` 从搜索 API 返回了空结果，Agent 没做空值检查，直接把空结果拼进了下一个 LLM prompt。

bug 本身不复杂——新鲜的是**我看见了完整的因果链，一个事件一个事件地 unfold**。不是猜，是看。那一刻我觉得自己不是在调试，是在看一个黑匣子飞行记录仪。

但事件溯源自己也要承认：它靠「记全」成立，又必须靠「删旧」才能续命（这就是上一篇讲的 Compactor）。**连最坚定的「行为派」，最终也得向状态投降——把旧事件压成快照。** 行为端不是不要状态，是推迟到不得不固化时才固化。

## 状态端：记忆蒸馏为什么敢丢行为

记忆蒸馏选状态，是因为 LLM 的上下文窗口是硬约束。你不可能把 50 轮对话全塞回去。ARES 的三层架构，每层都比上层更精炼、更持久、更贵：

| 层 | 生命周期 | 容量上限 | 本质 |
|---|---|---|---|
| Session Memory | 24h，纯内存，重启即丢 | 100 条 | 短期工作记忆 |
| Task Memory | 7d，可持久化 | 1000 条 | 单次执行记录 |
| Distilled Memory | LRU 淘汰 | 5000 条 | 可复用的结构化经验 |

关键决策藏在 `internal/memory/context` 的 `BuildContext` 里——它用的是**滑动窗口**，不是简单截断：

```go
func (sm *SessionMemory) BuildContext(ctx context.Context, input, sessionID string) (string, error) {
    session, ok := sm.sessions[sessionID]
    if !ok { return input, nil }
    session.mu.RLock()
    defer session.mu.RUnlock()
    start := 0
    if len(session.Messages) > sm.maxHistory {
        start = len(session.Messages) - sm.maxHistory
    }
    relevant := session.Messages[start:]
    // 拼接成 context 字符串
}
```

哪怕一个 session 有 100 条消息，LLM 永远只收到最近 10 条。更老的内容**自然地「被遗忘」**。

真实数据最能说明问题。ARES 自己跑的基准测试（部分经真实 LLM 调用验证）：

| 对话轮数 | 原始上下文 (tokens) | 蒸馏后 (tokens) | 节省 |
|---|---:|---:|---:|
| 10 | 1,121 | 379 | **66.2%** |
| 50 | 5,387 | 443 | **91.8%** |
| 100 | 10,972 | 339 | **96.9%** |

蒸馏后的上下文大小几乎恒定在 330–443 token（约 3 条经验），不随对话轮数增长。轮数越长，收益越大。按 GPT 定价算，100 轮对话每次请求省下约 $0.053——每天 10 万次调用就是**每天省 $5,300**。

但这里有个我必须诚实交代的代价：蒸馏丢的是**信息完整性**。滑动窗口截断直接丢信息，蒸馏是「提炼后存储」。前者是「省钱但挨饿」，后者是「省钱还吃得饱」——可后者需要 LLM 调用和向量生成，更贵，也更慢。ARES 用两条并行路径来平衡：高频低价值的任务走轻量 `DistillTask`（O(1)，不调 LLM），低频高价值的任务才走完整蒸馏。

## 结论

「状态还是行为」的争论，90% 是伪争论。人们吵的不是哪个更好，而是**懒得想自己面对的是哪种时间尺度**。

- 不确定未来要不要解释过去 → 留行为（事件溯源）。
- 确定未来只关心结果、且细节会压垮系统 → 固化状态（记忆蒸馏）。

> 状态是行为的尸体，行为状态的胚胎。区别只在于：你更愿意在哪一刻动刀。

最讽刺的一点是：**ARES 里最坚定的「行为派」（事件溯源），最终也得靠 Compactor 把旧事件压成状态快照才能活下去。** 连行为端都逃不过「最终总要固化成状态」。这恰恰说明，状态和行为不是非此即彼的敌人——它们是一个连续体上的两个点，区别只在你愿意为「可重放」支付多少存储和复杂度。

ARES 的聪明不是「选了哪边」，而是它**在同一个系统里同时承认两边都对，只是用在不同层**。这比任何一边倒的教条都诚实——也贵得多。

---

*Next: [撒谎的设计模式](@/log/decision-archaeology/08-the-pattern-that-lied.md) -- 教科书说工厂、策略、观察者模式解耦，可 ARES 的 LLMService 和 AHP 通信协议落地时跟教科书长得完全不一样：一个用对了，一个若用错就是 2000 倍的减速。设计模式什么时候开始撒谎？*
