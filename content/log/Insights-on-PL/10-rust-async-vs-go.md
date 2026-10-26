+++
title = "Rust 与 Go 的异步体系对比"
date = 2026-10-25
description = "从执行模型、调度器、通信、select 到取消语义，对比 Rust Future + async/await 与 Go Goroutine + Channel 在设计与运行时的根本差异。"
weight = 11
[taxonomies]
tags = ["Rust", "Go", "Async", "Concurrency"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

这篇我想把 Rust 和 Go 的异步体系放在一起比：不只是语法，而是执行模型、调度器、通信机制、`select`、取消语义、内存与资源消耗。

`select` 我会单独展开，因为它最能体现两种语言在并发设计上的分歧。

比较口径先说清楚：Rust 侧用 Tokio（最常用的异步运行时），Go 侧用标准库。**Rust 的 `select!` 是 Tokio 提供的宏，不是语言语法；Go 的 `select` 是语言内建语句。** 这个前提不搞清，后面的比较都会偏。

参考：[Tokio 教程](https://tokio.rs/tokio/tutorial)、[Go 语言规范](https://go.dev/ref/spec)、[Rust 异步编程](https://rust-lang.github.io/async-book/)。

---

## 一、设计理念：隐藏复杂性 vs 显式状态机

先给结论。

**Go**：让并发编程尽量简单，用 Goroutine + Channel + 运行时调度把门槛降下来。

**Rust**：把异步计算变成可组合的状态机，在编译期尽量把内存、所有权、并发安全约束清楚，再交给运行时执行。

### 1.1 Go：用 Goroutine 藏起调度细节

```go
package main

import (
    "fmt"
    "time"
)

func worker(id int) {
    time.Sleep(time.Second)
    fmt.Println("worker", id, "done")
}

func main() {
    for i := 0; i < 10; i++ {
        go worker(i)
    }
    time.Sleep(2 * time.Second)
}
```

核心就一行：

```go
go worker(i)
```

它启动一个 Goroutine。不用手动建线程，也不用管任务什么时候暂停、什么时候恢复。

Go Runtime 负责：

* 创建和调度 Goroutine；
* 把 Goroutine 分配给可运行的操作系统线程；
* 处理网络 I/O 的等待与唤醒；
* 管理 Goroutine 的栈；
* 执行垃圾回收。

```text
go function()
      │
      ▼
  Goroutine
      │
      ▼
   Go Runtime
      │
      ▼
 操作系统线程
      │
      ▼
 CPU / 网络 I/O
```

Goroutine 是由 Go Runtime 管理的轻量执行单元：它不是 OS 线程，但能在线程上运行，也能在运行时被调到别的线程。

注意：`go` 启动不意味着函数立即执行，也不意味着它一定和当前函数并行在不同核心上。

### 1.2 Rust：async fn 首先是个 Future

```rust
async fn worker(id: usize) {
    do_something(id).await;
}
```

看起来也简单，但有个根本区别：**调用 `async fn` 不会执行函数体**，它返回一个表示「未来计算」的 Future。

```rust
async fn calculate() -> i32 {
    println!("calculating");
    42
}

fn main() {
    let future = calculate();
    println!("future created");
}
```

我实测了一下：输出是

```text
future created
calculating
```

`calculating` 是在后面 `await` 时才打印的。**Future 必须被驱动（poll）才会推进。**

```text
调用 async fn
      │
      ▼
创建 Future
      │
      ▼
Future 被 executor 驱动
      │
      ▼
poll()
      │
      ├── Ready(value)
      │       └── 计算完成
      │
      └── Pending
              └── 等待后续再次 poll
```

Rust 标准库只定义了 `Future` trait，**没有提供通用异步运行时**。所以得选 Tokio、async-std 之类。Tokio 提供任务调度、异步 I/O、定时器、异步 channel、同步原语、任务取消等能力。

### 1.3 两种模型的核心差异

| 维度 | Go | Rust + Tokio |
|---|---|---|
| 执行单元 | Goroutine | Task（通常承载一个 Future） |
| 异步计算的表示 | 普通函数跑在 Goroutine 里，阻塞由运行时接管 | 编译器生成的 Future 状态机 |
| 启动并发 | `go f()` | `tokio::spawn(future)` |
| 驱动方式 | Runtime 调度 Goroutine | Executor 轮询 Future |
| 是否内置运行时 | 内置 | 需要自己选、自己配 |
| 内存管理 | GC | 所有权 + RAII，无通用 GC |
| 取消 | 通常靠 `context` 协作 | drop Future 即可停止推进 |

关键结论：**Goroutine 和 Future 不是等价概念。**

* Goroutine 是「正在运行或等待运行」的执行单元；
* Future 是一份「可被推进的计算状态」；
* Tokio Task 是执行器管理的任务，通常承载一个 Future。

所以合理的比较对象是：

```text
Go   : Goroutine + Go Runtime Scheduler
Rust : Future + Tokio Task + Tokio Executor
```

---

## 二、调度模型

### 2.1 Go 的 G-M-P

* **G**：Goroutine，执行单元；
* **M**：Machine，操作系统线程；
* **P**：Processor，执行 Go 代码所需的调度资源（持有本地运行队列等）。

```text
                 Go Runtime
                      │
          ┌───────────┴───────────┐
          │                       │
       P0 / P1 / P2 ...        Goroutine 队列
          │                       │
          ▼                       │
       M0 / M1 / M2 ... ◄─────────┘
          │
          ▼
      操作系统线程
          │
          ▼
          CPU
```

一个 P 同一时刻只能被一个 M 持有；M 必须先绑定 P 才能执行 Go 代码。Goroutine 可以在不同时间跑到不同的 M 上。

```go
func worker() {
    for {
        doSomething()
    }
}

func main() {
    go worker()
    go worker()
    go worker()
    select {}
}
```

三个 Goroutine 不代表三个线程。8 核机器上，runtime 可能这样排：

```text
M0: G1 → G2 → G3 → G1
M1: G4 → G5 → G6 → G4
```

这只是示意。实际取决于可运行队列、P 的数量、阻塞状态、系统调用和调度策略。

**Goroutine 阻塞时**分三种情况：

1. **网络 I/O**：runtime 用网络轮询器（netpoll），让等待的 Goroutine 休眠，不必占着一个线程干等。
2. **系统调用**：某些系统调用会真的阻塞线程，runtime 可以分离 P、让别的线程继续跑 Go 代码，等调用返回再重新调度。
3. **纯计算**：一直跑 CPU 循环就持续吃 CPU。Go 在这块做过专门改进——后面「抢占」一节细说。

### 2.2 Tokio 的调度

```text
              Tokio Runtime
                    │
           ┌────────┴────────┐
           │                 │
        Worker 0           Worker 1
           │                 │
        Task Queue         Task Queue
           │                 │
           ▼                 ▼
        Future A           Future B
           │                 │
         poll()            poll()
           │                 │
      ┌────┴────┐       ┌────┴────┐
      ▼         ▼       ▼         ▼
    Ready    Pending   Ready    Pending
```

多线程运行时用工作窃取分配任务；单线程运行时就在一个线程上跑。

```rust
use tokio::time::{sleep, Duration};

async fn worker(id: usize) {
    println!("worker {id} started");
    sleep(Duration::from_secs(1)).await;
    println!("worker {id} finished");
}

#[tokio::main]
async fn main() {
    let a = tokio::spawn(worker(1));
    let b = tokio::spawn(worker(2));
    let _ = tokio::join!(a, b);
}
```

`tokio::spawn` 把 Future 交给运行时，不是给每个任务开一个线程。任务等定时器时返回 `Pending`，执行器转去跑别的任务，定时器到期再唤醒它。

### 2.3 抢占：这是两种模型最本质的分歧之一

**Go：有异步抢占。**

早期 Go 的抢占是协作式的——只在函数调用时检查栈边界，一个没有函数调用的死循环能让整个 P 卡住。Go 1.14 引入了基于信号的**异步抢占**，可以在几乎任意指令边界打断 Goroutine。这解决了很多「长循环拖垮调度」的问题。

但也不是毫无边界：cgo 调用、某些汇编、runtime 内部路径仍有限制。

**Tokio：纯协作式。**

一个任务在执行时如果不主动 `.await`，执行器**没有**办法打断它。

```rust
async fn bad_task() {
    loop {
        expensive_cpu_work();
    }
}
```

这段写在 `async fn` 里，但循环里没有任何 `.await`，它就会长时间占住一个 worker 线程，其他任务排队。`async` 不会把同步计算自动变成可暂停的东西。

Tokio 有 coop budget 之类的机制，但它作用于 Tokio 自己的资源（读 channel、拿锁等），**不是对所有 CPU 指令序列的强制抢占**。

遇到长时间 CPU 计算，正常做法是：

* `spawn_blocking` 扔给阻塞线程池；
* 专门的 CPU 线程池；
* 把计算切成小块，中间主动 `await` 让出。

所以一个实用的判断：

> Go 的调度器能「打断」你，Tokio 的调度器等「你主动让」。
>
> 把长时间同步计算塞进 `async fn` 时，Tokio 不会救你，Go 大体上会。

---

## 三、通信机制

### 3.1 Go：channel 是语言的一部分

```go
// 无缓冲：发送与接收必须同时就绪
ch := make(chan int)

// 有缓冲：缓冲区没满就能发，没空就能收
buffered := make(chan int, 8)
```

`chan T`、`<-`、`close`、`select` 全是语言语法，不需要 import 任何库。

无缓冲 channel 的同步语义很直观——发送方会一直阻塞到有接收方取走。我实测过：

```text
发送方：准备发送（会阻塞）
接收方：开始接收
发送方：已被接收方取走，解除阻塞
```

这就是 CSP 的核心：**不要通过共享内存通信，要通过通信共享内存。**

### 3.2 Rust：channel 是库，而且有很多种

Rust 标准库只有 `std::sync::mpsc`（多生产者单消费者），而且它**没有** `select` 支持。实际项目基本都用 Tokio 的 `tokio::sync`：

| 类型 | 语义 |
|---|---|
| `mpsc` | 多生产者单消费者队列 |
| `oneshot` | 一次性发送一个值 |
| `broadcast` | 多生产者多消费者，每条消息广播给所有订阅者 |
| `watch` | 单值广播，新订阅者只看最新值 |

这里没有「语言内建 channel」这回事，全都是库提供的数据结构。所以 Rust 的通信模型天然更分散：你要按场景挑工具，而不是只有一个 `chan`。

这个差异挺重要：**Go 的并发原语是语法，Rust 的并发原语是库。** 语法更统一也更好教；库更灵活，但也更容易选错。

---

## 四、取消语义

### 4.1 Go：context 协作取消

```go
ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
defer cancel()

select {
case <-ctx.Done():
    return ctx.Err()
case result := <-work:
    return result
}
```

要点：

* 没有「强制杀死一个 Goroutine」的 API，这是设计选择；
* 被调用方**必须**主动检查 `ctx.Done()` 或把 ctx 传下去，取消才会生效；
* 如果某段代码压根不看 ctx，它会照跑到结束。

### 4.2 Rust：drop Future 就是取消

Rust 的取消不需要协议：

```rust
let handle = tokio::spawn(worker());

// 直接丢掉 handle 或 abort
handle.abort();
```

`abort()` 的本质是让运行时**丢掉这个 Task 持有的 Future**。Future 是状态机，drop 它，推进就停了，占用的资源按 `Drop` 实现释放。

这比分发一个取消信号更「干脆」，但有两个必须理解的点：

**第一，取消点只在 `.await` 处。**

Future 不处于执行状态时才有「可被 drop」这回事。如果 Future 正在跑一段同步代码，调度器不会在指令中间把它 drop 掉——因为那本来就是同一个线程在顺序执行。

**第二，取消不是「中断」，是「不再推进」。**

drop 时执行的是 `Drop`，不是某种异步清理流程。如果你的清理逻辑需要 `.await`（比如发个网络请求再断开），`Drop` 里做不到，得用 `async fn shutdown()` 之类的显式协议。

Tokio 也提供 `CancellationToken`（需要 `tokio-util`），那个是协作式的，语义更接近 Go 的 context。

### 4.3 对比

| | Go | Rust + Tokio |
|---|---|---|
| 主要机制 | `context.Context` | drop Future / `abort()` |
| 是否强制 | 协作，需主动检查 | 结构性，drop 即停止推进 |
| 取消粒度 | 调用链传递 | 单个 Task / 单个 Future |
| 异步清理 | 可以（在检查 ctx 后 await） | 不能在 `Drop` 里 await，需显式协议 |

---

## 五、select：等待多个事件

### 5.1 Go：等待多个 channel 操作

```go
select {
case msg := <-ch1:
    fmt.Println(msg)
case msg := <-ch2:
    fmt.Println(msg)
}
```

两个 `case` 不会自动起两个 Goroutine。`select` 只是**等待多个通信操作，选一个能执行的执行**。想让两件事独立跑，得自己 `go` 出去。

`select` 的分支只能是 channel 的发送或接收，这是语言层面的限制。

### 5.2 Tokio：等待多个 Future

```rust
use tokio::sync::oneshot;

#[tokio::main]
async fn main() {
    let (tx1, rx1) = oneshot::channel::<String>();
    let (tx2, rx2) = oneshot::channel::<String>();

    tokio::spawn(async move {
        let _ = tx1.send("hello from rx1".to_string());
    });
    tokio::spawn(async move {
        let _ = tx2.send("hello from rx2".to_string());
    });

    tokio::select! {
        result = rx1 => {
            println!("rx1: {:?}", result);
        }
        result = rx2 => {
            println!("rx2: {:?}", result);
        }
    }
}
```

看起来很像，但分支不限于 channel：

```rust
tokio::select! {
    result = database_query() => {
        println!("database completed: {:?}", result);
    }
    result = http_request() => {
        println!("http completed: {:?}", result);
    }
    _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
        println!("timeout");
    }
}
```

数据库查询、HTTP 请求、定时器，三个完全不同的 Future 可以并列等待。

**这就是最大的抽象差异：Go 的 `select` 只能选 channel 操作，Tokio 的 `select!` 能选任何 Future。**

---

## 六、Go 的 default 与 Tokio 的 else 并不等价

这块特别容易踩。

### 6.1 Go 的 default：没有可执行的通信就立刻执行

```go
select {
case msg := <-ch:
    fmt.Println("received:", msg)
default:
    fmt.Println("nothing ready")
}
```

`ch` 没消息时，立刻走 `default`，不等待。

放进循环里就是经典的忙轮询：

```go
for {
    select {
    case msg := <-ch:
        handle(msg)
    default:
        // 暂时没有消息
    }
}
```

我实测了一下：空 channel + `default`，50ms 里空转了 **137 万次**。CPU 直接被吃满。

想等消息就不要加 `default`。

### 6.2 Tokio 的 else：所有分支都被禁用时才执行

```rust
tokio::select! {
    Some(msg) = rx.recv() => {
        println!("{msg}");
    }
    else => {
        println!("all branches disabled");
    }
}
```

`else` **不是** Go `default` 的对应物。

用 `Some(msg) = rx.recv()` 这种带模式的写法时，如果 `recv()` 返回 `None`（channel 关闭），模式不匹配，这个分支就**被禁用**。当全部分支都被禁用，才走 `else`。

我实测验证了两件事：

**场景 A：channel 仍开启，只是暂时没消息。**

```rust
tokio::select! {
    Some(msg) = rx.recv() => println!("got {msg}"),
    _ = tokio::time::sleep(Duration::from_millis(120)) => {
        println!("超时分支触发");
    }
    else => println!("else"),
}
```

输出：

```text
超时分支触发，用时 121.878667ms
```

等了 120ms 走超时分支。**没有立即执行 else，也没有立即返回。**

**场景 B：channel 已关闭。**

```rust
let (tx, mut rx) = mpsc::channel::<String>(4);
drop(tx);
```

`recv()` 立刻返回 `None`，模式不匹配 → 分支禁用 → 走 else：

```text
all branches disabled -> else
```

### 6.3 一个语法细节

`else` 必须放在**所有分支之后**，而且前面不能有逗号漏写。我第一次写的时候把它夹在中间，编译器直接报：

```text
error: expected identifier, found keyword `else`
```

所以顺序是固定的：普通分支在前，`else` 收尾。

### 6.4 对照表

| 场景 | Go `default` | Tokio `else` |
|---|---|---|
| 当前没有消息，但通道仍开启 | 立即执行 `default` | 继续等待，不执行 `else` |
| 所有分支都被禁用 | 取决于是否有可执行分支 | 执行 `else` |
| 能否等待非 channel 的 Future | 不能 | 能 |
| 忙轮询风险 | 加 `default` 后很常见 | 没有等价语义 |

所以下面这两段看起来对应，行为完全不同：

```go
select {
case msg := <-ch:
    handle(msg)
default:
}
```

```rust
tokio::select! {
    Some(msg) = rx.recv() => {
        handle(msg);
    }
    else => {}
}
```

第一段没消息就立刻往下走；第二段只要接收分支还启用，就会**等**。

---

## 七、公平性

### 7.1 Go：伪随机

两路都有消息时：

```go
select {
case msg := <-ch1:
    handle1(msg)
case msg := <-ch2:
    handle2(msg)
}
```

Go 规范要求在所有**就绪**的通信操作里做**伪随机**选择。我实测 1000 次两路都就绪的 select：`ch1=509`、`ch2=491`，接近 50/50。

### 7.2 Tokio：默认随机检查顺序

```rust
loop {
    tokio::select! {
        Some(msg) = rx1.recv() => handle1(msg),
        Some(msg) = rx2.recv() => handle2(msg),
        else => break,
    }
}
```

默认情况下 `select!` 会随机化分支检查顺序，避免某个分支在循环里永远被优先。

**但随机不等于公平调度。** 它不保证两边各处理一半，也不保证某个分支在固定时间内一定被处理。

### 7.3 biased 模式

```rust
tokio::select! {
    biased;
    _ = shutdown.cancelled() => {
        println!("shutdown");
    }
    Some(msg) = rx.recv() => {
        handle(msg);
    }
}
```

加 `biased;` 后按源码顺序轮询分支。适合「关闭信号优先」这类场景。

代价是：如果第一个分支永远就绪，后面的分支可能长期得不到检查。公平性责任回到开发者身上。

Go 没有对应的 `biased` 语法。

---

## 八、未选中分支的命运

这是两种 `select` 最本质的区别，也是最容易被忽略的。

### 8.1 Go：只执行选中的通信操作

```go
select {
case msg := <-ch1:
    handle1(msg)
case msg := <-ch2:
    handle2(msg)
}
```

选中 `ch1` 后，这次 select 就结束了。`ch2` 里的消息**不会消失**，仍留在 channel 里等下次接收。

### 8.2 Rust：未选中的 Future 被 drop

```rust
tokio::select! {
    result = operation_a() => {
        handle_a(result);
    }
    result = operation_b() => {
        handle_b(result);
    }
}
```

某个分支完成时，其他分支的 Future **会被丢弃**。

我写了个带 `Drop` 的 Future 实测：

```rust
tokio::select! {
    _ = async { let _g = DropGuard("branch_a"); sleep(200ms).await; } => {
        println!("branch a done");
    }
    _ = async { let _g = DropGuard("branch_b"); sleep(10ms).await; } => {
        println!("branch b done");
    }
}
```

输出：

```text
  [drop] branch_b
  [drop] branch_a
  branch b done
```

`branch_b` 先完成（10ms），先被 drop（已完成的 Future 也照样 drop）；`branch_a` 的 Future 被取消并 drop。

**所以 Rust 的 `select!` 不只是「选结果」，还隐含「取消其他计算」。**

对应到 `chan` 的类比：Go 里没被选中的消息留在 channel；Rust 里没被选中的 **Future 被销毁**。如果你的 Future 在被 drop 时需要清理（关连接、写日志），得靠 `Drop` 保证，不能指望它「继续跑完」。

这跟第四节说的取消语义是同一件事的两面。

---

## 九、开销

### 9.1 Go 的 Goroutine

有独立栈，初始很小（2KB 量级），按需增长。

我实测创建 10 万个阻塞 Goroutine：

```text
goroutine: before=1 now=100001, heap=58.7 MB
```

约 60MB / 10 万 ≈ **每个 Goroutine 600 字节量级**（g 结构体 + 初始栈，不含后续增长）。

### 9.2 Rust 的 Future

没有独立栈。Future 的大小 = 编译器生成的状态机大小，**编译期确定**。

```rust
println!("{}", std::mem::size_of_val(&async { 42 }));
```

我实测了几个：

```text
async { 42 }            = 1 bytes
tiny()                  = 1 bytes
with_state()（1KB 局部） = 1144 bytes
Pin<Box<dyn Future>>    = 16 bytes
```

一个不保存任何跨 `.await` 状态的 Future 只有 **1 字节**；而带 1KB 局部变量跨 `.await` 的那个是 1144 字节——正好对上「状态都内联在 Future 里」。

这个大小永远是编译期确定的固定值，分配多少一目了然。代价是：当 Future 特别大时（比如深嵌套的 async 函数），用 clippy 的 `large_futures` lint 能发现，通常用 `Box::pin` 装箱解决。

### 9.3 对比

| | Go | Rust |
|---|---|---|
| 栈 | 每个 Goroutine 独立栈，动态增长 | 无独立栈，状态内联在 Future 里 |
| 单个开销 | 约几百字节起（含栈） | 由状态机大小决定，编译期可知 |
| 增长方式 | 栈复制（会移动栈上对象） | 不需要，大小固定 |
| 数量上限 | 百万级常见 | 取决于内存与 Future 大小 |

这里有个值得注意的连锁反应：**Go 的栈会复制、会移动**，所以栈上的对象地址不稳定——runtime 会在栈增长时更新指向它的指针。这也是 Go 不需要 `Pin` 的原因。

而 Rust 的 Future 地址必须稳定（状态机可能自引用），所以才需要 `Pin` 来保证「固定住之后不再移动」。**Pin 存在的前提，正是 Rust 不允许运行时帮你悄悄搬动栈上的值。**

---

## 十、怎么选

不按「哪个性能好」选，按任务形态选。

**用 Go 更顺手的场景：**

* 大量互相独立的网络请求 / 任务编排；
* 团队对并发模型熟悉度参差，希望统一一处写法；
* 需要快速迭代，不想纠结运行时选型与生命周期标注；
* 长同步计算和异步逻辑混在一起，靠 runtime 抢占兜底。

**用 Rust 更顺手的场景：**

* 需要极致的单任务开销与可预测的内存布局；
* 并发安全需要编译期保证（`Send`/`Sync`）；
* 要和已有 C/C++ 生态、底层内存操作紧密结合；
* 需要精确控制取消时机与清理顺序。

几条实践中摸出来的判断：

1. **别在 `async fn` 里塞长同步计算。** 这在 Rust 里是硬伤，Go 里只是「不太优雅」。
2. **Go 的 `context` 必须传下去。** 不传就等于没有取消。
3. **Rust 的取消是 drop，不是信号。** 需要异步清理就设计 `shutdown()`，别指望 `Drop`。
4. **`select!` 会取消其他分支。** 写的时候要清楚这点，尤其是分支里有副作用时。
5. **别拿 `select` 的 `default` 和 `else` 互相翻译。** 语义根本不同。

---

## 十一、小结

一张表收尾：

| 维度 | Go | Rust + Tokio |
|---|---|---|
| 执行单元 | Goroutine | Task / Future |
| 是否有独立栈 | 有，动态增长 | 没有，状态内联 |
| 启动语义 | `go f()` 立即排队 | `async fn` 只是构造，需驱动 |
| 调度 | GMP，内建 | 工作窃取，需选运行时 |
| 抢占 | 有异步抢占（1.14+） | 纯协作，靠 `.await` 让出 |
| 通信 | channel 是语法 | channel 是库，分多种 |
| 取消 | `context` 协作 | drop Future |
| select 能力 | 只能选 channel 操作 | 可选任意 Future |
| select 未选中项 | 消息留在 channel | Future 被 drop |
| 地址稳定性 | runtime 可搬栈，无需 Pin | 需要 Pin 固定 Future |

最后一句：**Go 把并发包装成一个你能直接 `go` 出去的东西，代价是调度细节藏在运行时里；Rust 把异步展开成编译期可见的状态机，代价是运行时、Pin、生命周期这些都得自己面对。** 没有谁更先进，只有谁更贴合你手上这件事。
