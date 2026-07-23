+++
title = "你跳过的那条测试"
date = 2026-06-12
description = "ARES 用 Arena 主动「谋杀」运行中的 Agent，看它能否自愈（第九篇）。但大多数团队跳过了最该测的东西——不是功能，是「它死的时候怎么办」。这篇考古的是：哪些测试你明知道该写却没写，以及后来怎么炸的；以及 ARES 怎么把「我们跳过的那条测试」做成了一个按钮。"
weight = 11
[taxonomies]
tags = ["Go", "Testing", "Chaos Engineering", "Resilience", "decision-archaeology"]
series = ["decision-archaeology"]
[extra]
series = "decision-archaeology"
+++

# 你跳过的那条测试

先讲这个模块的由来。我当初测 Agent 稳定性，手动 kill 了一个进程。Agent 自动复活了，还继续干之前没干完的活。我当时挺兴奋——但紧接着想了一句话：

> This was just a manual test. Can I automate it?

于是我造了 Arena——一个**唯一目的就是搞破坏**的模块。它不实现自己的 Runtime、DAG 或恢复逻辑，就只是故意去调那些危险 API（`StopAgent`、`RemoveNode`、`RemoveEdge`），然后等着看系统自己修好自己。我把这叫 **「Edo Tensei Verification」（秽土转生验证）**——在 Dashboard 上点一个按钮，暗杀一个正在干活的 Agent，看它能不能自己爬起来。

这个念头本身，来自一次真实的生产事故：我手动 kill，Agent 复活、续上任务——那一刻我才意识到，**大多数人根本不会写这种测试，因为我们要测的是「它活着时能干活」，不是「它死了会怎样」**。

> **Problem**: ARES 的 Arena 能一键「谋杀」运行中的 Agent，看它能否自愈（第九篇）。这测试大多数人根本不会写——因为我们要测的是「它活着时能干活」，不是「它死了会怎样」。哪些测试你明知道该写却跳过了？

## 测试文化的盲区

团队写测试，默认在测**快乐路径**：输入正确，输出正确。这是「它能干活」的证明。

但系统真正的生死，不在「干活时」，在「出事时」。ARES 第九篇讲得很直白：作者一开始是手动 kill 进程，发现 Agent 自动复活并继续未完成的任务，然后想——能不能把它做成一键按钮？

把「谋杀 Agent 看它能否自愈」做成一键按钮，这测试稀有的地方在于：**它测的不是功能，是系统的尊严**——崩溃后还能不能爬起来。

Arena 的杀手锏是 `internal/arena/injector.go` 里的 `KillLeader`：

```go
func (in *Injector) KillLeader(ctx context.Context) (string, error) {
    leaderID := ""
    for _, info := range in.runtime.ListAgents() {
        if info.Type == "leader" {
            leaderID = info.ID
            break
        }
    }
    if leaderID == "" {
        return "", ErrLeaderNotFound
    }
    if err := in.runtime.StopAgent(ctx, leaderID); err != nil {
        return "", fmt.Errorf("arena: kill leader %s: %w", leaderID, err)
    }
    return leaderID, nil
}
```

因果链是：Arena 调 `StopAgent("leader-1")` → Runtime 标记停止 → goroutine 退出 → `NotifyAgentDead` 被调用 → LeaderSupervisor 发现 Leader 缺席 → 触发 failover（选举 → checkpoint 恢复 → 事件重放）→ 新 Leader 几秒内被选出并跑起来。一次「暗杀」，同时证明了三件事：选举、状态恢复、事件重放。

我给一个朋友演示过：打开 Dashboard，点「Assassinate Leader」，Agent 死了……**1.4 秒后**它自动复活了。他说：「Holy shit, it does that?」

我想的是：**对，这就是我花那么多时间造这玩意儿的原因。**

## 你跳过的是哪几条

对照已有系列，几个反复出现、却常被测试遗漏的维度：

| 跳过的测试 | 真实出处 | 你测了什么，却没测什么 |
|---|---|---|
| 复活测试 | ARES 第七、九篇 | 测了正常流程，没测「死过一次之后」状态能不能恢复、未完成的任务能不能续上 |
| 并发下的自身安全 | memscope-rs 篇，每秒数十万事件 | 测了正确性，没测「高负载下它自己先死」 |
| 边界守卫的失败模式 | OmniScope 篇，跨语言 FFI | 测了「对的调用」，没测「C 端乱来、Rust 端接不住时是优雅降级还是直接 UB」 |
| 错误的传播 | 「错误是设计的镜子」篇 | 测了成功路径，没测「Leader 崩溃、评审者故意说错话时，系统怎么对待失败」 |

Arena 自己定义了 **13 种混沌动作**（kill_leader / kill_agent / remove_node / remove_edge / slow_agent / network_partition / tool_timeout / memory_corrupt / mcp_disconnect / llm_failure……），外加一个持续随机注入故障的 **survival 模式**。它用三维弹性评分来量化「抗揍能力」：

| 维度 | 权重 |
|---|---|
| Availability（故障成功比） | 40% |
| Recovery（恢复率 70% + 恢复速度 30%） | 30% |
| Consistency（数据一致性率） | 30% |

survival 模式的实时输出长这样：

```
Elapsed: 12s    Actions: 1    Score: 100.0 (A+)
Elapsed: 22s    Actions: 2    Score: 97.3 (A+)
```

13 种故障随机选目标，Ctrl+C 停止并打印最终报告。这东西把 `ares arena run cascading_storm.yaml` 从一个测试命令，变成了一句宣言：「看我的系统有多能扛」。

## 为什么跳过

不是不知道该测，是**跳过的成本不在当下**。快乐路径的测试今天就能给你绿灯，让你心安理得地合并。复活测试、混沌测试要搭额外的基础设施（Arena、Compactor、重放），收益却要等某次生产事故才兑现——而那次事故发生时，你早忘了当初为啥没写。

这是典型的**跨期套利**：用未来的痛苦，贴现成现在的安逸。

ARES 的 Arena 值得所有框架学的地方，不是混沌工程多酷，而是它把「我们跳过的那条测试」变成了**一个按钮**。当验证自愈只要点一下，你就没有借口再跳过了。Arena 自己也很诚实：它不实现 Runtime/DAG/Recovery——只是调已有的危险 API，然后等系统自己修好。这种「薄一层 chaos 接口」的设计，恰恰是它能被真的用起来的原因。

## 我当时怎么想的，又差点错在哪

我差点没造 Arena。第一反应跟大多数人一样——「造个专门搞破坏的模块？听起来像个玩具」。是那次「手动 kill → 自动复活」的真实冲击，把我从「这有啥用」拽到了「我得把它变成一键的」。

我错在把「测试」默认等同于「测功能」。直到 Agent 真的在生产里静默死亡、而我的测试全绿——我才承认：那些全绿的测试，测的恰恰是最不怕出事的路径，跳过的才是要命的。

> 没写的测试不会消失，它们只是排着队，等在生产环境里一次性收了你的债。

## 结论

测试覆盖率高不代表你测对了。你测的往往是最不怕出事的路径，跳过的恰恰是最要命的。

ARES 的 Arena 值得所有框架学的地方，不是混沌工程多酷，而是它把「我们跳过的那条测试」变成了**一个按钮**。当验证自愈只要点一下，你就没有借口再跳过了。大多数系统的差距，不在于懂不懂该测什么，而在于**有没有把该测的变成不费力的动作**。

写测试的本质问题从来不是「测什么」，是「你怎么对待那些你明知道该测、却总想拖到以后的东西」。拖着拖着，它们就变成了事故报告里的第一行。

---

*Next: [离开 Web3 的那天](@/log/decision-archaeology/12-leaving-web3.md) -- 从 ethermint 的共识代码，到 memscope-rs 的内存工具：我离开 Web3，是重写自己的问题域。*
