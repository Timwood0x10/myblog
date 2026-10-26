+++
title = "Rust panic 展开、异常安全与原始内存"
date = 2026-10-25
description = "程序执行到一半 panic 时，已经申请的内存、已构造的对象、还没初始化的空间分别该怎么处理？这篇从栈展开讲到 guard、ptr::read/write 与 set_len。"
weight = 8
[taxonomies]
tags = ["Rust", "Unsafe", "Panic", "Memory"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

我最初读 Rustonomicon 的 Exception Safety 那一章，觉得没什么难的：panic 就 panic，Rust 会自动清理。直到自己动手写一个简化版 `Vec`，才发现 `push` 里一个赋值顺序就能把整个容器搞成未定义行为。

这篇就围绕一个问题展开：

> 程序执行到一半突然 panic，已经申请的内存、已经构造的对象、还没初始化的空间，分别该怎么处理？

参考：[Rustonomicon: Exception Safety](https://doc.rust-lang.org/nomicon/exception-safety.html)、[Uninitialized Memory](https://doc.rust-lang.org/nomicon/uninitialized.html)。

先把两条 panic 策略的差别摆出来，后面所有讨论都建立在这个前提上：

| | `panic = "unwind"`（默认） | `panic = "abort"` |
|---|---|---|
| 发生 panic 时 | 栈展开，逐层执行 `Drop` | 直接 abort 进程 |
| 资源清理 | 离开作用域的局部变量会被析构 | 不保证任何析构执行 |
| 能否 `catch_unwind` | 可以捕获 | 能编译，但捕获不到（进程直接终止） |
| 编译产物大小 | 略大（需要展开信息） | 更小 |
| 性能 | 正常路径几乎无差异 | 正常路径几乎无差异，异常路径更快（不展开） |
| 典型场景 | 需要 `catch_unwind` 隔离故障 | 嵌入式、CLI、追求最小产物 |
| 展开期间再次 panic | 进程 abort | 不适用 |

我在下面的分析默认按 `unwind` 走——因为只有它会触发「析构顺序」「部分初始化清理」这些问题。切到 `abort` 之后，panic 就是进程终结，容器是否处于一致状态已经不重要了。

---

## 一、Unwinding 到底是什么

先看一段很普通的代码：

```rust
struct Resource {
    name: &'static str,
}

impl Drop for Resource {
    fn drop(&mut self) {
        println!("drop {}", self.name);
    }
}

fn main() {
    let a = Resource { name: "A" };
    let b = Resource { name: "B" };
    println!("before panic");
    panic!("something went wrong");
}
```

用默认的 `panic = "unwind"` 配置时，panic 会触发**栈展开**：

```text
main()
  │
  ├── 创建 a
  │
  ├── 创建 b
  │
  ├── println!
  │
  └── panic!
         │
         ▼
     开始栈展开
         │
         ▼
     离开当前作用域
         │
         ├── drop b
         │
         └── drop a
```

我在本机跑出来的输出是：

```text
before panic
thread 'main' panicked at src/main.rs:9:5:
something went wrong
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
drop B
drop A
```

这里有个容易记错的顺序：**`drop B` / `drop A` 出现在 panic 消息之后**。因为 panic 消息是 panic hook 先打印的，打印完才开始栈展开、逐个执行 drop。同一个线程里这两件事是顺序发生的。

关键在于：**栈展开过程中，Rust 会清理离开作用域时需要析构的局部变量**，而且是逆序（先 `b` 后 `a`）。

这让资源管理变得可靠。比如：

```rust
use std::fs::File;

fn process() {
    let file = File::open("data.txt").unwrap();
    // 后续代码即使 panic，
    // 在正常的栈展开路径上，file 也会被清理
}
```

文件句柄由拥有它的对象管理，不用在每个错误分支手动关闭。这就是 RAII 在 Rust 里的价值。

但有三个限制必须记住：

* `panic = "abort"` 时直接终止进程，没有常规栈展开。
* 进程被强杀、崩溃，或遇到无法正常展开的情况，不能指望所有 `Drop` 都执行。
* `Drop` 实现本身再次 panic，行为会变得复杂，甚至直接终止进程。

所以「析构一定会执行」不能当成无条件前提。

---

## 二、panic 为什么让底层容器变复杂

先看普通的 `String`：

```rust
let value = String::from("hello");
```

```text
栈
┌─────────────────┐
│ String          │
│ ptr ────────────────┐
│ len = 5         │   │
│ capacity = 5    │   │
└─────────────────┘   │
                      ▼
堆              ┌───────────────┐
                │ hello         │
                └───────────────┘
```

它被正确析构时会释放自己拥有的堆内存。

但我自己实现容器时：

```rust
struct MyVec<T> {
    ptr: *mut T,
    len: usize,
    capacity: usize,
}
```

所有权关系得自己维护：

* `ptr` 指向一段分配空间；
* `len` 是已经初始化的元素数量；
* `capacity` 是总容量。

如果 `push()` 中途 panic，我必须保证容器没有进入一个「无法正确析构」的状态。这就是异常安全的核心。

### 2.1 一个错误的实现思路

假设容器当前 `len = 3`、`capacity = 8`，准备加第 4 个元素。一种想当然的写法：

```rust
// 仅为错误示意，不能用于真实容器
self.len += 1;
let value = create_value(); // 这里可能 panic
unsafe {
    self.ptr.add(3).write(value);
}
```

问题在哪？

`self.len += 1` 之后，容器已经声称自己拥有 4 个有效元素。但如果 `create_value()` panic，第 4 个元素根本没写进去：

```text
实际状态：[有效 T, 有效 T, 有效 T, 未初始化]
容器记录：len = 4
```

容器析构时按 `len` 去析构前 4 个元素，就会去析构一块没初始化的内存。

正确顺序只有一种：

```rust
let value = create_value(); // 如果 panic，len 仍为 3
unsafe {
    self.ptr.add(self.len).write(value);
}
self.len += 1;
```

这个例子还是伪代码，完整的容器还要处理容量检查、指针有效性、对齐等。但它揭示了一条原则：

> **容器的内部状态必须准确反映已经完成的初始化和所有权转移，不能提前承诺尚未完成的操作。**

---

## 三、异常安全的三个层次

这套分类来自 C++，但用来分析 Rust 的 panic 一样好用。

### 3.1 第一层：不产生未定义行为

最基本的要求。无论操作成功与否，都不能因为异常路径破坏内存安全。

```rust
let mut values = Vec::<String>::new();
```

假设某个操作中途失败，容器仍然不能：

* 读取未初始化的 `String`；
* 对同一个对象重复析构；
* 使用已经释放的内存；
* 通过悬垂指针访问对象。

这里要强调一句：**内存泄漏不一定构成未定义行为**。程序可能因为错误路径没释放某个分配，这是资源管理问题，和对无效内存执行操作不是一回事。

### 3.2 第二层：基本保证

操作失败后，对象仍处于一个有效、可安全析构的状态，但逻辑状态可能已经变了。

```text
操作前：[A, B, C]
操作后：[A, B, C]
```

这是比较理想的结果。但基本保证实际只要求：对象仍然满足自己的不变量，能安全继续使用或析构——不要求业务状态完全回到原样。

### 3.3 第三层：强保证

强保证的意思是：操作失败就像从没发生过。

```text
操作前：[A, B, C]
尝试追加 D
发生失败
操作后：[A, B, C]
```

如果一次操作要重新分配内存、构造多个元素、或执行多个相互依赖的步骤，做到强保证就很困难。常见策略是：

1. 在临时空间完成可能失败的工作；
2. 确认成功；
3. 最后再提交状态变更。

这类似事务里的 commit。

不过不是所有操作都值得追求强保证。对底层容器来说，先保住内存安全和内部状态有效，再按 API 需求决定要不要更强的保证，通常更实际。

---

## 四、Guard：处理部分初始化的关键机制

这是底层编程里我用了最多的一种模式。

Guard 本身是个普通 Rust 对象，只是它的 `Drop` 负责在操作失败时清理资源。先看一个不碰指针的版本：

```rust
struct Guard {
    committed: bool,
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.committed {
            println!("operation did not commit");
        }
    }
}

fn operation() {
    let mut guard = Guard { committed: false };
    println!("working");
    // 所有工作成功，提交状态
    guard.committed = true;
}
```

如果 `operation()` 在提交前 panic，栈展开会让 `guard` 析构，它发现 `committed == false`，就执行清理。

真实实现当然不能让 guard 只打印一句话——它得真的持有待清理的资源或初始化状态。

### 4.1 把 Guard 用在部分初始化上

概念上的结构是这样：

```text
InitGuard<T>
├── ptr         → 目标存储空间
├── initialized → 已成功构造的元素数量
└── capacity    → 可用槽位数量
```

正常初始化时：

```text
initialized = 0
写入第 0 个元素 → initialized = 1
写入第 1 个元素 → initialized = 2
写入第 2 个元素 → initialized = 3
```

如果第 3 个元素构造失败，guard 记录的仍是 3，它就只清理前 3 个。

写成代码（`capacity` 这一段暂用不到，先省掉）：

```rust
use std::ptr;

struct InitGuard<T> {
    ptr: *mut T,
    initialized: usize,
}

impl<T> Drop for InitGuard<T> {
    fn drop(&mut self) {
        unsafe {
            for i in (0..self.initialized).rev() {
                ptr::drop_in_place(self.ptr.add(i));
            }
        }
    }
}
```

这段只展示清理逻辑，离生产可用还差得远。调用它之前必须保证：

1. `ptr` 指向足够大、正确对齐的存储空间；
2. `[0, initialized)` 内元素全部已初始化；
3. 这些元素确实由 guard 负责析构；
4. 每个元素只被析构一次；
5. 对应分配在清理完成前仍然有效；
6. 没有其他所有者同时析构同一批元素。

它也没处理 Drop 期间再次 panic 的情况，也没负责释放底层分配。

### 4.2 为什么要倒序析构

```rust
for i in (0..self.initialized).rev()
```

从最后一个已初始化元素开始往前清。

对于按顺序构造的元素，逆序析构是自然的选择——后构造的对象可能依赖先构造的对象。不过具体容器该不该采用某种顺序，要看它自己的语义和契约，不能一概而论。

---

## 五、Guard 与所有权转移：最容易出错的地方

上面那个 guard 会在 Drop 里析构已初始化的对象。但如果元素已经全部构造成功，现在要把它们交给另一个容器呢？

```text
Guard 持有清理责任
          │
          ▼
   [A, B, C, D]

我们把这批对象交给目标容器：

目标容器拥有清理责任
          │
          ▼
   [A, B, C, D]
```

如果 guard 仍然认为自己拥有这些元素，那就变成两个所有者 → 重复析构。

所以成功提交后，必须让 guard 停止清理已经转移出去的对象。常见设计是在刚才的结构上再加一个 `armed: bool`：

* 提交前 `armed = true`，表示 guard 负责清理；
* 成功转移所有权后 `armed = false`，表示 guard 放手。

```rust
impl<T> Drop for InitGuard<T> {
    fn drop(&mut self) {
        if self.armed {
            // 清理 guard 仍然拥有的对象
        }
    }
}
```

这仍是概念设计。实际实现还要保证转移操作本身的失败语义正确，并且目标容器只有在确实拿到所有权之后才把自己标记为所有者。

`armed` 这个字段叫什么不重要，重要的是：**任何时刻都必须明确到底由谁负责析构。**

---

## 六、三个底层操作：ptr::read、ptr::write、set_len

这三个经常一起出现，但职责完全不同。

### 6.1 ptr::write：在指定位置写入值

```rust
let mut slot = std::mem::MaybeUninit::<String>::uninit();
unsafe {
    slot.as_mut_ptr().write(String::from("hello"));
}
```

它把一个值写入目标内存，**不会先析构目标位置原来的内容**，也不会维护 `len`，不会记录所有权转移。写入条件得你自己保证。

### 6.2 ptr::read：按值读取

```rust
let value = String::from("hello");
let ptr = &value as *const String;
let moved_value = unsafe { ptr.read() };
```

这段要格外小心。

`ptr::read()` 从指针位置读出一个 `T` 并按值返回。对 `String` 这种拥有资源的类型，这意味着现在有两份描述同一块资源的句柄——但原来的 `value` 还在。

如果之后让 `value` 正常析构，就是重复释放。

所以上面这段是**刻意展示的危险操作**，不能当作正确的所有权转移来用。

对 `Copy` 类型没这个问题；对拥有资源的非 `Copy` 类型，必须明确处理源位置的所有权状态。

更符合转移语义的写法是让源槽位变成 `MaybeUninit`：

```rust
use std::mem::MaybeUninit;

fn main() {
    let mut slot = MaybeUninit::new(String::from("hello"));
    let value = unsafe { slot.assume_init_read() };
    println!("{value}");
}
```

`assume_init_read()` 从已初始化的槽位读出值，不会析构源槽位里的对象。因为 `slot` 是 `MaybeUninit<String>`，它析构时本来也不会去析构内部的 `String`——清理责任就交给了返回的 `value`。

这也说明 `MaybeUninit<T>` 不只用于延迟初始化，还能精确控制对象生命周期。

### 6.3 set_len：修改「有效元素数量」的记录

```rust
unsafe {
    vec.set_len(new_len);
}
```

它不初始化元素，不移动数据，只是改容器记录的长度。

调用者要保证：

* 新长度不超过容量；
* 新长度范围内每个元素都已初始化；
* 容器能合法拥有这些元素并在以后正确处理。

所以这是错误示范：

```rust
let mut vec: Vec<String> = Vec::with_capacity(10);
unsafe {
    vec.set_len(10);
}
```

分配了够放 10 个 `String` 的空间，但这些位置没有被初始化。`set_len(10)` 不会凭空构造 10 个 `String`，它只是告诉 `Vec`「你现在拥有 10 个有效元素」——而这个声明是假的。

后面容器一访问或析构，就是未定义行为。

记住：`set_len()` 改的是记录，不是内存。

---

## 七、用这三个操作拼出 push

假设 `len = 3`、`capacity = 8`，要加一个 `String`：

```text
创建新 String
      │
      ▼
ptr::write 写入第 3 个槽位
      │
      ▼
确认元素已初始化
      │
      ▼
更新 len = 4
```

用原始指针写大概是：

```rust
// 仅为解释核心机制的伪代码，不是完整 Vec 实现
let value = String::from("new");
unsafe {
    ptr.add(len).write(value);
    // 只有在写入成功、且新元素确实有效后，
    // 才能更新容器记录的长度
    len += 1;
}
```

真实的 `Vec` 还要处理：容量不足时重新分配、内存布局与对齐、分配失败、指针有效性、与借用检查的配合、初始化中途失败的清理、零大小类型等特殊情况。

但原理上它已经解释了为什么 `Vec` 必须区分「分配空间」和「已初始化元素」。

---

## 八、set_len 最典型的使用场景：FFI 缓冲区

假设 C 函数负责把数据写进 Rust 提供的缓冲区：

```c
int read_data(uint8_t *buffer, size_t capacity, size_t *written);
```

* `buffer` 是目标缓冲区；
* `capacity` 是容量；
* `written` 返回实际写入的字节数。

`Vec::with_capacity(capacity)` 只保证容量，**不意味着 `Vec` 已经有 `capacity` 个初始化元素**。所以不能直接把 `len` 设成 `capacity` 然后让 C 去写。

一种简单且安全的做法是先造出有效长度：

```rust
fn read_from_c(capacity: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; capacity];
    // 调用 FFI，让 C 在 buffer 的有效元素范围内写入
    // 实际调用要根据接口契约处理错误和 written
    buffer
}
```

代价是先把缓冲区清零。

如果确实要省掉这一步，就得用 `MaybeUninit<u8>` 或原始分配空间，并且严格按这个顺序：

```text
分配足够容量
      │
      ▼
外部函数写入数据
      │
      ▼
验证外部函数实际初始化的字节数
      │
      ▼
确认 written <= capacity
      │
      ▼
最后才把 len 设为 written
```

这里有个关键细节：`written <= capacity` 只证明长度没越界，**不能证明 C 真的初始化了这些字节**。如果 C 的契约不保证它初始化前 `written` 个字节，Rust 侧就不能仅凭这个数字设置长度。

这就是 FFI 里「类型信息」和「外部契约」的区别。

---

## 九、如果析构函数自己 panic 呢

```rust
struct Item {
    id: usize,
}

impl Drop for Item {
    fn drop(&mut self) {
        if self.id == 2 {
            panic!("drop failed");
        }
    }
}
```

假设容器逆序清理：

```text
Item 4
Item 3
Item 2  ← panic
Item 1
Item 0
```

`Item 2` 的析构 panic 后，后续清理流程就被打断了。

更糟的是，如果此时程序本来就在另一次 panic 的栈展开过程中，再次 panic 会导致进程直接 abort。所以「double panic」不是能被 catch 住的普通错误。

要点：

* `Drop` 接口本身没承诺析构函数绝不 panic；
* `panic = "abort"` 下程序直接终止；
* 栈展开期间再次 panic，进程会终止；
* 复杂的清理逻辑必须明确自己的异常行为。

实践上，析构函数应该尽量简单可靠，别在里面做容易失败的复杂业务。自定义容器如果要考虑「析构一个元素就中断后续清理」这种情况，就得明确设计是否接受、要不要额外的恢复策略。

---

## 十、把机制串成一张图

```text
            MaybeUninit<T>
                  │
                  │ 表达存储空间可能未初始化
                  ▼
              初始化元素
                  │
                  │ ptr::write()
                  ▼
              有效的 T 对象
                  │
                  │ 记录初始化状态
                  ▼
               len / guard
                  │
                  │ 正确转移所有权
                  ▼
              容器接管对象
                  │
                  │ 正常析构或栈展开
                  ▼
                Drop<T>
                  │
                  ▼
                释放资源
```

`ptr::read()` 是另一条与所有权转移有关的路径：

```text
已初始化的 T
     │
     │ ptr::read()
     ▼
返回一个按值读取的 T
```

它不会改变源位置的状态，也不会更新 `len`。所以调用者必须保证不会出现两个所有者都认为自己拥有同一个非 `Copy` 对象。

`set_len()` 则是：

```text
已有初始化事实
       │
       ▼
更新容器对有效元素数量的记录
```

它不构造对象，也不验证外部函数是否守约。

---

## 十一、我从这节里提炼的四个不变量

写到这里，我把这一节的内容压成四类可以拿去做代码审查的不变量。

**1. 初始化不变量**

任何控制流路径上，容器声明为有效的元素都必须真的初始化了。

```text
0 ≤ len ≤ capacity
并且 [0, len) 中的元素都有效
```

只检查 `len <= capacity` 不够，它证明不了元素确实初始化过。

**2. 所有权不变量**

每个需要析构的对象，都必须有明确的析构责任归属。重点看：

* `ptr::read()` 之后源位置的状态；
* 对象移出容器之后的清理责任；
* guard 提交之后是否仍会析构对象；
* FFI 返回的对象到底由谁释放。

**3. 分配不变量**

容器必须知道：哪个指针对应哪次分配、布局是什么、分配是否仍有效、释放时用的布局是否匹配、有没有重复释放。

**4. 异常路径不变量**

除了正常控制流，还要看：初始化中途 panic、重新分配失败、guard 在栈展开期间执行、析构函数自身 panic、外部 FFI 函数返回错误或违约。

这也是原始内存分析和普通语法级检查的分界：不能只看每条指令「看起来安不安全」，还得看不同控制流路径怎么改变对象的初始化状态和所有权状态。

---

## 十二、小结

五句话说完这节：

1. Unwinding 是 panic 时的栈展开机制，正常情况下会清理离开作用域的局部变量。
2. 异常安全要求失败路径也不能破坏内存安全和内部不变量。
3. Guard 能把部分初始化的清理责任绑定到对象生命周期上。
4. `ptr::read()` 和 `ptr::write()` 只做底层内存操作，不管理容器状态。
5. `set_len()` 只改长度记录，调用者必须保证范围内元素已初始化。

我后来给自己留了三道题，都是拿来检验有没有真懂的：

**题一**

```rust
let mut vec: Vec<String> = Vec::with_capacity(10);
unsafe {
    vec.set_len(5);
}
```

为什么这段不安全？如果 `String` 换成 `u8`，结论会不会变？

**题二**

用 `ptr::write()` 把一个 `String` 写进原始内存，但还没加 `len`，此时后续操作 panic，谁负责析构这个 `String`？

**题三**

用 `ptr::read()` 从容器取出一个 `String`，但忘了减 `len`，容器析构时会发生什么？

三题分别对应：未初始化内存、部分初始化的清理责任、所有权转移与重复析构。

---

下一篇我会写 `Vec<T>` 的真实内存布局与扩容机制：RawVec、分配布局、重新分配、元素移动，以及零大小类型为什么让指针运算变得特殊。
