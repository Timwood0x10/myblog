+++
title = "Rust 的 unsafe 边界：原始指针、型变与 FFI"
date = 2026-10-25
description = "unsafe 不是关掉检查，而是把证明责任交给程序员。沿安全边界 → 原始指针 → 型变 → FFI → Send/Sync → 安全抽象这条线，拆解系统级 Rust 的正确写法。"
weight = 5
[taxonomies]
tags = ["Rust", "Unsafe", "FFI", "Lifetime"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

FFI、unsafe、生命周期、协变与逆变、内存布局，是从「会写 Rust」到「能做系统级 Rust」的分水岭。这篇沿 [Meet Safe and Unsafe](https://doc.rust-lang.org/nomicon/safe-unsafe-meaning.html) → [Subtyping and Variance](https://doc.rust-lang.org/nomicon/subtyping.html) → [FFI](https://doc.rust-lang.org/nomicon/ffi.html) → [Working with Unsafe](https://doc.rust-lang.org/nomicon/working-with-unsafe.html) 的顺序拆解。

---

## 一、Safe Rust 与 Unsafe Rust 的边界

先纠正一个常见误解：

> `unsafe` 不代表这段代码不安全，而是代表**编译器无法替你证明**某些操作满足安全条件，需要程序员承担证明责任。

安全 Rust：

```rust
fn main() {
    let x = 42;
    let r = &x;
    println!("{r}");
}
```

编译器能验证引用的使用满足安全规则。

需要 unsafe：

```rust
fn main() {
    let x = 42;
    let ptr = &x as *const i32;
    unsafe {
        println!("{}", *ptr);
    }
}
```

通过原始指针读取数据需要 `unsafe`。但这并不意味着它一定不安全——只要指针有效、对齐正确、指向有效的 `i32`、且访问满足别名与生命周期要求，这次读取就是合法的。

反过来，代码里出现 `unsafe` 也不代表程序员已经证明了它的正确性。

### 1.1 unsafe 究竟允许做什么

| 操作 | 为什么需要 unsafe |
|---|---|
| 解引用原始指针 | 编译器无法保证指针有效 |
| 调用 `unsafe fn` | 调用者必须满足函数的安全契约 |
| 访问 `static mut` | 编译器无法保证全局访问的线程安全 |
| 实现 `unsafe trait` | 实现者必须保证满足该 trait 的安全契约 |
| 使用底层内存操作 | 必须保证内存状态、初始化状态与类型不变量正确 |

`unsafe` 并不关闭 Rust 的所有检查。下面这段没有任何需要 unsafe 的操作，类型检查、借用检查照常执行：

```rust
unsafe {
    let x: i32 = 10;
    let y = x + 20;
}
```

更准确地说，Rust 的安全模型要求：**即使一个库内部使用了 unsafe，它暴露给调用者的安全 API 也不应该允许安全 Rust 代码触发未定义行为（UB）**。这就是底层库必须重视安全抽象的原因。

---

## 二、谁负责证明安全

理解 unsafe，最好从调用关系切入：

```rust
unsafe fn read_value(ptr: *const i32) -> i32 {
    *ptr
}
```

传入的 `ptr` 一定有效吗？不一定。调用者可能传入空指针、已释放的地址、未对齐的地址、未初始化的内存，或指向其他类型对象的地址。

因此这个函数有一个**隐含的安全契约**：调用者必须保证指针满足解引用所需的全部条件。

把契约写出来：

```rust
/// # Safety
///
/// `ptr` 必须指向一个有效、正确对齐且已初始化的 i32，
/// 并且读取操作必须满足 Rust 的内存安全规则。
unsafe fn read_value(ptr: *const i32) -> i32 {
    unsafe { *ptr }
}
```

这里要区分两个层次：

1. `unsafe fn`：**调用者**承担满足安全契约的责任。
2. 函数内部的 `unsafe` 块：**实现者**确保其中的操作符合要求。

Rust 2024 Edition 起，`unsafe fn` 内部的 unsafe 操作需要显式写成 `unsafe {}` 块（`unsafe_op_in_unsafe_fn` 在该 edition 默认开启警告），以便把安全边界画清楚。

面试时的一句话概括：**unsafe 把部分安全责任从编译器转移给程序员，但不会取消这些操作必须满足的安全要求。**

### 2.1 对外安全，对内 unsafe

```rust
/// 读取一个有效的 i32。
///
/// # Safety
///
/// 调用者必须保证 ptr 指向有效、正确对齐且已初始化的 i32。
pub unsafe fn read_raw(ptr: *const i32) -> i32 {
    unsafe { *ptr }
}

/// 读取一个普通引用指向的 i32。
pub fn read_ref(value: &i32) -> i32 {
    *value
}
```

第二个函数不需要 unsafe，因为 `&i32` 本身携带了更强的有效性保证。

安全抽象的基本思想：

* 尽可能用安全类型表达约束；
* 把必须使用的 unsafe 限制在较小的内部区域；
* 在安全 API 的入口检查必要条件；
* 不把无法验证的假设留给普通调用者。

---

## 三、原始指针

| 特征 | 引用 `&T` / `&mut T` | 原始指针 `*const T` / `*mut T` |
|---|---|---|
| 默认可以为空 | 否 | 是 |
| 编译器验证有效性 | 有较强保证 | 不保证 |
| 携带生命周期信息 | 是 | 不携带 |
| 解引用是否需要 unsafe | 通常不需要 | 需要 |
| 常见用途 | 普通 Rust 代码 | FFI、底层内存操作、互操作 |

```rust
let value = 100;
let reference: &i32 = &value;
let raw_ptr: *const i32 = &value;
```

两者都能指向 `value`，但契约不同：引用表示「这是一个满足 Rust 引用规则的借用」；原始指针只提供地址层面的信息——「这里可能有一个地址，但你不能仅凭类型认定它有效」。

原始指针没有生命周期，**不代表它可以安全地长期保存**：

```rust
let ptr: *const i32;
{
    let value = 42;
    ptr = &value;
}
// value 已离开作用域，ptr 不能再被安全解引用
```

原始指针允许绕过部分静态生命周期检查，但不会改变底层内存的真实生命周期。

---

## 四、协变、逆变、不变

Variance 只需抓住一个问题：**当一个类型包含另一个类型时，内部类型的关系能不能传递到外部类型？**

### 4.1 先理解子类型关系

```rust
let long: &'static str = "hello";

fn print_str<'a>(value: &'a str) {
    println!("{value}");
}
```

`'static` 表示引用指向的数据至少存活到程序结束。因为字符串字面量拥有 `'static`，它也可以当作较短生命周期的引用来用：

```text
'static <: 'a
```

`'long <: 'short` 的含义是：较长的生命周期满足较短生命周期所要求的存活范围。**这不是把变量的生命周期真的缩短了，而是说它可以在需要较短生命周期的上下文中使用。**

### 4.2 协变 Covariance

若 `T1 <: T2` 能推出 `F<T1> <: F<T2>`，则 `F` 对 `T` 协变——内部类型可以往更宽松的方向变，外部类型跟着变。

最常见的例子是共享引用：`&'a T` 对 `'a` 协变。

```rust
fn print_str<'a>(s: &'a str) {
    println!("{s}");
}

fn main() {
    let value: &'static str = "hello";
    print_str(value);
}
```

拥有型容器通常也对 `T` 协变：`Box<T>`、`Vec<T>`。例如 `Vec<&'static str>` 在类型约束满足时可以转成 `Vec<&'a str>`——转换后只是放弃了对更长生命周期的保证，并没有凭空制造出更长的生命周期。

### 4.3 不变 Invariance

即使 `T1 <: T2`，也推不出 `F<T1> <: F<T2>`。最重要的例子是 `&mut T`，它对 `T` 不变。

为什么？因为 `&mut T` 既能读也能写。假如允许：

```text
&mut &'static str  ->  &mut &'a str
```

而 `'static <: 'a` 看起来合理，但会出问题：

```rust
fn assign<T>(slot: &mut T, value: T) {
    *slot = value;
}

fn main() {
    let mut hello: &'static str = "hello";
    {
        let world = String::from("world");
        assign(&mut hello, world.as_str());
        // 若允许把短生命周期引用写进承诺保存 'static 的位置，
        // 就会在 world 释放后留下悬垂引用
    }
    println!("{hello}");
}
```

这段代码会因生命周期约束而编译失败。它展示的是「为什么不能允许这种转换」，不是可编译的漏洞示例。

核心原因：**可变引用既是读通道也是写通道，允许内部生命周期随意变化会破坏写入的安全性。**

### 4.4 逆变 Contravariance

若 `T1 <: T2`，对逆变的 `F` 有 `F<T2> <: F<T1>`。

Rust 中最典型的是函数参数：

```rust
fn accept_any_str(_: &str) {}
fn accept_static_str(_: &'static str) {}
```

如果调用方需要一个能接收任意 `'static` 字符串的函数，`accept_any_str` 也能满足——它接受的范围更宽。反过来不行：只能接收 `'static` 的函数，无法替代需要接收任意有效字符串的函数。

所以函数参数位置是逆变的，返回值位置是协变的：

```text
fn(T) -> U
T：逆变
U：协变
```

### 4.5 型变速查表

| 类型 | 对生命周期的型变 | 对 `T` 的型变 |
|---|---|---|
| `&'a T` | 协变 | 协变 |
| `&'a mut T` | 协变 | 不变 |
| `Box<T>` | — | 协变 |
| `Vec<T>` | — | 协变 |
| `*const T` | — | 协变 |
| `*mut T` | — | 不变 |
| `UnsafeCell<T>` | — | 不变 |
| `Cell<T>` | — | 不变 |
| `fn(T) -> U` | 取决于签名 | 参数逆变、返回值协变 |

注意：生命周期型变与类型参数型变是两个维度。`&'a mut T` 对 `'a` 协变，但对 `T` 不变。

---

## 五、型变对 unsafe 与 FFI 的意义

unsafe 代码经常绕过编译器平时用来保护生命周期的约束，所以必须自己守住型变规则。

```rust
struct MyPointer<T> {
    ptr: *mut T,
}
```

`*mut T` 对 `T` 不变，所以 `MyPointer<T>` 通常也因为该字段而对 `T` 不变。

这意味着：

```text
MyPointer<&'static str>  ->  MyPointer<&'a str>
```

不能仅凭内部生命周期的子类型关系推导出来。因为原始指针可能被用于写入——错误地允许转换，就可能把短生命周期引用写进仍被认为保存着长生命周期引用的位置。这与 `&mut T` 不变是同一个安全考量。

但要分清：型变规则**不会**验证原始指针是否有效，也**不会**让 unsafe 操作变安全，它只是限制哪些类型转换成立。设计底层封装时，下面这些条件必须同时成立：

* 类型参数的型变；
* 生命周期约束；
* 指针有效性；
* 对齐要求；
* 内存初始化；
* 别名与可变性；
* 所有权与释放时机。

---

## 六、FFI 基础

FFI 是 Foreign Function Interface。

```c
// math.c
int add(int a, int b) {
    return a + b;
}
```

```rust
unsafe extern "C" {
    fn add(a: i32, b: i32) -> i32;
}

fn main() {
    let result = unsafe { add(10, 20) };
    println!("{result}");
}
```

两个关键点：

**`extern "C"`** 指定 C ABI。ABI 不只是函数名，还包括参数如何传递、返回值如何返回、调用约定等。

**`unsafe`** 因为 Rust 编译器无法验证外部实现是否符合声明：实际参数类型是否一致、签名是否准确、外部函数是否访问非法内存、是否满足线程安全约束。

这里 `i32` 与 C 的 `int` 在常见平台相符，但**不能泛化到所有 C 类型**。真实项目应按目标平台使用 `std::ffi::c_int` 等准确类型。

### 6.1 repr(C)

普通 Rust 结构体不保证 C 布局：

```rust
struct Point {
    x: f64,
    y: f64,
}
```

如果要直接传给 C，需要：

```rust
#[repr(C)]
struct Point {
    x: f64,
    y: f64,
}
```

但 `#[repr(C)]` **只解决布局兼容**，它不意味着：

* 任意 Rust 类型都能安全传给 C；
* 所有字段自动具有 C 兼容性；
* 任意指针都有效；
* 所有权与释放责任会自动协调。

### 6.2 字符串是经典陷阱

Rust 的 `String` 与 C 的 `char *` 不是同一种东西：Rust 字符串不以 NUL 结尾，C 字符串依赖 `\0` 确定结束位置。所以不能随便把 `String` 的内部指针当成合法 C 字符串。

```rust
use std::ffi::CString;

fn main() {
    let text = CString::new("hello").unwrap();
    let ptr = text.as_ptr();
    // 在 text 仍然存活时，可以把 ptr 交给符合约定的 C API
    // 但不能在 text 被释放后继续使用 ptr
}
```

关键不在转换语法，而在**指针有效期必须覆盖外部代码使用它的整个期间**。如果 C 函数会保存指针供稍后使用，仅仅在调用期间保持 `CString` 存活就不够。此外 C API 还可能要求调用者提供缓冲区、长度或释放函数——这些都是 FFI 安全契约的一部分。

---

## 七、跨语言最危险的失配

最常见的错误不是函数声明本身，而是双方对所有权、生命周期和线程安全的理解不一致。

```c
int *get_data(void);
```

```rust
unsafe extern "C" {
    fn get_data() -> *mut i32;
}
```

仅凭签名，无法知道：

1. 返回的指针是否可能为空？
2. 数据由谁分配？
3. 数据由谁释放？
4. 内存有效多久？
5. 其他线程能否同时修改？
6. 是否有特殊的对齐或布局要求？

这正是成熟 FFI 库要在原始指针外面再包一层安全接口的原因：把约定用类型系统表达出来，而不是把裸指针直接暴露给所有调用者。

---

## 八、把知识串成一条链

```text
Safe Rust
    │
    ├── 编译器验证所有权、借用和生命周期
    │
    ▼
Unsafe Rust
    │
    ├── 原始指针
    ├── 手动内存操作
    ├── unsafe Trait
    └── 需要额外安全契约的操作
    │
    ▼
Variance / Subtyping
    │
    ├── 限制生命周期与类型转换
    ├── 防止不合法的引用替换
    └── 帮助设计正确的泛型封装
    │
    ▼
FFI
    │
    ├── ABI 与内存布局
    ├── 所有权与释放责任
    ├── 指针有效性
    └── 跨语言线程安全
    │
    ▼
Safe Abstraction
    │
    └── 把底层风险封装在明确、可验证的接口内
```

型变不是纯理论，它是类型系统维护生命周期安全的一部分；FFI 则是类型系统无法完全控制外部代码时，安全契约变得格外重要的场景。Rust 能检查引用是否满足生命周期约束，但不能只凭一个 C 函数声明就证明 C 实现在返回后不会继续使用已失效的指针。

---

## 九、设计原则：把 unsafe 限制在边界内

核心原则一句话：**对外提供尽可能安全、符合 Rust 习惯的 API；对内集中处理指针、内存布局、生命周期与外部调用。**

一个好设计通常分三层：

```text
┌──────────────────────────────────────────┐
│              Safe API                    │
│                                          │
│  fn analyze(input: &[u8]) -> Result<...> │
│  fn close(&mut self) -> Result<()>       │
├──────────────────────────────────────────┤
│        Safety / Ownership Layer          │
│                                          │
│  参数验证、所有权管理、生命周期管理      │
│  错误转换、资源释放、线程安全约束        │
├──────────────────────────────────────────┤
│           Unsafe / FFI Layer             │
│                                          │
│  原始指针、extern "C"、repr(C)           │
│  C ABI、内存布局、外部资源管理           │
└──────────────────────────────────────────┘
```

不要在整个项目里到处散落：

```rust
unsafe {
    external_function(ptr, len);
}
```

而是建立一个独立的底层模块集中外部调用，再由安全接口向上层提供功能。三个好处：

1. **缩小审计范围**：需要重点审查的 unsafe 代码更集中。
2. **隔离外部约定**：C 的所有权和生命周期规则不必渗透整个 Rust 项目。
3. **提高可测试性**：上层业务逻辑可以在不依赖真实 C 库的情况下测试。

---

## 十、设计 unsafe API 前先回答五个问题

| 问题 | 需要确定什么 |
|---|---|
| 1. 为什么需要 unsafe？ | 是否真的需要原始指针、外部调用或手动内存操作？ |
| 2. 谁负责保证安全？ | 调用者负责，还是封装内部负责？ |
| 3. 安全条件是什么？ | 指针有效、对齐、初始化、生命周期、别名等约束 |
| 4. 哪些条件能自动验证？ | 能否用安全类型、长度检查、状态检查消除部分风险？ |
| 5. 如何验证实现正确？ | 单元测试、边界测试、Miri、Sanitizer 如何组合？ |

其中最关键的是第二个。

### 10.1 两种完全不同的设计

**方案 A：由调用者保证安全**

```rust
/// # Safety
///
/// `ptr` 必须指向一个有效、正确对齐且已初始化的 i32，
/// 并且读取期间必须满足 Rust 的内存安全规则。
pub unsafe fn read_raw(ptr: *const i32) -> i32 {
    // SAFETY: 函数调用者必须满足上面声明的安全契约。
    unsafe { *ptr }
}
```

这个接口把部分安全责任交给调用者，适用于底层库确实需要开放原始指针操作的场景。但文档里的契约必须完整——仅仅说「指针有效」不够，还要覆盖读取期间的有效性、初始化、对齐和别名规则。

**方案 B：由封装层保证安全**

```rust
pub fn read_ref(value: &i32) -> i32 {
    *value
}
```

调用者不需要自行证明指针有效性，因为安全引用已经携带更强的约束。

**结论：能用安全类型表达约束，就不要把不必要的安全责任交给调用者。** 但这不意味着所有原始指针都要藏起来——如果调用者确实需要控制指针生命周期、与外部 API 交互或自行管理资源，提供明确的 unsafe 接口是合理的。

---

## 十一、安全不变量

**安全不变量（Safety Invariant）**：为保证代码不产生 UB，某些条件必须在对象的整个相关生命周期内始终成立。

包装 C 资源时，例如：

```rust
pub struct Engine {
    handle: NonNull<CEngine>,
}
```

我们希望它满足：

1. `handle` 非空。
2. `handle` 指向有效的 C 引擎对象。
3. 该对象只有一个负责释放它的所有者。
4. 对象释放后不允许再访问。
5. 所有 C API 调用遵循该库的线程安全约束。
6. 如果 C API 要求先销毁子对象，析构必须遵循正确顺序。

这些不变量决定了实现形态：

```rust
impl Engine {
    pub fn new() -> Result<Self, EngineError> {
        // 1. 调用 C API 创建对象
        // 2. 检查返回值和错误状态
        // 3. 检查句柄是否为空
        // 4. 成功后构造 Engine
        todo!()
    }

    pub fn execute(&mut self, input: &[u8]) -> Result<(), EngineError> {
        // 1. 验证输入是否符合 C API 约定
        // 2. 调用内部 FFI 包装
        // 3. 把错误状态转换成 Rust 错误
        todo!()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // 按 C API 约定释放资源
    }
}
```

两点必须记住：

* **`NonNull<T>` 只表达非空**，不会保证地址有效、内存未释放或对象类型正确。
* **`Drop` 不能修复错误的所有权设计**。如果外部代码提前释放了句柄，`Drop` 再次释放就是双重释放。资源所有权必须在 API 设计阶段定清楚，而不是在析构函数里补救。

---

## 十二、sys 层与安全封装层分离

一个实用的项目组织方式：

```text
codescope/
├── codescope-core/
│   ├── src/
│   │   ├── analyzer.rs
│   │   ├── graph.rs
│   │   └── error.rs
│   └── Cargo.toml
│
├── codescope-sys/
│   ├── src/
│   │   ├── bindings.rs
│   │   └── lib.rs
│   ├── native/
│   │   └── analyzer.cpp
│   └── Cargo.toml
│
└── codescope-ffi/
    ├── src/
    │   ├── engine.rs
    │   ├── buffer.rs
    │   └── lib.rs
    └── Cargo.toml
```

这是可选的方案，不是每个项目都要拆三个 crate。

### 12.1 codescope-sys：只处理原始接口

负责 C ABI 声明、绑定生成、C 类型与 Rust FFI 类型映射、原始指针与句柄、外部库链接。

```rust
use std::ffi::c_int;

#[repr(C)]
pub struct CEngine {
    _private: [u8; 0],
}

unsafe extern "C" {
    pub fn engine_create(out: *mut *mut CEngine) -> c_int;
    pub fn engine_destroy(engine: *mut CEngine);
    pub fn engine_run(
        engine: *mut CEngine,
        data: *const u8,
        len: usize,
    ) -> c_int;
}
```

`[u8; 0]` 是表达「不透明类型」的惯用法。真实项目必须以 C 头文件和实际实现为准：C 的 `size_t` 应映射为 `usize` 或合适的 FFI 类型，返回值、指针可空性和错误码都必须与 ABI 一致。

另外，`#[repr(C)]` 不会让 Rust 结构体自动变成 C++ 对象。复杂的 C++ 类通常应该通过一个 C ABI 桥接层暴露不透明句柄，而不是直接跨 ABI 传递类实例。

### 12.2 codescope-ffi：包装成 Rust API

```rust
pub struct Engine {
    handle: NonNull<ffi::CEngine>,
}

impl Engine {
    pub fn new() -> Result<Self, EngineError> {
        // 创建并检查 C 句柄
        todo!()
    }

    pub fn run(&mut self, input: &[u8]) -> Result<(), EngineError> {
        // 把 Rust slice 转换为指针和长度
        // 在保证输入契约成立的前提下调用 C
        todo!()
    }
}
```

这一层负责参数校验、资源所有权、错误转换、线程安全约束、生命周期管理与安全 API。

### 12.3 codescope-core：尽量保持纯 Rust

分析流程、图构建、业务规则、结果处理、算法实现。这样底层 C++ 引擎变化时，业务层不需要了解指针、析构顺序和 ABI。

这也符合微软 Rust 指南的建议：业务逻辑放在核心 crate，FFI 层只负责接口转换。

---

## 十三、FFI 的所有权与生命周期

```c
const unsigned char *engine_get_data(
    Engine *engine,
    size_t *out_len
);
```

返回的指针可能指向引擎内部的缓冲区，**不能直接转成拥有所有权的 `Vec<u8>`**：`Vec<u8>` 的析构会释放它自己拥有的内存，而这块内存可能由引擎管理。误当成 Rust 分配的内存就会非法释放。

先确定契约：

* 指针是否可能为空？
* 长度由谁提供？
* 指针何时失效？
* 下次调用 API 是否会覆盖缓冲区？
* 销毁引擎后指针是否仍然有效？
* 是否允许其他线程同时修改？

### 13.1 方案 A：复制数据，返回拥有所有权的 Vec

数据量允许时，这是最稳妥的设计。

```rust
pub fn get_data(&mut self) -> Result<Vec<u8>, EngineError> {
    // 1. 从 C API 获取指针和长度
    // 2. 验证返回值及长度契约
    // 3. 复制到 Rust 自己拥有的 Vec<u8>
    // 4. 返回
    todo!()
}
```

优点：调用者不需要理解 C 内部缓冲区的生命周期；返回值独立于引擎的后续状态；内存释放由 Rust 所有权负责。代价是复制。

### 13.2 方案 B：返回借用切片

```rust
impl Engine {
    pub fn data(&self) -> &[u8] {
        // 从 C API 获取指针和长度
        // 在所有前置条件成立时构造切片
        todo!()
    }
}
```

这个接口复杂得多，因为 `&[u8]` 不只承诺地址和长度，还承诺：

* 数据在整个借用期间有效；
* 满足切片所需的对齐和初始化要求；
* 读取期间满足 Rust 的别名和可变性规则；
* 长度不超过有效内存范围。

如果 C 代码可能在 Rust 持有切片时修改或释放缓冲区，必须从设计上禁止，或用同步与所有权协议控制。做不到就不该返回借用切片。

**零拷贝不是默认更好的设计。先保证契约正确，再谈性能。**

---

## 十四、什么时候该 unsafe impl Send / Sync

```rust
pub struct Engine {
    handle: NonNull<ffi::CEngine>,
}
```

它能否跨线程移动、能否被多线程共享，取决于 **C 引擎本身的线程安全契约**，而不是「Rust 代码能不能编译通过」。

### 14.1 不要为了方便就实现

```rust
// 仅为说明语法
unsafe impl Send for Engine {}
```

实现 `Send` 是在承诺：把 `Engine` 的所有权转移到另一个线程不会破坏安全保证。实现 `Sync` 是在承诺：多线程通过共享引用访问它不会造成数据竞争。

如果 C 引擎内部有未同步的全局状态，或要求所有操作都发生在创建它的线程，随意实现这两个 trait 就会破坏安全性。

几个容易忽略的点：

* C API 文档说「线程安全」，不一定意味着**每个句柄**都能被并发访问；
* 支持多线程**创建多个对象**，不等于允许多线程**同时操作同一个对象**；
* 加一个 `Mutex` 也解决不了线程亲和性、回调重入或外部资源的全局约束。

如果引擎只支持单线程，最好的方案通常是保留这个限制；确实需要跨线程时，把资源放进专用工作线程，通过消息传递调用它。只有在完整理解外部库并发契约、并证明封装维持了这些约束之后，才应该手动实现 `Send` / `Sync`。

---

## 十五、如何写安全注释

每个关键的 unsafe 操作都应有对应的安全说明。这样写没有信息量：

```rust
// SAFETY: Safe to call.
```

有用的注释要回答：

* `self.handle` 为什么仍然有效？
* `input.as_ptr()` 指向的内存能否覆盖整个调用期间？
* `input.len()` 是否与实际缓冲区长度一致？
* C 函数是否会保存该指针？
* C 函数是否可能并发修改这块内存？

```rust
// SAFETY:
// - self.handle 由 Engine 持有，且在本次调用期间保持有效。
// - input 是有效的 Rust slice，指针和长度来自同一个 slice。
// - C API 只在本次调用期间读取 input，不保存该指针。
// - Engine 的访问方式满足底层 C API 的线程安全要求。
let result = unsafe {
    ffi::engine_run(
        self.handle.as_ptr(),
        input.as_ptr(),
        input.len(),
    )
};
```

这些说明依赖真实的 C API 契约。如果 C 函数会保存输入指针，第三条就不成立，设计也必须改变。

---

## 十六、如何测试 unsafe / FFI 模块

普通单元测试不够：很多内存安全错误不会立即崩溃，甚至只在特定优化或时序下暴露。

| 测试类型 | 重点 |
|---|---|
| 正常路径 | 合法输入、创建、调用、释放 |
| 边界测试 | 空输入、零长度、超大长度、异常返回值 |
| 生命周期测试 | 重复释放、缓冲区失效、析构顺序、回调晚到 |
| 并发测试 | 多线程调用、竞争访问、线程退出与资源释放 |

工具层面：

1. **[Miri](https://github.com/rust-lang/miri)**：检测部分 Rust UB，包括无效指针访问、未初始化内存访问、别名规则违规。但不能证明整个程序正确，也替代不了真实 C/C++ 库的集成测试。
2. **Sanitizer**（ASan 等）：检查越界访问、释放后使用。覆盖范围受编译方式、运行环境和错误类型影响。
3. **FFI 集成测试**：真实调用 C/C++ 库，验证 ABI 声明、资源创建销毁是否匹配、字符串与缓冲区是否按契约传递、回调是否可能在对象释放后发生、错误路径是否正确处理。
4. **Fuzzing**：适合解析器、二进制接口、跨语言输入验证，找边界输入引发的崩溃与状态错误。

测试可以增加信心，但替代不了安全契约的设计与推理。

---

## 十七、把方法用于跨语言分析器

分析器遇到这样的跨语言调用时：

```text
Rust
  │
  │ 传递 *mut Buffer
  ▼
C/C++
  │
  ├── 读取 Buffer
  ├── 可能保存指针
  ├── 可能修改内容
  └── 可能释放资源
```

不能仅看到 `unsafe` 就认定有漏洞，也不能仅看到 `#[repr(C)]` 就认为安全。应该回答：

| 维度 | 关键问题 |
|---|---|
| ABI | Rust 声明与实际 C 函数签名是否匹配？ |
| 布局 | 传递的结构体是否采用兼容布局？ |
| 所有权 | 哪一方负责释放内存？ |
| 生命周期 | 外部函数是否保存了可能失效的指针？ |
| 别名 | 是否存在违反 Rust 引用规则的读写访问？ |
| 线程安全 | 是否存在跨线程数据竞争或非法共享？ |
| 错误路径 | 创建失败、回调失败或提前退出时资源是否正确释放？ |

更系统的做法是把每个 FFI 函数抽象成一份契约：

```text
Function Contract
├── ABI
├── Argument Constraints
├── Pointer Validity
├── Ownership Transfer
├── Lifetime / Retention
├── Mutability / Aliasing
├── Thread Safety
├── Callback Behavior
└── Error / Cleanup Behavior
```

这比扫描 `unsafe` 关键字更有价值：**unsafe 是风险信号，不是漏洞结论**，真正的漏洞取决于具体操作是否违反安全契约。

---

## 十八、设计检查清单

**A. 设计阶段**

* 是否确实需要 unsafe？有没有现成的安全 API？
* 所有权、生命周期、线程安全契约是否明确？
* 外部函数的真实 ABI 是否明确？
* 错误处理和资源释放规则是否明确？

**B. 实现阶段**

* 是否尽量缩小了 unsafe 块？
* 每个关键 unsafe 操作是否有具体的 SAFETY 注释？
* 是否避免在没有充分证明时使用 `transmute`？
* 是否避免为了方便而随意实现 `Send` / `Sync`？
* 是否避免把外部资源误包装成 Rust 拥有的内存？
* 是否考虑了 panic、回调、析构、重入等异常路径？

**C. FFI 专项**

* C 类型与 Rust 类型是否匹配？
* 结构体是否需要 `#[repr(C)]`？
* 可空指针是否正确处理？
* 字符串是否满足 NUL 终止约定？
* 输入指针是否可能被外部代码保存？
* 返回的指针由谁释放？
* 外部函数是否可能修改 Rust 借用的数据？
* C++ 异常与 Rust panic 是否可能跨越不允许展开的 ABI 边界？

**D. 验证阶段**

* 是否覆盖正常路径与错误路径？
* 是否测试空指针、零长度和边界长度？
* 是否验证重复释放和生命周期错误？
* 纯 Rust 的 unsafe 代码是否通过 Miri？
* C/C++ 边界是否做了真实集成测试？
* 是否考虑 Sanitizer 或 Fuzzing？

---

## 总结

把这一部分学扎实，最终要形成四种能力：

1. **读懂 unsafe 代码**：理解原始指针、型变、生命周期和别名规则。
2. **设计 FFI**：正确处理 ABI、内存布局、所有权与跨语言调用。
3. **构建安全抽象**：把底层操作包装成调用者不容易误用的 API。
4. **审计与验证**：明确安全契约，用测试工具与代码审查验证实现。

> 好的 unsafe 代码不是把 `unsafe` 写得更少就够了，而是让每一个无法由编译器证明的安全条件，都有明确的责任主体、清晰的契约和可审查的实现。
