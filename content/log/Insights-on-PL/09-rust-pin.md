+++
title = "Rust Pin：地址稳定性到底在保证什么"
date = 2026-10-25
description = "Pin 不是把内存锁住。它是一套类型系统约定，保证某些值在被固定期间不会被移动出原位置——这是自引用结构体和 async Future 能成立的前提。"
weight = 10
[taxonomies]
tags = ["Rust", "Pin", "Unsafe", "Async"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

我一开始对 `Pin` 的理解是错的。我以为它会把内存锁住，后来发现它连「禁止移动」都不完全成立——`Pin<Box<T>>` 这个变量本身照样可以搬来搬去。

真正的结论只有一句：

> **Pin 不是锁内存，也不是禁止所有移动。它是一套类型系统约定，用来保证某些值在被固定期间不会被移动出原来的内存位置。**

为什么需要这种保证？得从 Rust 的普通移动语义说起。

---

## 一、Rust 的「移动」到底做了什么

```rust
struct User {
    name: String,
    age: u32,
}

fn main() {
    let a = User {
        name: String::from("Alice"),
        age: 18,
    };
    let b = a;
    println!("{}", b.name);
}
```

执行 `let b = a;` 之后，`a` 的所有权转移给 `b`，`a` 不能再用了。

但这里有个关键问题：

> 移动一个 Rust 值，是不是意味着它拥有的堆内存也被搬走了？

不是。`String` 大致长这样：

```text
String 对象
┌─────────────────┐
│ ptr             │ ────────┐
│ len             │         │
│ capacity        │         │
└─────────────────┘         │
                            ▼
                       堆内存
                    ┌─────────────┐
                    │ Alice       │
                    └─────────────┘
```

移动时 Rust 只需搬走那三个字的头，字符本身原地不动。

但如果结构体里有个指针指向**自己**，事情就不一样了。

### 1.1 自引用结构体的问题

```rust
struct SelfRef {
    data: String,
    ptr: *const String,
}
```

我想让 `ptr` 指向结构体自己的 `data` 字段：

```text
SelfRef 位于地址 A
┌──────────────────────────┐
│ data: String             │
│                          │
│ ptr ─────────────────────┼──┐
└──────────────────────────┘  │
                              │
                              ▼
                         data 字段
```

如果结构体被移到地址 B，而 `ptr` 还指着地址 A：

```text
原地址 A                   新地址 B
┌───────────────┐          ┌───────────────┐
│ 旧对象的内存  │          │ 新对象        │
│               │          │ data          │
│ ptr ──────────┼──────┐   │               │
└───────────────┘      │   └───────────────┘
                       │
                       ▼
                  原地址 A
```

原地址上的对象一旦失效，`ptr` 就变成悬垂指针。

注意这里有两个细节：

* 不是所有自引用结构体都会因为移动出错——关键在于内部引用是否依赖外层对象的固定地址。
* 上面这个 `SelfRef` 只是展示问题的骨架，它并没有真的建立自引用关系（`ptr` 还是空指针）。

---

## 二、为什么 &mut T 不够

既然有借用检查器，为什么还非要 `Pin`？

因为借用检查器管的是**生命周期和别名**，它并不会阻止值被搬到新地址。`let b = a;` 这种移动完全合法。

而自引用对象需要的是另一层保证：

> 对象被固定之后，在特定期间内，不能通过安全操作把它移动到别的内存位置。

这叫**地址稳定性**。

有些类型不在乎自己住哪：`u64`、`String`、`Vec<u8>` 都可以随便搬。另一些类型则依赖地址：

* 包含指向自身字段的原始指针的结构体；
* 某些底层异步状态机；
* 依赖固定地址的 FFI 对象；
* 侵入式链表节点；
* 保存指向自身内部数据的回调注册信息。

具体的冲突点在这里：

```rust
struct Data {
    value: String,
}

let mut data = Data { value: String::from("hello") };
let r: &mut Data = &mut data;

r.value.push_str(" world");   // 改字段，没问题
*r = Data { value: String::from("new") };  // 替换整个对象
```

两种操作都合法。但一旦 `Data` 内部有指向自身的指针，第二种操作就可能让内部指针失效。

所以需要一种更强的引用：`Pin<&mut Data>`。它的意思不是「我有一个可变引用」，而是：

> 我有一个指向**已固定对象**的可变引用，并且在固定约定生效期间，不能通过安全操作把这个对象移出它的固定位置。

关键字是「移出对象」，不是「禁止修改对象」。固定住的对象照样可以有可变状态。

顺带说一句：Pin 不是实现地址稳定的唯一办法。你也可以把对象放在永不移动的堆分配里，并且不暴露会破坏不变量的接口。Pin 的价值在于**能把这类约定写进类型系统**。

---

## 三、Pin 到底是什么

```rust
use std::pin::Pin;
```

泛型参数 `P` 通常是指针类型：

```rust
Pin<Box<T>>
Pin<&mut T>
Pin<Arc<T>>
```

| 类型 | 含义 |
|---|---|
| `Box<T>` | 拥有堆上 `T` 的所有权 |
| `Pin<Box<T>>` | 通过 `Box` 拥有一个被固定的 `T` |
| `&mut T` | 对 `T` 的独占可变借用 |
| `Pin<&mut T>` | 对一个被固定的 `T` 的独占可变借用 |

最重要的一句话：

> **Pin 固定的是指针所指向的值，不是指针对象自身的地址。**

```rust
let value = Box::pin(42);
```

```text
栈
┌─────────────────┐
│ Pin<Box<i32>>   │
└────────┬────────┘
         │
         ▼
堆
┌─────────────────┐
│ i32 = 42        │
└─────────────────┘
```

`Pin<Box<i32>>` 通过 `Box` 指向堆上的整数。栈上那个 `Pin<Box<i32>>` 变量随便搬，堆上的 `i32` 不动。

但这里还有个坑：`i32` 是 `Unpin` 的，所以 `Pin<Box<i32>>` 并不会真的阻止你通过合法途径把它取出来。这就引出了 `Unpin`。

---

## 四、Unpin：什么时候不需要固定

```rust
pub auto trait Unpin {}
```

`Unpin` 是个 auto trait，含义很简单：

> `T: Unpin` 表示这个类型不依赖 Pin 提供的固定地址保证。

绝大多数普通类型都是 `Unpin`：

```rust
fn assert_unpin<T: Unpin>() {}

fn main() {
    assert_unpin::<u32>();
    assert_unpin::<String>();
    assert_unpin::<Vec<u8>>();
}
```

这些类型随便移动都没问题，Pin 对它们而言形同虚设。

反过来，需要地址稳定的类型可以用 `PhantomPinned` 阻止自动实现 `Unpin`：

```rust
use std::marker::PhantomPinned;

struct SelfRef {
    data: String,
    ptr: *const String,
    _pin: PhantomPinned,
}
```

`PhantomPinned` 是零大小标记类型，但作用和 `PhantomData<T>` 完全不同：

* `PhantomData<T>` 表达所有权、生命周期、型变这些类型系统关系；
* `PhantomPinned` 只做一件事——阻止类型自动实现 `Unpin`。

**`PhantomPinned` 本身不会把对象固定在任何地址。** 它只改变类型的 `Unpin` 属性。

```rust
let value = SelfRef {
    data: String::from("hello"),
    ptr: std::ptr::null(),
    _pin: PhantomPinned,
};
```

这个对象仍然可以自由移动，因为还没有任何 `Pin` 参与。

两个机制要分清：

```text
PhantomPinned
    │
    └── 阻止类型自动实现 Unpin

Pin<P>
    │
    └── 在安全约定成立时，固定指针指向的值
```

---

## 五、`Pin<Box<T>>` 与 `Pin<&mut T>`

### 5.1 Pin::new 与 Box::pin

这两个 API 经常被搞混。

```rust
use std::pin::Pin;

let mut value = 42;
let pinned = Pin::new(&mut value);   // Pin<&mut i32>
```

`Pin::new` **不分配内存**，它只是把现有引用包一层。标准库要求传入的指针目标必须 `Unpin`——因为只有这样，包装才不需要额外的保证。

```rust
let value = Box::pin(42);            // Pin<Box<i32>>
```

`Box::pin` 会把值放到堆上再固定。对 `!Unpin` 类型，这是最常见的固定方式。

但固定不是单纯由「在堆上」决定的。普通 `Box<T>` 也能搬所有权、也能在满足规则时把 `T` 取出来；`Pin<Box<T>>` 对 `!Unpin` 类型施加的约束要强得多。

区别不只是堆分配，而是类型系统表达的契约。

### 5.2 移动的是指针所有者

```rust
let future1 = Box::pin(some_future());
let future2 = future1;
```

```text
栈上的指针对象
┌──────────────────┐
│ Pin<Box<Future>> │
└────────┬─────────┘
         │
         ▼
堆上的 Future
┌──────────────────┐
│ Future 状态机    │
└──────────────────┘
```

移动 `Pin<Box<Future>>` 只是换了个变量持有这个指针，堆上的 Future 一动没动。

这也解释了为什么堆分配总跟 Pin 一起出现：**搬指针所有者，不等于搬被指向的对象。**

---

## 六、get_mut 与 get_unchecked_mut

### 6.1 get_mut 为什么要求 Unpin

```rust
pub fn get_mut(self) -> &mut T
where
    T: Unpin,
```

为什么有这个约束？因为普通 `&mut T` 允许你替换整个对象：

```rust
*value = another_value;
```

如果 `T` 依赖固定地址，这个操作就可能毁掉内部自引用。

我实测过：给一个含 `PhantomPinned` 的类型调 `get_mut()`，编译器直接拒绝。

```text
error[E0277]: `PhantomPinned` cannot be unpinned
```

所以标准库用 `Unpin` 把情况分成两类：

* `T: Unpin`：可以安全地拿普通可变引用；
* `T: !Unpin`：安全 API 不给你这个引用。

这是编译期约束，不是运行时检查。

### 6.2 get_unchecked_mut 为什么是 unsafe

```rust
pub unsafe fn get_unchecked_mut(self) -> &mut T
```

它不要求 `Unpin`，代价是**你得自己保证**后续操作不会破坏固定地址约定。

危险在哪？拿到 `&mut T` 之后，这两件事都可能发生：

```rust
*value = another_value;
let moved = std::mem::replace(value, another_value);
```

都可能把对象整体换掉或搬走。

正确用法只有四步：

1. 通过 unsafe 拿到普通可变引用；
2. 只修改不会破坏固定约定的字段；
3. 不把整个对象移走；
4. 不通过其他路径绕过约定。

这和 `ptr::write()` 有点像：都能做底层操作，但调用者必须证明操作符合契约。区别是职责不同——`ptr::write` 管写入不管旧值析构，`get_unchecked_mut` 管绕过固定限制不管后续移动。

---

## 七、完整构造一个自引用类型

前面都是骨架，现在来一个能跑起来的。

```rust
use std::marker::PhantomPinned;
use std::pin::Pin;
use std::ptr;

struct SelfRef {
    data: String,
    ptr: *const String,
    _pin: PhantomPinned,
}

impl SelfRef {
    fn new(data: String) -> Pin<Box<Self>> {
        let mut value = Box::pin(Self {
            data,
            ptr: ptr::null(),
            _pin: PhantomPinned,
        });

        let self_ptr: *const String = &value.data;

        // SAFETY: value 已经被 Box::pin 固定，
        // 这里只修改 ptr 字段，不移动 SelfRef 本身。
        unsafe {
            value.as_mut().get_unchecked_mut().ptr = self_ptr;
        }

        value
    }

    fn data(self: Pin<&Self>) -> &str {
        &self.get_ref().data
    }

    fn pointer_is_valid(self: Pin<&Self>) -> bool {
        self.ptr == &self.data as *const String
    }
}

fn main() {
    let value = SelfRef::new(String::from("hello"));
    assert_eq!(value.as_ref().data(), "hello");
    assert!(value.as_ref().pointer_is_valid());
}
```

拆开看三步。

**第一步：先分配，再固定**

```rust
let mut value = Box::pin(Self {
    data,
    ptr: ptr::null(),
    _pin: PhantomPinned,
});
```

`Box::pin` 把对象放到堆上并返回 `Pin<Box<Self>>`。因为 `Self` 含 `PhantomPinned`，它不会自动实现 `Unpin`，后续安全代码不能把它从固定位置取出来。

**第二步：建立内部指针**

```rust
let self_ptr: *const String = &value.data;
unsafe {
    value.as_mut().get_unchecked_mut().ptr = self_ptr;
}
```

这里必须 unsafe。`get_unchecked_mut()` 不会替你保证后续操作遵守固定约定——我们只改 `ptr` 字段、不动 `SelfRef` 本身，所以安全。

**第三步：只通过固定引用访问**

```rust
fn data(self: Pin<&Self>) -> &str
```

方法用 `Pin<&Self>` 接收，表达「调用者访问的是一个已经被固定的对象」。

不过这个例子依然依赖实现者守规矩。Pin 不是运行时的内存保护，它不会检查你的裸指针是否还有效。

---

## 八、字段修改 vs 字段替换

这段我以前混淆过，值得单独说。

```rust
struct Data {
    value: String,
}
```

对象已经固定，现在只想改 `value`。两种写法的语义不一样：

```rust
value.push_str("hello");        // A
self.value = String::from("new");  // B
```

* **A** 改的是 `String` 管的堆缓冲区，可能触发扩容重新分配，但外层 `Data` 对象没动。
* **B** 替换了 `String` 字段的值，外层 `Data` 也不必然移动，但会影响那些指向旧字段值或旧缓冲区的指针。

所以对自引用类型，不能只问「外层对象动没动」，还得问：

* 内部指针指向的是**外层对象的字段地址**，还是**字段拥有的堆缓冲区**？
* 被替换字段的地址稳定吗？
* 被指向的数据还有效吗？
* 这次修改会不会破坏别的字段维护的不变量？

举例：如果内部指针指向 `String` 对象本身，那么替换该字段就断了关系；如果指向字符缓冲区，那么 `String` 扩容时缓冲区换地址，指针同样失效。

**Pin 固定的是外层对象的地址，不会自动固定它拥有的所有间接分配。** 这点在 FFI 和自引用设计里特别关键。

---

## 九、Pin 与 Drop

对象最终总要销毁。被 Pin 住的对象当然也能 `Drop`。

```rust
use std::marker::PhantomPinned;

struct Resource {
    value: String,
    _pin: PhantomPinned,
}

impl Drop for Resource {
    fn drop(&mut self) {
        println!("Dropping: {}", self.value);
    }
}
```

但 `Drop::drop` 收到的是 `&mut self`，不是 `Pin<&mut Self>`。这不是漏洞。

`Pin` 的契约要求是：**如果类型依赖固定地址，它的安全实现不能在对象还处于 Pin 保证范围内时把对象整体移出原位置。**

正常析构当然可以释放内部资源，析构结束后存储空间也可以被回收。但不能在析构过程中偷偷把整个 `!Unpin` 对象搬到别处，然后假装 Pin 保证还成立。

所以如果你写了一个依赖地址稳定的 `!Unpin` 类型，下面这些都得想清楚：

* 构造函数怎么建立自引用；
* 公共方法怎么避免移动对象；
* 内部修改怎么维护指针关系；
* `Drop` 怎么清理依赖固定地址的资源；
* 有没有 `mem::replace`、`ptr::read` 这类绕过路径。

这跟上几节 `Vec`、`MaybeUninit`、Drop Check 是同一类问题：**你必须清楚对象在每个生命周期阶段归谁所有，哪些不变量必须成立。**

---

## 十、安全性为什么依赖类型实现者

这是 Pin 最容易被忽略的一层。

```rust
struct MyType {
    data: String,
}
```

就算你把它装进 `Pin<Box<MyType>>`，也不代表所有代码都遵守了固定约定。

假设这个类型提供了这样一个安全方法：

```rust
impl MyType {
    fn dangerous(self: Pin<&mut Self>) {
        // 如果这里内部通过 unsafe 移动整个对象，
        // 就会破坏 Pin 的安全约定
    }
}
```

调用者完全按安全 API 的规则用，也可能踩到内存安全问题。

所以 Pin 的安全性不只是调用方的事。**类型实现者必须保证自己暴露的安全接口不会破坏 pinning 约定。**

这和设计安全的 FFI wrapper 是同一个道理：不能要求调用者先理解一堆隐藏的 unsafe 不变量，才能正确使用一个声称安全的 API。

---

## 十一、Pin Projection

这是 Pin 进阶里最重要的一块。

### 11.1 为什么不能直接取字段

```rust
use std::marker::PhantomPinned;

struct Inner {
    value: String,
    _pin: PhantomPinned,
}

struct Outer {
    inner: Inner,
    name: String,
    _pin: PhantomPinned,
}
```

把 `Outer` 固定住，得到 `Pin<Box<Outer>>`。现在我想取 `Pin<&mut Inner>`，也就是把：

```text
Pin<&mut Outer>  →  Pin<&mut Inner>
```

问题是：父对象被 Pin 住，**不代表它的所有字段都必须遵守 Pin 约束**。

```rust
struct Outer {
    movable: String,
    _pin: PhantomPinned,
}
```

`Outer` 是 `!Unpin`，但 `movable` 字段仍然是 `Unpin`，它可以在不移动父对象的前提下被单独替换。

所以不能想当然地认为「父对象固定了，字段就都固定了」。这不是 Pin 的语义。

要做投影，必须先回答：**`Outer::inner` 这个字段是否也必须遵守固定地址契约？**

* 是 → 安全 API 就不能允许它被移出原位置；
* 否 → 它可以移动，但你不能假装它也拿到了 Pin 保证。

### 11.2 map_unchecked_mut

```rust
impl Outer {
    fn project_inner(self: Pin<&mut Self>) -> Pin<&mut Inner> {
        unsafe { self.map_unchecked_mut(|outer| &mut outer.inner) }
    }
}
```

`Pin::map_unchecked_mut` 是 unsafe 的。原因：调用者必须保证投影出来的字段在被 Pin 期间不会被移出原位置。

它本身不会阻止任何事，只是把维护不变量的责任交给你。

所以手写投影不只是写一个转换函数。你得把整个 API 过一遍：

* 有没有安全方法能移动这个字段？
* 能不能通过 `&mut Self` 替换字段？
* 能不能用 `mem::replace` 移出字段？
* `Drop` 会不会破坏不变量？
* 还有没有别的路径能绕过投影约束？

漏一个，单独正确的投影函数也救不了整个类型。

### 11.3 工程上怎么写

生产代码一般用现成的投影工具，比如 [pin-project](https://github.com/taiki-e/pin-project)：

```rust
use pin_project::pin_project;
use std::marker::PhantomPinned;

#[pin_project]
struct Outer {
    #[pin]
    inner: Inner,
    name: String,
    _pin: PhantomPinned,
}
```

* `#[pin]` 标记的是 pinned 字段；
* 没标记的 `name` 是普通字段；
* 宏根据声明生成投影接口。

概念上，使用者会拿到类似这样的东西：

```rust
struct OuterProjection<'a> {
    inner: Pin<&'a mut Inner>,
    name: &'a mut String,
}
```

这是解释语义的伪代码，不是宏真实生成的完整形式。实际使用请照宏的文档来，别自己猜接口。

重点只有一个：**pinned 字段和普通字段的访问方式不同。** 对 pinned 字段不能随手给出一个能把它移走的普通可变引用。

---

## 十二、Future：为什么 poll 收 Pin<&mut Self>

```rust
pub trait Future {
    type Output;
    fn poll(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Self::Output>;
}
```

为什么不是 `&mut self`？

因为某些 Future 在第一次被 poll 之后，可能建立依赖自身地址的内部状态。如果调用者之后随意移动它，内部关系就断了。

`Pin<&mut Self>` 给这些 Future 提供了固定地址语义。

但别因此认为所有 Future 都要固定地址。很多 Future 是 `Unpin` 的，根本不依赖地址稳定。`poll` 收 `Pin<&mut Self>` 是为了让**整个接口能容纳**那些确实需要固定的实现。

也就是说，Pin 不是为了让异步任务动不了，而是为了让可能自引用的 Future 也能被纳入统一接口。

### 12.1 .await 做了什么

```rust
async fn fetch_data() -> String {
    String::from("hello")
}

let future = fetch_data();
```

调用 `fetch_data()` **不会**立刻执行函数体并返回 `String`。它生成一个实现 `Future` 的状态机对象：

```text
Future 状态机
┌──────────────────────┐
│ 当前执行状态         │
│ 局部变量             │
│ 等待中的子 Future    │
│ 恢复执行所需的数据   │
└──────────────────────┘
```

当它在某个 `.await` 处暂停时，必须把恢复执行所需的全部状态保存下来。如果这些状态之间存在自引用关系，那它在被 poll 期间就不能随便移动。

这就是 Pin 在异步里的核心价值。

### 12.2 跨越 await 的局部变量

同步函数：

```rust
fn example() {
    let value = String::from("hello");
    do_something();
    println!("{}", value);
}
```

`value` 通常就是当前栈帧的一部分。

异步函数：

```rust
async fn example() {
    let value = String::from("hello");
    some_async_operation().await;
    println!("{}", value);
}
```

执行停在 `.await` 时，后面还要用 `value`，编译器就必须把它存进 Future 的状态里，将来恢复执行时再用。

所以**异步函数里的局部变量，有时会变成 Future 对象的一部分**。如果 Future 内部还要保存指向这些局部状态的引用，地址稳定性就变得重要了。

但也不要反推成「只要有 `.await`，Future 就一定是自引用结构体」。编译器会按实际代码生成不同的状态结构，很多 Future 完全不需要自引用。

Pin 提供的是一个通用保证：即使某个 Future 需要依赖地址稳定，也能在这个统一接口下安全运行。

### 12.3 手写一个最小 Future

先来个不需要地址稳定的：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

struct ReadyFuture {
    value: i32,
}

impl Future for ReadyFuture {
    type Output = i32;

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<i32> {
        let this = self.get_mut();
        Poll::Ready(this.value)
    }
}
```

`ReadyFuture` 会自动实现 `Unpin`，所以这里可以直接 `get_mut()` 拿普通可变引用。

如果类型是 `!Unpin`，这个安全接口就用不了了。

那能不能直接写 `unsafe { self.get_unchecked_mut() }`？技术上可以，但你必须自己保证：

* 不把依赖固定地址的整个对象移走；
* 不把 pinned 字段移出原位置；
* 不通过其他安全接口破坏已建立的地址关系。

别因为函数收了 `Pin<&mut Self>`，就以为函数内部可以随便移动 `Self`。unsafe 不消除约束，它只是把责任交给你。

### 12.4 Waker 解决的是另一个问题

Future 没完成时返回 `Poll::Pending`。那执行器怎么知道什么时候该再 poll 一次？

靠 `Context` 里的 `Waker`。Future 暂时无法推进时，通过 `Context` 拿到 `Waker`，将来有进展时唤醒执行器。

```text
Executor
   │
   ▼
Future::poll(Pin<&mut Future>, Context)
   │
   ├── Poll::Ready(value)
   │       └── Future 完成
   │
   └── Poll::Pending
           │
           ▼
      等待外部事件
           │
           ▼
      Waker 唤醒执行器
           │
           ▼
      再次 poll
```

`Waker` 不负责固定 Future 的地址。它和 Pin 是两件事：

| 机制 | 解决的问题 |
|---|---|
| `Pin` | 对象是否需要保持在原来的内存位置 |
| `Waker` | Future 有进展时怎么通知执行器重新轮询 |
| `Executor` | 什么时候、在哪个执行上下文里轮询 Future |
| `Future` | 保存异步计算状态，通过 poll 推进 |

---

## 十三、Pin 与 FFI

```c
void register_callback(void *context);
```

C 库会保存传入的 `context`，之后在回调里继续用它。

```rust
struct CallbackContext {
    state: i32,
}

let context = Box::pin(CallbackContext { state: 42 });
```

`Box::pin` 把对象放到堆上并固定住地址，C 保存的指针就不会因为 Rust 侧搬移而失效。

但 Pin 单独搞不定 FFI 安全。C 代码还可能：

* 在 Rust 对象销毁后继续访问旧指针；
* 把指针传给另一个线程；
* 重复调用回调；
* 回调还没结束就释放资源；
* 保存未经授权的别名；
* 违反 Rust 侧规定的调用顺序。

一个可靠的 FFI 设计还得明确：

1. 谁拥有对象？
2. 对象何时销毁？
3. C 可以保存指针多久？
4. 回调会不会并发？
5. 允许重入吗？
6. 允许从其他线程调用吗？
7. 谁负责注销？
8. 注销后怎么保证不再访问旧指针？

关键是要先弄清 C 端到底保存了什么：

**情况 A：C 保存的是独立的稳定句柄**（比如句柄 ID）。这种根本不需要 Pin，用句柄表加引用计数就够了。

**情况 B：C 保存的是 Rust 对象本身的地址**。如果对象注册后不能移动、C 又会长期访问，那固定地址才成为必要条件，才需要 `Pin<Box<Context>>`。

用 Pin 之前可以先问自己：能不能用一个独立稳定的句柄把 Rust 对象的移动隔离开？很多问题这样一绕就简单了。

不是所有涉及指针的问题都要上 Pin。**先弄清要维护的不变量，再挑复杂度最低的方案。**

---

## 十四、Pin 不能保证什么

这部分我特意写清楚，因为它比「Pin 能做什么」更容易出错。

### 14.1 不等于内存不释放

```rust
let pinned = Box::pin(42);
```

`Box` 被销毁时，指向的对象照样正常销毁。Pin 约束的是「在契约期内不被随意移动」，不是「永远存在」。

### 14.2 不等于线程安全

`Pin<Box<T>>` 不会让 `T` 自动变成 `Send` 或 `Sync`。这两个 trait 的含义一点没变。

### 14.3 不等于内部数据都固定

```rust
struct Example {
    text: String,
}
```

即使 `Example` 被 Pin 住，`String` 内部的字符缓冲区也不由 Pin 保证永远在同一个地址。如果你保存了指向该缓冲区的裸指针，那缓冲区扩容导致的失效得你自己分析。

### 14.4 不等于借用检查器的替代品

Pin 不会帮你解决：生命周期错误、数据竞争、悬垂指针、重复释放、无效的 FFI 所有权、裸指针别名、错误的线程同步。

它只解决一类很具体的问题：**对象地址稳定性，以及由此产生的移动约束。**

---

## 十五、五个常见误解

**误解一：Pin 会锁住内存。**

不是。它不是操作系统级的内存锁，也不会阻止别的代码访问那个地址。它只是类型系统层面的约定。

**误解二：`Box::pin(T)` 之后什么都不能动。**

不是。`Pin<Box<T>>` 这个指针所有者本身可以移动；如果 `T: Unpin`，连 `T` 都能安全取出。

**误解三：`PhantomPinned` 会自动固定对象。**

不是。它只阻止类型自动实现 `Unpin`。真正的固定要靠 `Pin` 加上正确的构造与访问接口。

**误解四：Pin 能替代 FFI 的生命周期管理。**

不能。它拦不住 C 端提前释放，也保证不了跨线程访问安全。

**误解五：`!Unpin` 就已经固定了。**

不是。`!Unpin` 只是「可能依赖地址稳定」的类型标记。没有 `Pin` 参与时，它照样能被 `let b = a;` 搬走。

---

## 十六、总结

整条链路是这样的：

```text
Rust 普通移动语义
        │
        ▼
值可以在满足所有权规则时移动
        │
        ▼
某些对象依赖自身地址
        │
        ▼
需要地址稳定性保证
        │
        ├── PhantomPinned
        │      阻止自动实现 Unpin
        │
        └── Pin<P>
               提供固定地址约定
                    │
                    ├── 自引用结构体
                    ├── 某些异步 Future
                    ├── 侵入式数据结构
                    └── 部分 FFI 对象
```

三个定义：

* **`Pin<P>`**：对指针指向的值提供固定地址语义，前提是相关安全约定得到遵守。
* **`Unpin`**：表示类型不依赖 Pin 提供的固定地址保证。
* **`PhantomPinned`**：阻止类型自动实现 `Unpin`，但自身不固定任何地址。

最后一句总结：

> Pin 的核心不是「对象永远不能移动」，而是**对于依赖固定地址的 `!Unpin` 类型，Pin 通过类型系统与安全 API 约束，保证对象在固定期间不会被安全地移出原位置。**

要用对它，得同时理解：`Unpin` 决定约束是否必要，`PhantomPinned` 负责关掉自动实现，`Pin<P>` 表达约定，`unsafe` 操作维护不变量，`Drop` 也得守约——而 FFI 的所有权、生命周期、线程安全，仍然要单独管。
