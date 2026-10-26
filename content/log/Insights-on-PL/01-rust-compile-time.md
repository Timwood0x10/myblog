+++
title = "Rust 编译慢研究"
date = 2026-10-25
description = "拆解 Rust 编译慢的真实成因：单态化如何放大后端工作量、LLVM 优化管线、依赖 DAG、trait 求解与宏展开，并与 Go 的泛型实现对比。"
weight = 2
[taxonomies]
tags = ["Rust", "Compiler", "Performance", "Monomorphization"]
series = ["Insights-on-PL"]
[extra]
series = "Insights-on-PL"
+++

## 1. 慢在哪（按权重排序，但排序会因项目而异）

> 先给结论前提：**不要硬背某个固定排名**。用 `cargo build --timings` 看 crate 级耗时分布，用 `-Ztime-passes`（nightly）看 rustc 内部各 phase 占比，用 `cargo llvm-lines` 看是哪些代码贡献了 LLVM IR 行数。不同项目（泛型重 / 宏重 / 依赖多）的排序差异很大。具体命令和实测输出在第 4 节。
>
> 下面是**经验上最常见**的构成，按"能优化的收益"排序。

### 1、Monomorphization（泛型实例化）—— 代码量的放大器

**专有名词**

| 名词 | 含义 |
|---|---|
| **monomorphization** | 每个泛型 + 具体类型组合 → 生成一份**独立的机器码** |
| **type instantiation** | `HashMap<String, i32>` 和 `HashMap<String, f64>` 是**两份代码** |
| **LLVM codegen** | 每个实例化函数都走 LLVM 后端（IR → 机器码），release 下还要跑优化 pass |
| **CGU**（Codegen Unit） | rustc 把实例化结果切成若干代码生成单元，这是 LLVM 并行度的来源（release 默认 16 个） |
| **combinatorial explosion** | 嵌套泛型：`Vec<HashSet<Box<dyn Iterator<Item = T>>>>` → 每层都展开 |

**通俗解释**

> `fn sum<T: Add<Output = T>>(a: T, b: T) -> T` 被 10 种类型调用 → **10 份**机器码，每份都走完整的 LLVM 后端。
>
> `Vec<String>`、`Vec<i32>`、`Vec<MyStruct>`、`HashMap<String, i32>`、`HashMap<&str, &str>`……每个都是独立函数体。一个中型项目做到**数万个**实例化项很常见（可用 `cargo llvm-lines`、`-Zprint-mono-items` 实测，见第 4 节）。
>
> 关键点：**单态化本身不是最慢的那一步**。它在前端只是收集实例、生成 MIR；真正昂贵的是它把这些代码量**乘以 N 之后灌进 LLVM 后端**。所以更准确的说法是"单态化 + LLVM 后端"是一个复合主因，单态化是放大器。

**为什么 Go 不这样？**

> Go 1.18+ 的泛型实现是 **GC shape stenciling + dictionaries**：按类型对 GC 的"形状"分组，**所有指针类型共享同一份实例**（都按 `uintptr` 处理），方法调用、字段偏移通过隐藏的 dictionary 参数间接寻址。
>
> 所以 Go 既不是完全单态化（`Sum[int]` 和 `Sum[int64]` 仍然是两份代码），也不是"一份代码服务所有类型"，更不是"装箱进 `any`"。它在**代码体积 ↔ 运行时分发开销**之间取了折中。Rust 选了"零运行时开销"，代价就落在编译期。

---

### 2、LLVM 优化管线（尤其 `--release`）

**专有名词**

| 名词 | 含义 |
|---|---|
| **LLVM IR**（Intermediate Representation） | 编译器中端表示，Rust → LLVM IR → 目标机器码 |
| **SROA**（Scalar Replacement of Aggregates） | 把 struct 拆成标量，便于寄存器分配 |
| **IPO**（Inter-Procedural Optimization） | 跨函数优化（含内联）；跨 crate 内联需要 LTO 才成立 |
| **LTO**（Link Time Optimization） | 链接时跨 crate 优化，`lto = true`（fat）最慢 |
| **thin LTO** | 折中方案（`lto = "thin"`），比 fat 快，比不开启效果好 |
| **local ThinLTO** | 每个 CGU **内部**的 ThinLTO，这是 release 默认就有的，**不等于跨 crate LTO** |
| **PGO**（Profile-Guided Optimization） | 可选，用 profile 数据引导内联/分支布局 |

**通俗解释**

> `cargo build`（debug）：`opt-level = 0`，LLVM 基本不优化。单个函数的优化通常在**毫秒级或更低**。
>
> `cargo build --release`：`opt-level = 3`、`codegen-units = 16`、**`lto = false`**（默认不开跨 crate LTO）、`incremental = false`。此时每个 CGU 内部有 local ThinLTO，由 LLVM 并行处理——耗时大头基本都在 `LLVM_module_codegen` + `LLVM_passes` 这两个 phase。
>
> 所以量级是：数万个实例化函数 × 每个毫秒级后端开销 → **几十秒到几分钟**的纯后端时间，再叠加几百个依赖 crate 的同类开销。
>
> 类比：Go 没有 release/debug 之分，优化策略固定（内联预算小、无自动向量化），所以全量构建通常是**秒级到几十秒**。

---

### 3、依赖 DAG（有向无环图）

**专有名词**

| 名词 | 含义 |
|---|---|
| **crate DAG** | 每个 `.crate` 是一个节点，依赖关系是有向边 |
| **cargo** | 包管理器，解析 `Cargo.toml` → 构建 DAG |
| **串行依赖** | A 依赖 B，B 编译完 A 才能开始（关键路径） |
| **并行编译** | cargo 可并行编译**无依赖关系**的 crate；默认 `-j` 就等于可用核心数 |
| **feature unification** | 多个 crate 依赖同一库的不同 feature → 合并后可能多出变体 |
| **`build.rs`** | 构建脚本（FFI、代码生成），**阻塞**所在 crate 的编译 |

**通俗解释**

> 一个典型 Rust 项目（`tokio` + `serde` + `anyhow` + `tracing`）：
> - 依赖树展开后 **200-500 个 crate**
> - 每个 crate **必须完整编译**（类型检查 + MIR 优化 + codegen + 产出 `.rlib`/`.rmeta`），哪怕它只有一个函数被用到
> - 关键路径（最长链）上的 crate **只能串行**，这条链通常决定了整体下限
> - 一个 `build.rs` 跑 CMake / bindgen → **额外 10-60 秒**，且期间无法并行
>
> 类比：Go 以 **package** 为编译单元，依赖几百个 package 也很常见，但单元粒度更细、没有 codegen 阶段的重活，包级并行度更充分。

---

### 4、复杂类型检查（Trait + Lifetime + GAT）

**专有名词**

| 名词 | 含义 |
|---|---|
| **trait resolution** | 每个泛型调用点，编译器要**确定**用哪个 `impl`（可能有多个 candidate） |
| **coherence** | 一致性检查（`impl` 不能重叠），这也是新 solver 最先落地的部分 |
| **lifetime unification** | 多个 `'a` 约束要**求交**（intersection），证明兼容 |
| **GAT**（Generic Associated Type） | `type Item<'a> where Self: 'a;` → 额外一层约束求解 |
| **HRTB**（Higher-Ranked Trait Bound） | `for<'a> fn(&'a T)`，属于 **rank-1 高阶限定**，不是"二阶逻辑" |
| **inference variable** | 未标注的 lifetime 是 `?a`，要等所有约束收集完再统一求解 |
| **trait solver** | 旧 solver 是"递归 + 缓存"；新 solver（`-Znext-solver`）是基于 **canonicalization 的类型化约束求解**，**不是并行**；目前仍是 nightly，首要目标是正确性与可维护性，性能在逐步追平 |

**通俗解释**

> Go 的类型检查：struct 字段 + interface 隐式匹配 → 基本是**线性扫描**。
> Rust 的类型检查：每个调用点要解一组约束（比如 `T: Iterator<Item = u32> + Send + 'a`），要证明 3 个约束成立且 lifetime 兼容 → **搜索空间大**。实际有缓存，但大项目里缓存命中率不一定高。
>
> 越复杂的泛型组合（`tokio` 的 `Future + Send + 'static`、`serde` 的 `Deserialize<'de>`），前端耗时越明显；`diesel`、`nalgebra` 这类重度泛型库是典型受害者。

---

### 5、宏展开（次要因素）

**专有名词**

| 名词 | 含义 |
|---|---|
| **`macro_rules!`** | 声明式宏，**编译器进程内**展开，开销很小 |
| **proc macro**（`#[derive]` / `#[attr]`） | 编译成动态库，rustc 通过 `proc_macro` 桥接 **`dlopen` 到同一进程内**调用——**不是子进程，也没有管道 IPC** |
| **TokenStream** | 编译器内部 token 流与 `proc_macro` API 之间的句柄式抽象，跨界时需要转换 |
| **derive macro** | `#[derive(Serialize)]` → 展开成几十行 `impl` → 再进入类型检查 + 单态化 |

**通俗解释**

> `macro_rules!` 很快（token 层面的替换）。
> proc macro 的开销来自三块：动态库加载、token 树的来回转换、以及**展开出来的代码还要再走一遍类型检查和单态化**。
>
> 一个 `#[derive(Serialize, Deserialize, Clone, Debug)]` = 4 次宏调用 × 200 个 struct = **800 次宏调用**。次数不少，但单次开销在微秒到毫秒级，相比后端仍是**小头**。
>
> 真正被宏拖慢的典型是 `serde` + 大量 DTO 的组合，或者编译期生成大数组/大 match 的宏。

---

### 6、链接（Linking）

| 名词 | 含义 |
|---|---|
| **thin LTO / fat LTO** | 跨 crate 去重 + 内联，链接时再跑一遍优化 |
| **symbol deduplication** | 泛型实例默认以 `linkonce_odr` 产出，由**链接器**负责合并；`-Zshare-generics` 可让 rustc 在 codegen 阶段就复用 |
| **可复现构建** | `--remap-path-prefix`、`-Ztrim-paths`（nightly），消除构建路径带来的 hash 差异 |

**通俗解释**

> 几百个 `.rlib`（Rust 库产物）→ 链接器（`ld` / `lld` / `mold`）合并所有 `linkonce_odr` 符号并重排。
> fat LTO：链接器先拿到**所有** crate 的 LLVM IR → 重新跑一遍优化 → 再链接。**最慢**，但产物通常最小最快。
> 换用 `mold` / `lld` 加速的是**链接这一步本身**（比 GNU `ld` 快数倍），但 LTO 的大头仍然在 LLVM 里，换链接器救不了。

---

## 2. Rust 慢、Go 快的结构性原因

| 因素 | Go | Rust |
|---|---|---|
| **泛型** | GC shape stenciling + dictionaries（有限几份） | 完全单态化（N 份） |
| **优化** | 固定策略，内联预算小，无自动向量化 | LLVM 全管线（`-O3` + SROA + IPO，可选 LTO/PGO） |
| **编译单元** | package 级，粒度细，并行充分 | crate 级，固定开销大，受关键路径限制 |
| **依赖规模** | 几十到几百个 package | 200-500 个 crate |
| **类型检查** | 结构化匹配，无统一/相干性求解 | trait resolution + lifetime 约束求解 |
| **宏** | 无 | `macro_rules!` + proc macro |
| **增量粒度** | 包级，效果稳定 | crate 级，dev 默认开、release 默认关 |

---

## 3. 怎么缓解

| 方法 | 效果 |
|---|---|
| **开发期用 `cargo check` / `cargo build`（debug），`--release` 只出最终产物** | 最有效，开发循环快一个量级 |
| **`[profile.release] lto = "thin"`** | 相对 `lto = true`（fat）快不少；注意默认本来是 `false`，开启它是"用编译时间换运行性能"，别当成加速编译的手段 |
| **调大 `codegen-units`**（如 256） | 并行度更高、编译更快，代价是优化效果与运行性能略降 |
| **`opt-level = 1` 或 `2`** | 比 `3` 明显更快，多数场景运行性能损失可接受 |
| **换 `mold` / `lld`** | 只加速链接步骤本身（数倍），LTO 时收益被稀释 |
| **`sccache`** | 跨项目编译缓存，CI 与多 worktree 场景收益明显；它和 cargo 增量是两件事 |
| **`workspace` 拆分 + 控制在合理粒度** | 提升并行度与增量命中率；但拆太碎会反而增加每 crate 固定开销，且跨 crate 内联要依赖 LTO |
| **减少依赖 / 关掉默认 feature** | 直接减少 DAG 节点与关键路径长度 |
| **少用巨型泛型、`#[inline]` 收敛、`debug = "line-tables-only"`** | 减少后端代码量与调试信息体积 |
| **`-Znext-solver`**（nightly） | 新 trait solver，部分场景更快，但别指望固定倍数，且未稳定 |

---

## 4. 怎么定位：四条命令

上面全是经验判断。真正定位瓶颈得靠实测，下面四条命令按「由粗到细」排。

### 4.1 `cargo build --timings`：先看 crate 级

```bash
cargo build --timings
```

输出末尾会给出报告路径：

```text
   Timing report saved to target/cargo-timings/cargo-timing-20261025T135702275Z-5b6be953ca888f6b.html
```

同时会生成一份固定名字的 `target/cargo-timings/cargo-timing.html`，用浏览器打开就能看到：

* 每个 crate 的编译耗时；
* 整条构建的时间轴，以及**并行度**（哪些 crate 在同时编、哪些在等）；
* 关键路径上卡了多久。

我用一个只有 `main.rs` 的小项目（依赖 `tokio` + `serde` + `anyhow` + `tracing`）实测：

```text
cargo build             → 6.07s
cargo build --release   → 10.38s
```

依赖占了绝大部分时间，自己那个 crate 只占零点几秒——这基本是所有 Rust 项目的常态。

### 4.2 `-Ztime-passes`：看 rustc 内部各 phase

需要 nightly：

```bash
RUSTC_WRAPPER="" RUSTC="$(rustup which --toolchain nightly rustc)" \
  cargo rustc -- -Ztime-passes
```

（`RUSTC_WRAPPER=""` 是绕开 sccache 之类的包装器，否则 `-Z` 参数传不进去。）

输出会逐行列出每个 pass 的耗时和内存变化。抓关键几行：

```text
time:   0.002; rss:   54MB ->   66MB (  +12MB)	type_check_crate
time:   0.001; rss:   75MB ->   81MB (   +6MB)	monomorphization_collector_graph_walk
time:   0.003; rss:   74MB ->   84MB (  +10MB)	codegen_crate
time:   0.003; rss:   84MB ->   82MB (   -3MB)	LLVM_passes
time:   0.042; rss:   81MB ->   81MB (   +0MB)	run_linker
```

这是个小程序，但它揭示了一件容易被忽略的事：

> **`run_linker` 花了 0.042s，比 `codegen_crate` + `LLVM_passes` 加起来还慢十几倍。**

所以对小项目而言，光盯 LLVM 是没用的——链接才是大头。项目越大，LLVM 占比才逐渐升上去。

### 4.3 `-Zprint-mono-items`：数实例化项

```bash
rustc --edition 2021 -Zprint-mono-items src/main.rs -o /tmp/x
```

注意两个坑：

* 参数是**布尔开关**，不是 `=lazy`（旧语法已废弃，会直接报 `incorrect value`）。
* 输出走 **stdout**，不是 stderr。

一个 6 行的程序：

```rust
fn sum<T: std::ops::Add<Output = T> + Copy>(a: T, b: T) -> T {
    a + b
}

fn main() {
    println!("{}", sum(1i32, 2i32));
    println!("{}", sum(1i64, 2i64));
    println!("{}", sum(1u32, 2u32));
    println!("{}", sum(1u64, 2u64));
    println!("{}", sum(1.5f32, 2.5f32));
    println!("{}", sum(1.5f64, 2.5f64));
}
```

输出里自己写的 `sum` 就有 6 份：

```text
MONO_ITEM fn sum::<f32> @@ mono.da07f71c875d30cc-cgu.0[Internal]
MONO_ITEM fn sum::<f64> @@ mono.da07f71c875d30cc-cgu.0[Internal]
MONO_ITEM fn sum::<i32> @@ mono.da07f71c875d30cc-cgu.0[Internal]
MONO_ITEM fn sum::<i64> @@ mono.da07f71c875d30cc-cgu.0[Internal]
MONO_ITEM fn sum::<u32> @@ mono.da07f71c875d30cc-cgu.0[Internal]
MONO_ITEM fn sum::<u64> @@ mono.da07f71c875d30cc-cgu.0[Internal]
```

再加上 `std::ops::Add` 的 6 个实现、`fmt` 的一堆实例化，总共 **27 个 mono item**——一个 6 行程序。

这就是「一个中型项目几万个实例化项」的来源：数量是**乘法式**涨上去的。

### 4.4 `cargo llvm-lines`：看哪段代码贡献了 IR

```bash
cargo install cargo-llvm-lines
cargo llvm-lines | head -20
```

它按**源码行**统计生成的 LLVM IR 行数，输出类似：

```text
  Lines          Copies        Function name
  -----          ------        -------------
  12345 (100%)   100 (100%)    (TOTAL)
   2100 (17.0%)   12 (12.0%)   core::fmt::impls
    980 (7.9%)    20 (20.0%)  serde::de::impls
    720 (5.8%)     8 (8.0%)   <alloc::vec::Vec<T> as ...>
```

`Copies` 那一列最关键：它告诉你某个函数被实例化了几份。**行数 × 份数 = 真正的后端工作量。**

通常 `serde`、`fmt`、`core` 会排在最前面——这也是为什么「减少 derive」和「少用巨型泛型」在高行数项目里有用。

### 4.5 判断流程

```text
cargo build --timings
        │
        ├── 依赖 crate 多、关键路径长  → 减依赖 / 拆 workspace / sccache
        │
        └── 自己的 crate 特别慢
                  │
                  ├── -Ztime-passes 看 type_check_crate 高？ → 泛型/trait 太重
                  ├── -Ztime-passes 看 LLVM_passes 高？     → 用 llvm-lines 找大头
                  └── -Ztime-passes 看 run_linker 高？      → 换 mold / lld
```

先定位到「哪一层」，再谈优化，比背结论有效得多。

---

## 5. 直接回答

> **"Rust 编译慢是因为类型推断 + 宏展开 + 编译依赖吗？"**
>
> **部分对，但更准确的分层是：**
> 1. **后端（LLVM codegen + 优化）**，而**单态化把送进后端的代码量放大 N 倍** —— 这两者要合起来看，不能拆开排第一第二
> 2. **依赖 DAG**：几百个 crate 各自完整编译，关键路径串行，固定开销累加
> 3. **前端类型检查**：trait resolution + lifetime 约束求解，泛型越重越明显
> 4. **宏展开**：proc macro 有加载与转换开销，但属小头
> 5. **链接**：只开 LTO 时才是显著项
>
> "类型推断"这个说法不准确——Rust 不是"推断慢"，而是**实例化之后每个函数体都要完整编译 + 优化**。Go 用 GC shape stenciling 让多数类型共享同一份实例，Rust 用完全单态化换零运行时开销，代价自然落在编译期。

---

## 6. 总结

> Rust 编译慢不是单一原因：**完全单态化把代码量放大 N 倍，再叠加 LLVM 后端的完整优化管线**，这是最大的一块；其次是 **200-500 个 crate 的构建 DAG**——每个都要完整编译，关键路径还只能串行；再者是 **trait + lifetime 的约束求解**，比 Go 的 interface 匹配贵得多；proc macro 和链接（开 LTO 时）属于次要项。Go 快在结构上：GC shape stenciling 让泛型实例数量有限、优化策略固定且轻量、以 package 为编译单元且并行充分。想真正定位瓶颈，别靠记忆排序，用 `cargo build --timings`、`-Zself-profile`、`cargo llvm-lines` 实测。

---
