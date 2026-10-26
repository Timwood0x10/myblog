+++
title = "Rust 与 Go 的错误处理与故障恢复"
date = 2026-10-25
description = "Result 与 error 的差异只是表层。真正决定系统可靠性的，是错误分类、传播路径、重试预算、取消语义和故障恢复策略。"
weight = 12
[taxonomies]
tags = ["Rust", "Go", "Error Handling", "Reliability"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

这篇比起比较 `Result` 和 `error` 的语法，我更想聊后者背后的问题：一门语言怎么表达失败、怎么传播失败、谁来决策，以及系统在部分组件挂掉之后还能不能继续跑。

两种语言的倾向差异很明显：

* **Rust** 倾向于把失败编码进类型系统，让调用者明确面对失败的可能性。
* **Go** 倾向于把错误当普通返回值，让调用者用显式分支决定怎么处理。

两种都强调显式，但类型系统、传播机制、异常策略和资源管理的实现方式差别很大。

---

## 一、错误处理和故障恢复不是一回事

这是整篇的起点。

假设一个 Agent 任务要经过：

```text
接收任务
   │
   ▼
解析任务
   │
   ▼
调用 LLM
   │
   ▼
调用工具
   │
   ▼
保存结果
   │
   ▼
任务完成
```

现在 LLM 调用失败了。系统至少要回答四个问题：

1. 怎么表示这个错误？
2. 怎么把它传给调用者？
3. 谁来决定接下来怎么办？
4. 系统能不能恢复到一个有效状态？

这四个问题对应四个层次：

| 层次 | 关注的问题 | 典型机制 |
|---|---|---|
| 错误表示 | 失败是什么？ | `Result<T, E>`、`error` |
| 错误传播 | 失败怎么传给上层？ | `?`、`return err` |
| 错误处理 | 当前层应该怎么应对？ | 降级、转换、记日志 |
| 故障恢复 | 系统怎么继续运行？ | 重试、检查点、补偿、恢复执行 |

```rust
fn load_config() -> Result<Config, ConfigError>
```

这行代码表达的是「加载配置可能失败，调用者要处理这种可能」。

但它**没有**规定：

* 要不要重试；
* 要不要用默认配置；
* 要不要终止程序；
* 要不要通知管理员；
* 要不要回滚已经执行的操作。

Go 的 `func LoadConfig() (Config, error)` 同样没有。

语言提供的是**表达和传播**机制，业务系统还得自己定义处理策略。这是理解两种设计的第一把钥匙。

---

## 二、两种语言的错误哲学

### 2.1 Rust：失败是类型的一部分

```rust
fn divide(a: i32, b: i32) -> Result<i32, String> {
    if b == 0 {
        return Err("division by zero".to_string());
    }
    Ok(a / b)
}
```

`Result` 就是个枚举：

```rust
enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

```text
Result<i32, String>
       │
       ├── Ok(i32)
       │
       └── Err(String)
```

在安全 Rust 里，你不能把 `Result<i32, String>` 直接当 `i32` 用，必须先处理或明确提取：

```rust
match divide(10, 2) {
    Ok(value) => println!("{value}"),
    Err(error) => println!("error: {error}"),
}
```

这里的倾向是：**函数签名会明确暴露它可能发生的、通过返回值表达的失败。**

但要注意，这不等于 Rust 能保证业务流程的失败都被妥善恢复。你完全可以这么写：

```rust
let result = divide(10, 0);
println!("{result:?}");
```

它把返回值消费掉了，但没做任何有意义的恢复。**Rust 约束的是类型和控制流，不是业务策略。**

### 2.2 Go：错误是普通返回值

```go
func Divide(a, b int) (int, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}
```

```go
value, err := Divide(10, 2)
if err != nil {
    return err
}
fmt.Println(value)
```

`error` 是个接口：

```go
type error interface {
    Error() string
}
```

所以任何类型都能实现它：

```go
type ValidationError struct {
    Field string
    Msg   string
}

func (e *ValidationError) Error() string {
    return e.Field + ": " + e.Msg
}
```

和 Rust 的关键区别：Rust 把成功和失败放进**同一个枚举值**，Go 把它们拆成**两个返回值**。

这不代表 Go 的错误没有类型——自定义错误类型、错误接口、错误链一样能表达丰富信息。区别只在建模方式。

### 2.3 真正的区别

| 维度 | Rust | Go |
|---|---|---|
| 典型返回类型 | `Result<T, E>` | `(T, error)` |
| 失败怎么表达 | 枚举的 `Err` 分支 | `error` 接口值，`nil` 表示无错 |
| 忽略失败会怎样 | 编译**警告**（`unused_must_use`），可以显式忽略 | 编译器完全不管，只能靠 linter |
| 传播方式 | `?` | `return err` |
| 常用错误类型 | 枚举、自定义结构体、trait object | 自定义类型、接口、错误链 |
| 错误匹配 | `match`、`matches!` | `errors.Is`、`errors.As`、类型断言 |
| 异常机制 | 没有与 panic/recover 等价的日常模型 | `panic/recover` 处理非局部控制流 |
| 资源清理 | 所有权 + RAII / `Drop` | `defer`、显式 close、GC |

**这里必须纠正一个常见误解**：「Rust 强制你处理 `Result`」。

不是的。Rust 给 `Result` 标了 `#[must_use]`，忽略它只是**警告**：

```rust
fn returns_result() -> Result<(), ()> { Ok(()) }

fn main() {
    returns_result();   // warning: unused `Result` that must be used
}
```

我实测过：能编译、能跑，只有一个 warning。而且加个 `let _ = returns_result();` 就连 warning 都没了。

真正的差异在于**默认行为的倾向**：

* Rust：忽略 → 有噪音（warning），逼你至少承认一下。
* Go：忽略 `err` → 世界安静，什么都不说。

Rust 强的地方不是「自动处理错误」，而是在类型层面让失败路径无法被**无意识地**当成成功值使用。

---

## 三、错误传播：`?` 与 `return err`

```text
Handler
   │
   ▼
Service
   │
   ▼
Repository
   │
   ▼
数据库
```

数据库访问失败，我们希望底层返回错误、中间层决定是否转换、最上层决定怎么向用户反馈。

### 3.1 Rust 的 `?`

```rust
use std::fs;
use std::io;

fn load_config() -> Result<String, io::Error> {
    let content = fs::read_to_string("config.toml")?;
    Ok(content)
}

fn initialize() -> Result<(), io::Error> {
    let config = load_config()?;
    println!("{config}");
    Ok(())
}
```

`let config = load_config()?;` 大致等价于：

```rust
let config = match load_config() {
    Ok(value) => value,
    Err(error) => return Err(error.into()),
};
```

（简化展开，实际走 `Try` trait。）

`?` 的语义就两条：

* 成功 → 取出值继续；
* 失败 → **把错误转换成当前函数能返回的类型**，提前返回。

第二条很容易被忽略：`?` 不是无条件原样返回错误。

```rust
fn read_data() -> Result<String, AppError> {
    let content = std::fs::read_to_string("config.toml")?;
    Ok(content)
}
```

这里能编过，前提是 `AppError: From<std::io::Error>`。否则报错。

这个机制允许你在底层保留具体错误，到上层再逐步归一化成应用错误。

### 3.2 Go 的显式检查

```go
func LoadConfig() (string, error) {
    content, err := os.ReadFile("config.toml")
    if err != nil {
        return "", err
    }
    return string(content), nil
}

func Initialize() error {
    config, err := LoadConfig()
    if err != nil {
        return err
    }
    fmt.Println(config)
    return nil
}
```

每一层都写着：

```go
if err != nil {
    return err
}
```

看起来啰嗦，但好处是每个检查点都能插入局部逻辑：

```go
config, err := LoadConfig()
if err != nil {
    metrics.ConfigLoadFailure.Inc()
    return fmt.Errorf("initialize service: %w", err)
}
```

`%w` 是关键——它保留底层错误链，让上层还能用 `errors.Is` / `errors.As` 回溯。

Rust 用 `map_err` 做同样的事：

```rust
let content = std::fs::read_to_string("config.toml")
    .map_err(|err| AppError::ConfigLoad(err))?;
```

### 3.3 两种传播的真正差异

Rust 的 `?` 把传播压缩成语言级语法，正常路径干净。

Go 把检查留在普通控制流里，每一层都容易插东西。

没有绝对优劣。但要说一句：**Rust 不是不能显式处理错误，Go 也不是不能封装传播**。两种风格两边都能写，只是默认写法的手感不同。

---

## 四、错误类型设计

这块我觉得最值得细看。

假设在写一个 Agent Runtime，失败原因包括：

* 参数不合法；
* LLM 服务不可用；
* 工具调用失败；
* 任务超时；
* 任务被取消；
* 数据库写入失败；
* 内部状态不一致。

### 4.1 Rust：用枚举描述已知类别

```rust
use std::time::Duration;

#[derive(Debug)]
enum AgentError {
    InvalidInput(String),
    LlmUnavailable,
    ToolFailed(String),
    Timeout(Duration),
    Cancelled,
    Storage(String),
}
```

枚举描述了系统**认可**的一组错误类别，调用者可以精确匹配：

```rust
fn handle_error(error: AgentError) {
    match error {
        AgentError::InvalidInput(message) => {
            eprintln!("invalid input: {message}");
        }
        AgentError::LlmUnavailable => {
            eprintln!("LLM unavailable");
        }
        AgentError::ToolFailed(message) => {
            eprintln!("tool failed: {message}");
        }
        AgentError::Timeout(duration) => {
            eprintln!("timed out after {duration:?}");
        }
        AgentError::Cancelled => {
            eprintln!("cancelled");
        }
        AgentError::Storage(message) => {
            eprintln!("storage error: {message}");
        }
    }
}
```

代价是耦合：每加一个类别，所有 `match` 都要改（除非用 `_` 兜底，但那样就失去了穷尽性检查）。

缓解手段有的是：`#[non_exhaustive]`、`Box<dyn Error>`、分层错误类型。应用内部用枚举表示稳定的领域错误，通常是最优解。

### 4.2 Go：错误接口 + 错误链

```go
type ErrorCode string

const (
    ErrInvalidInput   ErrorCode = "invalid_input"
    ErrLlmUnavailable ErrorCode = "llm_unavailable"
    ErrToolFailed     ErrorCode = "tool_failed"
    ErrTimeout        ErrorCode = "timeout"
)

type AgentError struct {
    Code    ErrorCode
    Message string
    Cause   error
}

func (e *AgentError) Error() string  { return e.Message }
func (e *AgentError) Unwrap() error  { return e.Cause }
```

三个字段各自负责一件事：

* `Code`：稳定的错误类别，给程序判断用；
* `Message`：给人看的描述；
* `Cause`：底层原因，串成错误链。

调用者：

```go
var agentErr *AgentError
if errors.As(err, &agentErr) {
    switch agentErr.Code {
    case ErrInvalidInput:
        // 拒绝请求
    case ErrLlmUnavailable:
        // 考虑重试或降级
    case ErrTimeout:
        // 执行超时策略
    }
}
```

`errors.As` 会沿 `Unwrap()` 逐层查找，所以哪怕错误被 `fmt.Errorf("%w")` 包了好几层，也能挖出目标类型。我实测过：

```text
errors.As: true llm_unavailable
errors.Is(inner): true
```

`errors.Is` 同理，它走 `Unwrap` 链做相等比较。

Go 1.20 之后还有一个 `errors.Join`，用来把多个错误合成一个：

```go
err := errors.Join(errA, errB)
```

它的 `Unwrap()` 返回 `[]error`，`errors.Is` / `errors.As` 会遍历全部成员。我实测了一下：

```text
a failed
b: inner b
Is(e1): true
Unwrap() []error 长度: 2
```

适合「多个子任务都失败了，我要一起报上去」的场景——这在并发 fan-out 里很常见。

一个容易踩的坑：`errors.As` 的第二个参数必须是指向「实现了 `error` 的类型」的指针。传值进去会直接 panic：

```text
panic: errors: target must be a non-nil pointer
```

### 4.3 怎么选

我的判断是：

* **Rust**：领域内部用清晰的枚举，跨模块或需要开放扩展的边界再上动态错误类型。
* **Go**：内部模块用稳定的自定义错误类型，对外通过接口、错误码和错误链提供契约。

但别把这两条当铁律。Rust 一样可以 `Box<dyn std::error::Error>`，Go 一样可以定义封闭的错误类别。

真正的判断标准是：**调用者需要知道多少信息？**

* 只需要知道成功与否 → 错误消息可能够了。
* 需要决定要不要重试 → 错误类型必须携带可决策的信息。
* 需要区分「用户输入错」和「基础设施挂」→ 这种区别必须出现在类型或分类里，不能靠解析字符串。

---

## 五、错误消息不能代替错误类型

这是生产代码里最常见的一类脆弱设计。

数据库返回：

```text
connection refused
```

上层看到字符串，猜是数据库不可用。然后写成：

```go
if strings.Contains(err.Error(), "connection refused") {
    retry()
}
```

Rust 里也一样会犯：

```rust
if error.to_string().contains("connection refused") {
    retry();
}
```

两种都不行。**错误消息会随版本、库实现、操作系统、协议变化。** 拿它当控制流条件，等于把稳定性押在别人的文案上。

正确做法是转换成稳定的类别：

```rust
enum RetryClass {
    Retryable,
    Permanent,
    Unknown,
}

fn classify_error(error: &AgentError) -> RetryClass {
    match error {
        AgentError::LlmUnavailable => RetryClass::Retryable,
        AgentError::InvalidInput(_) => RetryClass::Permanent,
        AgentError::ToolFailed(_) => RetryClass::Unknown,
        AgentError::Timeout(_) => RetryClass::Retryable,
        AgentError::Cancelled => RetryClass::Permanent,
        AgentError::Storage(_) => RetryClass::Unknown,
    }
}
```

```
Error
  │
  ▼
Error Classifier
  │
  ├── Retryable
  ├── Permanent
  ├── Cancelled
  ├── DeadlineExceeded
  └── Unknown
```

但分类只是决策输入，不是重试的充分条件。一个错误「可以重试」，还得问：

* 当前任务还成立吗？
* 剩余截止时间够吗？
* 会不会重复产生副作用？
* 下游是不是已经在过载？
* 重试会不会放大故障？

---

## 六、panic 与 recover

前面聊的都是普通错误。两种语言都还有另一套失败机制：

Go 有 `panic()`，Rust 有 `panic!()`。看起来像，但不能等同。

### 6.1 Rust 的 panic

```rust
fn main() {
    let value = Some(42);
    println!("{}", value.unwrap());
}
```

`unwrap()` 遇到 `None` 就 panic。

panic 一般用于：

* 不该发生的状态；
* 违反程序假设；
* 无法正常恢复的错误；
* 断言失败。

区分标准其实很简单：**可预期、需要向调用者报告的失败用 `Result`；违反程序不变量的才考虑 panic。**

```rust
fn parse_port(input: &str) -> Result<u16, std::num::ParseIntError> {
    input.parse()
}
```

解析用户输入失败是完全正常的，不该因为用户手抖就 panic。

panic 的行为取决于策略：默认 `unwind` 会栈展开并跑析构；`abort` 直接终止进程。

**即使展开，也不能保证所有资源都被恢复，更不能保证已发生的外部副作用被撤销。**

### 6.2 Go 的 panic 与 recover

```go
func parsePort(input string) (uint16, error) {
    value, err := strconv.ParseUint(input, 10, 16)
    if err != nil {
        return 0, err
    }
    return uint16(value), nil
}
```

这里用普通错误。

如果 `panic("unexpected state")`，就进入 panic 流程。`recover()` 可以在 `defer` 里捕获：

```go
func runSafely() {
    defer func() {
        if r := recover(); r != nil {
            log.Printf("panic recovered: %v", r)
        }
    }()
    panic("unexpected failure")
}
```

但 `recover` 不是普通的错误传播机制。它处理的是 panic 引发的非局部控制流，而且只能在符合规则的 deferred 函数里生效。

更重要的一句：**捕获 panic 不等于状态已经恢复。**

出了 panic 的地方可能已经改了共享内存、发了外部请求、或者只完成了多步操作的一部分。recover 只是让控制流继续，不会回滚任何事。

### 6.3 什么时候该用 panic

| 场景 | Rust | Go |
|---|---|---|
| 用户输入不合法 | `Result::Err` | `error` |
| 文件不存在 | `Result::Err` | `error` |
| 网络请求失败 | `Result::Err` | `error` |
| 外部服务暂时不可用 | 返回错误，上层决策 | 返回错误，上层决策 |
| 内部不变量被破坏 | 视情况 panic 或返回错误 | 视情况 panic 或返回错误 |
| 插件发生意外 panic | 按边界和策略考虑隔离 | 按边界和策略考虑 recover |
| 进程内存已损坏、状态不可信 | 不能假定恢复安全 | 不能假定恢复安全 |

最后一行最关键。不是所有 panic 都意味着内存坏了，但如果程序的不变量已经无法确认，那么「捕获异常继续跑」很可能把小问题放大成大问题。

对插件系统、脚本引擎、多租户任务执行器来说，**故障隔离往往比盲目恢复更重要**。

---

## 七、资源清理：Drop 与 defer

错误处理如果只管返回值不管资源，就是不完整的。

### 7.1 Rust 的 RAII

```rust
use std::fs::File;
use std::io::{self, Read};

fn read_file(path: &str) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    Ok(content)
}
```

`read_to_string` 失败就提前返回，`file` 离开作用域时照样析构，文件句柄照样关闭。

这就是 RAII：资源清理绑在所有权和作用域上，而不是绑在控制流上。

但这**不代表外部副作用能回滚**。已经写进数据库的数据，不会因为 Rust 对象析构而消失。

### 7.2 Go 的 defer

```go
func ReadFileContent(path string) ([]byte, error) {
    file, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer file.Close()

    content, err := io.ReadAll(file)
    if err != nil {
        return nil, err
    }
    return content, nil
}
```

`defer` 会在函数返回时执行，包括所有错误返回路径。

三点注意：

* `defer` 不等于事务回滚；
* 进程被强杀时 `defer` 不保证执行；
* 如果 `Close()` 本身可能失败且影响业务正确性，就不能无条件忽略。

Rust 有对称的问题：`Drop` 不能返回错误。需要报告错误的清理，得设计显式的 `close()` / `commit()`。

所以数据库事务这种必须显式收尾的东西，两边都不能交给通用清理机制：

```text
开始事务
   │
   ▼
执行修改
   │
   ├── 失败 ──► 回滚
   │
   └── 成功 ──► 提交
```

**提交还是回滚是业务决策，通用资源清理机制不可能替你猜。**

---

## 八、异步里的错误传播

### 8.1 Result 与 Future 是两个层次

```rust
async fn fetch_data() -> Result<String, FetchError> {
    // 异步请求
    Ok("data".to_string())
}
```

这个函数返回 Future，Future 完成后的输出类型是 `Result<String, FetchError>`。

```text
Future 的执行
      │
      ▼
Future 完成
      │
      ▼
Result<String, FetchError>
      │
      ├── Ok(data)
      └── Err(error)
```

要分清：「Future 有没有完成」是执行状态，「异步操作成不成功」是业务结果。

`Result` 不会让操作变异步，`Future` 也不会自动定义业务错误类型。

### 8.2 JoinHandle 的双层 Result

```rust
let handle = tokio::spawn(async {
    Err::<(), &str>("operation failed")
});
let result = handle.await;
```

`handle.await` 的类型是：

```text
Result<Result<(), &str>, tokio::task::JoinError>
```

为什么两层？

外层 `Result<_, JoinError>`：任务**本身**有没有正常完成——panic 了？被取消了？

内层 `Result<(), &str>`：任务里的**业务**成功了吗？

```text
JoinHandle.await
       │
       ▼
Result<业务结果, JoinError>
       │
       ├── Err(JoinError)
       │      └── 任务层面的失败
       │
       └── Ok(业务结果)
                 │
                 ▼
           Result<T, E>
                 │
                 ├── Ok(T)
                 └── Err(E)
```

这不是设计冗余。它把两种责任分开了：运行时报告任务执行状态，业务函数报告业务结果。

写 Agent Runtime 时这个区分特别有用：

* 工具调用失败 → 业务错误；
* 任务里 panic → 任务执行层故障；
* 任务被主动取消 → 生命周期事件；
* 工作线程被阻塞 → 调度和运行时问题。

这四种不该被压成同一个字符串。

### 8.3 Go 的 goroutine 不会把错误传回来

```go
go func() {
    if err := doWork(); err != nil {
        log.Printf("worker failed: %v", err)
    }
}()
```

错误只在 goroutine 内部处理，启动它的函数**收不到任何东西**。

要传出去就得自己搭路：

```go
resultCh := make(chan error, 1)
go func() {
    resultCh <- doWork()
}()
err := <-resultCh
if err != nil {
    return err
}
```

或者用 `errgroup`：

```go
g, ctx := errgroup.WithContext(ctx)
g.Go(func() error { return doWork(ctx) })
if err := g.Wait(); err != nil {
    return err
}
```

两种语言在这点上是共通的：**并发任务的错误必须有明确的传递路径，不会因为「是某个函数启动的」就自动回流。**

区别只在接口形态：

* Tokio：`JoinHandle` 返回双层 `Result`；
* Go：channel、共享状态或 `errgroup`。

---

## 九、什么错误该重试

从这里开始，从语言机制进入系统设计。

假设一次 LLM 请求失败了。最简单的写法：

```rust
loop {
    match call_llm().await {
        Ok(result) => break result,
        Err(_) => continue,
    }
}
```

Go 也容易写成一样：

```go
for {
    result, err := callLLM(ctx)
    if err == nil {
        return result, nil
    }
}
```

两段都是坑。服务持续不可用时就是无限重试，资源被持续烧掉。

所以「要不要重试」之外，还得问：

1. 这个错误暂时可恢复吗？
2. 重试会不会重复执行副作用？
3. 最大重试几次？
4. 有没有整体截止时间？
5. 要不要退避？
6. 要不要熔断？
7. 服务过载时该不该直接拒绝新请求？

### 9.1 错误分类

| 类别 | 例子 | 典型处理 |
|---|---|---|
| Validation | 参数不合法 | 直接返回 |
| Authentication | 凭证无效 | 返回错误，必要时刷新凭证 |
| RateLimited | 触发限流 | 退避后重试，遵守服务端策略 |
| Transient | 暂时性网络故障 | 有界重试 |
| Timeout | 操作超过期限 | 根据操作状态决定是否重试 |
| Cancelled | 主动取消 | 停止继续执行 |
| Permanent | 永久性业务失败 | 终止当前操作 |
| Internal | 内部状态异常 | 记录诊断，必要时隔离任务 |

这只是个基础分类。实际要按具体协议和业务语义来定。

比如 HTTP 500 不代表重试一定有用（可能是确定性 bug）；HTTP 429 必须遵守服务端给的 `Retry-After`，不能自己想退避多少就多少。

### 9.2 重试必须有边界

生产级重试至少要这几样：

* 最大尝试次数；
* 指数退避；
* 随机抖动；
* 总体截止时间；
* 取消检查；
* 错误分类；
* 幂等性保障。

指数退避：

```text
d_n = min(d_max, d_0 × 2^n)
```

其中 `d_0` 是初始等待，`n` 是第几次重试，`d_max` 是等待上限。

实际还要加随机抖动，否则所有客户端会在同一时刻一起重试，形成「同步重试风暴」。

```text
第一次失败：等待约 100ms
第二次失败：等待约 200ms
第三次失败：等待约 400ms
第四次失败：等待约 800ms
```

这些只是示例，不是推荐值。

### 9.3 重试不是回滚

这个原则比前面所有技巧都重要。

假设 Agent 通过工具向外部系统转账，请求发出后超时。可能是两种情况：

```text
情况 A：请求没到达服务端  → 没转账
情况 B：服务端已完成转账  → 响应丢了
```

**客户端看到的都是超时。**

直接重试，情况 B 就变成重复转账。

所以重试之前必须确认两件事：操作是否幂等，以及能不能查到上一次操作的最终状态。

常见解法：

* 幂等键；
* 服务端去重；
* 操作 ID；
* 查询操作状态；
* 事务；
* 补偿机制。

这在支付、任务调度、工具调用、Agent 执行框架里都是必修课。

---

## 十、重试之外：检查点、补偿、隔离

假设一个任务分三步：

```text
Task
 │
 ▼
Step A：读取数据
 │
 ▼
Step B：调用外部工具
 │
 ▼
Step C：保存结果
```

Step C 失败了。这时候不能只问「要不要整个重试」，得先看 Step A 和 Step B 做了什么、有没有副作用。

### 10.1 检查点恢复

保存任务执行状态：

```text
Task State
   │
   ├── Step A: Completed
   ├── Step B: Completed
   └── Step C: Failed
```

恢复时从 Step C 继续，不重跑全部。

这要求系统明确持久化：

* 已完成步骤；
* 每步的输出；
* 任务版本；
* 当前状态；
* 已执行的外部副作用；
* 重试次数；
* 恢复所需上下文。

### 10.2 补偿操作

有些操作没法回滚：

```text
创建资源
   │
   ▼
发送通知
   │
   ▼
后续步骤失败
```

通知已经发出去，撤不回来。这时只能补偿：更新状态、发更正通知、或者转人工处理。

这类设计就是 Saga 模式在干的事。

### 10.3 隔离与熔断

某个下游工具连续失败，继续往里灌请求只会让情况更糟。这时候可以考虑：

* 暂停对该工具的请求；
* 限制并发；
* 暂时拒绝任务；
* 用降级实现；
* 等健康检查恢复。

到这一步，讨论已经从「单个错误怎么处理」升级成「系统级故障治理」。

一句话区分：

> **错误传播负责告诉系统发生了什么；故障恢复负责决定系统接下来怎么做。**

---

## 十一、生产级错误模型的三层结构

我不会把所有错误塞进一个巨大的字符串。合理的做法是分层。

### 11.1 底层技术错误

```text
IO Error
HTTP Error
Database Error
Serialization Error
```

这一层尽量保留原始信息，方便定位。

### 11.2 应用错误

```text
InvalidTask
ToolUnavailable
ExecutionTimeout
StorageFailure
PermissionDenied
```

这一层负责把不同的技术错误映射成应用能理解的类别。

### 11.3 调度决策

```text
Retry
Fail
Cancel
Degrade
Wait
Escalate
```

这一层**不能**只看错误字符串，要综合：

* 错误类别；
* 剩余截止时间；
* 任务当前状态；
* 是否允许重试；
* 重试预算；
* 外部副作用；
* 当前系统负载。

```text
底层错误
    │
    ▼
错误归一化
    │
    ▼
应用错误类型
    │
    ▼
调度策略
    │
    ├── Retry
    ├── Fail
    ├── Cancel
    ├── Degrade
    └── Escalate
```

这个分层最大的价值是：**不让底层 HTTP 客户端去决定整个 Agent 任务该怎么恢复。**

底层只负责提供准确的错误信息和分类依据；恢复策略交给了解任务语义和资源预算的上层。

---

## 十二、一个完整例子

有界重试的外部请求。为了聚焦错误处理，省略 HTTP 配置、日志、指标、取消传播等生产细节。

### 12.1 Rust 版

```rust
use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug)]
enum AppError {
    InvalidInput,
    TemporaryFailure,
    PermanentFailure,
}

async fn call_service() -> Result<String, AppError> {
    // 模拟一次外部调用
    Err(AppError::TemporaryFailure)
}

async fn execute_with_retry(max_attempts: usize) -> Result<String, AppError> {
    if max_attempts == 0 {
        return Err(AppError::InvalidInput);
    }

    for attempt in 0..max_attempts {
        match call_service().await {
            Ok(value) => return Ok(value),
            Err(AppError::TemporaryFailure) if attempt + 1 < max_attempts => {
                let delay = Duration::from_millis(100 * (1u64 << attempt.min(10)));
                sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    }

    Err(AppError::PermanentFailure)
}
```

几个设计点：

1. 错误类别显式；
2. 只对暂时性错误重试；
3. 重试次数有上限；
4. 退避等待本身是异步的（不阻塞线程）；
5. 最终失败以 `Err` 返回。

实测跑一下：

```text
retry result: Err(TemporaryFailure)
```

注意 `sleep(delay).await` 这一行：它让出执行权，其他任务可以继续跑。如果换成 `std::thread::sleep`，整个 worker 线程就被卡住了。

这只是教学示例。真实实现还要加随机抖动、总截止时间、取消令牌、重试预算和幂等控制。

### 12.2 Go 版

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "time"
)

var (
    ErrTemporary = errors.New("temporary failure")
    ErrPermanent = errors.New("permanent failure")
)

func callService(ctx context.Context) (string, error) {
    // 模拟一次外部调用
    return "", ErrTemporary
}

func executeWithRetry(ctx context.Context, maxAttempts int) (string, error) {
    if maxAttempts <= 0 {
        return "", errors.New("maxAttempts must be positive")
    }

    for attempt := 0; attempt < maxAttempts; attempt++ {
        value, err := callService(ctx)
        if err == nil {
            return value, nil
        }
        if !errors.Is(err, ErrTemporary) {
            return "", err
        }
        if attempt+1 == maxAttempts {
            return "", err
        }

        delay := 100 * time.Millisecond * time.Duration(1<<min(attempt, 10))
        timer := time.NewTimer(delay)
        select {
        case <-ctx.Done():
            if !timer.Stop() {
                select {
                case <-timer.C:
                default:
                }
            }
            return "", ctx.Err()
        case <-timer.C:
        }
    }

    return "", ErrPermanent
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    value, err := executeWithRetry(ctx, 3)
    if err != nil {
        fmt.Println("failed:", err)
        return
    }
    fmt.Println(value)
}
```

这里展示了：

1. 用 `error` 返回失败；
2. 用 `errors.Is` 判断类别；
3. 用 `context.Context` 传播取消；
4. 用 `select` 让退避等待也能被取消；
5. 限制重试次数。

那个 `timer.Stop()` + 二次 `select` 的写法是 Go 的标准模式：如果 `Stop` 返回 `false`，说明 timer 已经触发，通道里可能还有值，要先排空再返回，否则会泄漏。

### 12.3 真正的差别

Rust：

```rust
match call_service().await {
    Ok(value) => return Ok(value),
    Err(error) => { /* 分类与处理 */ }
}
```

Go：

```go
value, err := callService(ctx)
if err == nil {
    return value, nil
}
```

表面上一个用 `Result` 一个用 `error`。但两者真正的架构是一样的：

```text
调用外部服务
      │
      ▼
获得成功或失败结果
      │
      ▼
判断错误类别
      │
      ▼
检查重试预算
      │
      ▼
等待退避时间
      │
      ▼
重新尝试或返回错误
```

**决定系统可靠性的，不是 `Result` 和 `error` 哪个更漂亮，而是错误分类、重试预算、取消传播、幂等性和恢复策略有没有设计对。**

---

## 十三、总结

七条：

1. **Rust 强调错误的类型化表达。** `Result<T, E>` 把成功和失败放进一个显式类型，配合 `?`、`match` 和自定义错误类型，能建立清晰的传播链。
2. **Go 强调普通控制流里的显式检查。** `(T, error)` 加 `if err != nil`，灵活直接，也方便在每个点插入局部逻辑。
3. **Rust 的类型系统能约束形式，但保证不了业务正确。** 调用者照样能 `unwrap()`，或者返回个错误却没有恢复策略。
4. **两边的 panic 都不该代替日常错误返回。** 可预期的失败用 `Result` / `error`；意外状态要先判断能不能安全恢复，而不是一律捕获后继续跑。
5. **任务取消不等于外部操作回滚。** 无论是 drop Future 还是 `context` 取消，都撤不回已经发出的请求和已提交的事务。
6. **重试必须建立在分类、预算、幂等性之上。** 不能因为出错了就盲目重跑。
7. **故障恢复是系统设计问题，不是语言特性。** 对 Agent Runtime 来说，真正重要的是让任务在失败、取消、超时和进程重启后，仍然有明确的状态和可预测的恢复行为。

一句话收尾：

> Rust 和 Go 都提供了显式的错误传播机制，但生产系统的可靠性，最终取决于你怎么把错误类型、任务状态、重试策略、取消语义和恢复机制组合起来。
