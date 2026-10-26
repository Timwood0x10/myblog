+++
title = "Rust 未初始化内存与 MaybeUninit"
date = 2026-10-25
description = "分配内存不等于构造对象。从 MaybeUninit、ptr::write、部分初始化与 panic 安全出发，说明 Vec 的 len/capacity 为何必须分开，以及 FFI 缓冲区该怎样转成 Rust 值。"
weight = 7
[taxonomies]
tags = ["Rust", "Unsafe", "Memory", "MaybeUninit"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

核心问题只有一个：

> 如果我想先申请一块内存、稍后再把值写进去，Rust 如何保证这块内存不会被错误读取、重复析构或泄漏？

这个问题贯穿 `Vec<T>`、内存池、对象池、FFI、零拷贝与手动内存管理。

按以下顺序展开：

1. 什么是未初始化内存？为什么不能直接读？
2. `MaybeUninit<T>` 解决了什么问题？
3. `ptr::write()` 与普通赋值的区别？
4. 如何正确实现部分初始化的数组？
5. 初始化中途 panic 怎么办？
6. `Vec<T>` 为什么必须同时维护 `len` 与 `capacity`？
7. 这些知识如何用于 FFI？

参考资料：[Rustonomicon: Uninitialized Memory](https://doc.rust-lang.org/nomicon/uninitialized.html)。

---

## 一、什么是未初始化内存？

普通变量：

```rust
fn main() {
    let x: i32 = 42;
    println!("{x}");
}
```

状态很明确：分配了存储空间、空间里有一个合法的 `i32`、可以安全读取。

但如果先申请空间、之后再初始化：

```rust
// 伪代码：不是合法的 Rust
let x: i32;
println!("{x}");
```

Rust 会拒绝编译。这不只是编译器在限制你，背后有一个核心概念：

**内存中存在一些字节，不代表这些字节已经构成一个合法的 Rust 值。**

某些整数类型的任意位模式都是合法值，但并非所有类型如此：

```rust
let x: bool = true;
```

`bool` 只有两个合法表示（`false = 0`、`true = 1`），其他位模式不能作为合法 `bool` 使用。

```rust
let x: &i32 = &42;
```

引用更是如此：随便一组字节不能保证构成有效引用。

所以底层内存操作必须区分两种状态：

| 状态 | 含义 |
|---|---|
| 已分配内存 | 有一块可以存储数据的空间 |
| 已初始化的 `T` | 这块空间中存在一个合法的 `T` 值 |

### 1.1 一个底层场景

要分配能容纳 100 个 `u64` 的内存，逻辑上是两个阶段：

```text
内存分配
    ↓
┌────┬────┬────┬────┬────┬────┐
│ ?? │ ?? │ ?? │ ?? │ ?? │ ?? │ ... 100 个槽位
└────┴────┴────┴────┴────┴────┘
    ↓
逐个初始化
    ↓
┌────┬────┬────┬────┬────┬────┐
│ 10 │ 20 │ 30 │ 40 │ 50 │ 60 │ ...
└────┴────┴────┴────┴────┴────┘
```

第一阶段只需要内存，不需要已经构造好的 `u64`。这在 C/C++/Rust 的底层容器里都很常见。

Rust 的额外要求是：**一个位置在被初始化之前，不能当作有效的 `T` 来读取、传递或析构。**

这就引出了 `MaybeUninit<T>`。

---

## 二、`MaybeUninit<T>` 是什么

`MaybeUninit<T>` 表示：

> 这里可能存在一个有效的 `T`，也可能还没有初始化。

```rust
use std::mem::MaybeUninit;

fn main() {
    let mut slot: MaybeUninit<u32> = MaybeUninit::uninit();
    slot.write(42);
    let value = unsafe { slot.assume_init() };
    println!("{value}");
}
```

```text
MaybeUninit::uninit()
          │
          ▼
┌────────────────────┐
│ 未初始化的存储空间 │
└────────────────────┘
          │
          │ write(42)
          ▼
┌────────────────────┐
│ 有效的 u32 值：42  │
└────────────────────┘
          │
          │ assume_init()
          ▼
┌────────────────────┐
│ 普通的 u32：42     │
└────────────────────┘
```

注意 `MaybeUninit::uninit()` 本身是**安全**的：我们没有声称内存里已经存在有效的 `u32`。

需要 unsafe 的是 `assume_init()`：

```rust
use std::mem::MaybeUninit;

fn main() {
    let slot = MaybeUninit::<u32>::uninit();
    // 错误示范：不要这样做
    let value = unsafe { slot.assume_init() };
    println!("{value}");
}
```

因为编译器无法仅凭这次调用判断你是否真的完成了初始化。

`unsafe` 不会替你初始化内存，也不会检查内存里是否真的有合法 `u32`——它只是允许你执行一个需要由你证明安全的操作。

`assume_init()` 的含义不是「帮我初始化」，而是「**我保证**这里已经初始化好了」。

---

## 三、为什么不能直接用 T

需求：构造一个 4 元素数组，元素靠运行时计算得到。

```rust
fn calculate(index: usize) -> u64 {
    (index as u64 + 1) * 100
}

let values = [
    calculate(0),
    calculate(1),
    calculate(2),
    calculate(3),
];
```

这要求在构造数组时就能提供全部元素。如果数组很大、元素要逐个从外部接口取，或者想避免先造一批无用的默认值，就需要手动管理初始化过程。

典型场景：FFI 接口要求调用者提供缓冲区，由 C 函数填入数据——我们希望直接写进目标内存，而不是先造默认值再复制。

### 3.1 为什么不能用默认值

```rust
let mut values = [0u64; 100];
```

对 `u64` 通常没问题。但如果 `T` 是复杂对象：

```rust
struct ExpensiveObject {
    data: Vec<u8>,
}
```

为了创建 100 个对象，可能要先构造 100 个空 `Vec` 再逐个替换，产生额外的构造和析构开销。而且 `T` 甚至可能没有 `Default` 实现。

所以需要一种表示：**有存储空间，但还没有构造出 `T`**。这就是 `MaybeUninit<T>` 的核心用途。

优化是否值得取决于实际类型和场景，不能简单认为 `MaybeUninit` 一定更快。

---

## 四、ptr::write 与普通赋值的区别

普通赋值：

```rust
let mut x = String::from("hello");
x = String::from("world");
```

`x` 已经持有一个有效的 `String`，赋值时旧值需要被正确处理，否则它拥有的堆内存会泄漏。

但**如果目标内存尚未初始化，就不能把它当成已有的 `T` 来赋值**——普通赋值可能需要先处理目标位置上的旧值，而这对未初始化内存是不正确的。

`std::ptr::write(dst, value)` 会把 `value` 写入目标地址，**不会先读取或析构目标地址原先的内容**：

```rust
use std::mem::MaybeUninit;
use std::ptr;

fn main() {
    let mut slot = MaybeUninit::<String>::uninit();
    unsafe {
        ptr::write(
            slot.as_mut_ptr(),
            String::from("hello"),
        );
    }
    let value = unsafe { slot.assume_init() };
    println!("{value}");
}
```

* `slot.as_mut_ptr()` 拿到用于存储 `String` 的原始指针；
* `ptr::write(...)` 把一个新构造的 `String` 写入目标位置；
* `slot.assume_init()` 在你能证明已初始化时，把它转成普通的 `String`。

### 4.1 为什么不会析构旧值

因为它面向的核心场景就是「向尚未初始化的内存写入新值」。如果写入前先尝试析构旧值，就等于要求调用者先提供一个有效的旧对象，与需求冲突。

但反过来说：**如果目标位置原本已经持有有效值，`ptr::write` 也不会替你析构它。**

```rust
let mut value = String::from("old");
unsafe {
    std::ptr::write(
        &mut value,
        String::from("new"),
    );
}
```

这会覆盖原来的 `String`，但不会析构 `"old"`——旧值拥有的资源泄漏了。

因此：

* 目标位置未初始化：`ptr::write` 适合。
* 目标位置已有有效值：必须先考虑旧值的生命周期与资源释放。
* 不能确定目标状态：不要随意用原始指针写入。

一句话：`ptr::write` 负责写入，不负责管理旧对象的生命周期。

---

## 五、真正的难点：部分初始化

现在不是 1 个对象，而是 100 个：

```text
第 0 个元素：初始化成功
第 1 个元素：初始化成功
第 2 个元素：初始化成功
第 3 个元素：初始化失败
...
```

这时怎么办？这才是 `MaybeUninit<T>` 真正困难的地方。

```rust
struct RawBuffer<T, const N: usize> {
    slots: [MaybeUninit<T>; N],
    initialized: usize,
}
```

* `slots` 是存储空间；
* `initialized` 表示前多少个元素已经成功初始化。

若 `initialized = 3`：

```text
索引：     0        1        2        3        4
状态：   已初始化  已初始化  已初始化  未初始化  未初始化
```

这建立了一个关键不变量：

```text
0 ≤ initialized ≤ N
∀ i ∈ [0, initialized): slots[i] 已初始化
```

前 `initialized` 个元素全部有效，后面的可能没有初始化。

这个计数不是简单的辅助字段——**它决定了析构时哪些位置可以被当作有效的 `T`**。

### 5.1 为什么不能析构全部元素

```text
slots       = [有效 T, 有效 T, 有效 T, 未初始化, 未初始化]
initialized = 3
```

如果把 5 个槽位都当作 `T` 析构，后两个槽位并不包含有效 `T`，违反了 Rust 对有效值的要求。

正确清理逻辑：

```text
析构 slots[2]
析构 slots[1]
析构 slots[0]
```

只清理已经初始化的元素。如果析构顺序有依赖，还要认真设计顺序；真实实现还要处理析构函数自身 panic 的情况。

---

## 六、一个可运行的部分初始化示例

先不实现完整 `Vec<T>`，而是观察如何保证初始化状态正确：

```rust
use std::mem::MaybeUninit;

fn build_array() -> [u64; 4] {
    let mut slots: [MaybeUninit<u64>; 4] =
        [const { MaybeUninit::uninit() }; 4];

    for i in 0..4 {
        slots[i].write((i as u64 + 1) * 10);
    }

    // SAFETY: 上面的循环已经初始化了全部 4 个元素，
    // 且 u64 是 Copy 类型，按位读出后源位置不会被再次析构。
    unsafe {
        (&slots as *const _ as *const [u64; 4]).read()
    }
}

fn main() {
    println!("{:?}", build_array());
}
```

输出：

```text
[10, 20, 30, 40]
```

`[const { MaybeUninit::uninit() }; 4]` 是 inline const 语法（Rust 1.79 起稳定），用来给非 `Copy` 的 `MaybeUninit<T>` 批量初始化数组。

关于最后那次指针转换，有两点必须说清：

1. **它只在 `T: Copy` 时安全**。`read()` 是复制而非移动——对 `String` 这类拥有资源的类型，`slots` 里的值之后仍会被析构，导致双重释放。
2. 这种手工转换容易出错，不是首选写法。如果元素是逐个算出来的，用安全 API 更简单：

```rust
fn build_array() -> [u64; 4] {
    std::array::from_fn(|i| (i as u64 + 1) * 10)
}
```

`MaybeUninit::array_assume_init` 能做到同样的事，但它**至今仍是 nightly API**（`maybe_uninit_array_assume_init`），不能用于稳定 Rust。

重点不是记住某种转换写法，而是理解：**只有全部元素都有效时，才能把整个数组视为普通的 `[T; N]`。**

---

## 七、初始化中途 panic 怎么办

```rust
for i in 0..100 {
    slots[i].write(create_object(i));
}
```

假设 `create_object(57)` 发生 panic：

```text
索引 0~56：已初始化
索引 57~99：没有初始化
```

如果这些对象持有文件句柄、堆内存等资源，必须保证已初始化的对象得到清理，否则泄漏；但又不能析构整个数组，因为剩余元素没初始化。

所以底层实现必须维护初始化进度：

```rust
let mut initialized = 0;
for i in 0..N {
    let value = create_object(i);
    slots[i].write(value);
    initialized += 1;
}
```

顺序很重要：

1. 先成功构造对象。
2. 写入目标槽位。
3. 确认写入成功。
4. 更新已初始化数量。

如果第 57 个对象构造时 panic，计数仍是 57，清理代码就知道只有前 57 个元素可以被当作 `T` 处理。

但只有计数器还不够：还需要一个**清理机制**，例如一个持有 `slots` 与 `initialized` 的 guard，在栈展开时析构已初始化的元素。如果清理本身再次 panic，行为会更复杂。

这就是 `Vec<T>` 底层实现不是「分配内存、逐个写入」这么简单的原因——它必须处理部分初始化、资源释放、所有权转移和异常路径。

---

## 八、与 `Vec<T>` 的关系

概念上的结构：

```rust
struct VecLike<T> {
    ptr: *mut T,
    len: usize,
    capacity: usize,
}
```

（简化模型，不是标准库真实定义。）

| 字段 | 含义 |
|---|---|
| `ptr` | 指向元素存储空间 |
| `len` | 已经初始化、且属于本容器的元素数量 |
| `capacity` | 当前分配空间能容纳的元素数量 |

设 `capacity = 8`、`len = 3`：

```text
内存分配空间
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ T0 │ T1 │ T2 │ ?? │ ?? │ ?? │ ?? │ ?? │
└────┴────┴────┴────┴────┴────┴────┴────┘
  └─────────┘
     len = 3
  └───────────────────────────────────┘
                capacity = 8
```

* `len` 以内是已经初始化的有效值；
* `len` 到 `capacity` 之间属于分配区域，但不一定包含有效的 `T`。

所以 `len()` 不是「分配了多少内存」，而是「当前拥有多少个有效元素」；`capacity()` 才是「不重新分配还能再放几个」。

### 8.1 push 的核心过程

从 `len = 3`、`capacity = 8` 开始，容量足够时：

```text
1. 找到第 3 个元素的位置
             ↓
2. 将 value 写入该位置
             ↓
3. 确认新元素已初始化
             ↓
4. 将 len 从 3 更新为 4
```

**必须先写入、再增加 `len`。** 因为 `len` 是容器对外承诺的有效元素数量，先加 `len` 会让容器声称存在一个尚未初始化的元素，直接破坏不变量。

### 8.2 pop 的核心过程

```text
1. 检查 len 是否为 0
             ↓
2. 确定最后一个有效元素的位置
             ↓
3. 将该元素的所有权转移给调用者
             ↓
4. 将 len 从 4 更新为 3
```

关键在于：最后一个元素不能既由 `Vec<T>` 拥有、又由返回的 `value` 拥有。

```rust
struct Resource {
    data: String,
}
```

所有权转移正确时，`pop()` 返回的 `Resource` 由调用者负责析构，`Vec<T>` 不会再析构那个已移出的对象。

这也是 `ptr::read`、`ptr::write` 和 `MaybeUninit<T>` 必须放在**所有权语义**里一起理解的原因。

---

## 九、Drop 与 MaybeUninit 的结合

持有原始分配内存的容器，析构逻辑不能写成：

```rust
// 错误示意：不能这样实现真实容器
unsafe {
    drop_all_elements_in_allocation();
}
```

因为整个分配区域里可能只有一部分元素已初始化。

正确的清理过程：

```text
读取 len
   ↓
析构已初始化的元素
   ↓
释放底层分配
```

最关键的一条：**析构的元素数量应等于实际初始化且由容器拥有的元素数量，而不是容量。**

这也说明了 `MaybeUninit<T>` 与 Drop Check 的关系：

* `MaybeUninit<T>` 用来表达某个位置尚未构造出 `T`；
* 初始化状态记录哪些位置已经拥有有效的 `T`；
* `Drop` 只能处理真正有效且由当前容器拥有的对象；
* `PhantomData<T>` 可以进一步表达容器与 `T` 在类型系统层面的关系。

---

## 十、应用到 FFI：C 分配的内存能直接当 Rust 对象吗

```c
void fill_buffer(uint32_t *buffer, size_t len);
```

```rust
unsafe extern "C" {
    fn fill_buffer(buffer: *mut u32, len: usize);
}
```

分配一段缓冲区交给 C 写入时，必须区分三个问题。

**问题一：内存是否已经分配？**

有存储空间，不代表其中有有效的 `u32` 值。

**问题二：C 函数是否真的初始化了所有元素？**

如果 C 只写了前 10 个，其余位置不能自动视为已初始化。

**问题三：C 函数的行为是否符合约定？**

* 是否会写出缓冲区边界？
* 是否真的初始化了约定数量的元素？
* 是否会保留指针、在函数返回后继续使用？
* 是否会在其他线程访问缓冲区？

这些都属于 FFI 安全契约。Rust 编译器不能自动证明外部 C 函数遵守了约定。

因此，安全的 FFI 封装必须先明确约束 C 函数的行为，再**根据它实际完成的初始化范围**，把内存转成 Rust 可以安全使用的值。

不能仅因为 C 函数返回成功，就假定所有内存都已正确初始化——这一点必须由具体接口的契约保证。

---

## 十一、可用于跨语言分析的维度

从内存安全分析器的角度看，`MaybeUninit<T>` 涉及的问题可以归纳为几个可分析维度：

| 分析维度 | 需要判断的问题 |
|---|---|
| 初始化状态 | 某个内存位置是否已被写入有效值？ |
| 初始化范围 | 数组或缓冲区中究竟哪些元素有效？ |
| 所有权 | 当前代码是否拥有这些对象的析构责任？ |
| 所有权转移 | 对象被移出后，旧容器是否还会析构它？ |
| 析构正确性 | 是否可能析构未初始化的内存？ |
| 异常安全 | 部分初始化失败后，已构造对象是否得到清理？ |
| FFI 契约 | 外部函数是否初始化了约定的内存区域？ |

要区分两种能力：

* **静态分析能直接验证的事实**：某条控制流路径上，初始化计数是否可能小于 `len`；某分支是否可能在初始化之前读取目标位置。
* **需要建模的外部契约**：C 函数是否真的写入了全部元素。仅凭 Rust 调用点的类型信息通常无法证明，需要分析外部实现、可信注解或接口契约。

这也与 Ownership Tracking、Memory Graph 和 FFI 边界分析直接相关。

但要注意：不能把所有初始化问题都归结为「变量有没有赋值」。对 Rust 来说，**有效值、对象所有权、初始化范围、析构责任**是相互关联但不同的概念。

---

## 十二、必须记住的六条

1. **分配内存不等于初始化对象。** 一段内存可以存在，但尚未构造出有效的 `T`。
2. **`MaybeUninit<T>` 表达可能尚未初始化的存储空间。** 它允许延迟构造对象，但不会自动管理初始化进度。
3. **`assume_init()` 是一条安全边界。** 调用者必须保证目标位置已包含有效 `T`。
4. **`ptr::write()` 不析构目标位置的旧值。** 它适合向未初始化内存写入；若覆盖已有对象，调用者必须自行处理旧值。
5. **`len` 与 `capacity` 语义不同。** `len` 是有效元素数量，`capacity` 是可容纳元素数量。
6. **部分初始化必须有明确的清理策略。** 构造中途失败时，必须知道哪些对象已构造完成、哪些需要析构。

---

## 下一节：Unwinding、异常安全与原始内存管理

接下来最值得深入的三件事：

1. Rust 的 panic 为什么会影响底层容器的正确性？
2. 如何用初始化计数器与 guard，保证部分初始化失败时资源不泄漏？
3. `ptr::read`、`ptr::write`、`set_len` 与所有权转移之间是什么关系？

这部分学透，才能系统理解 `Vec<T>` 的底层操作，而不只是记住几个 unsafe API 的用法。
