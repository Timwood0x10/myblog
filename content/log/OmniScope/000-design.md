+++
title = "OmniScope Design Concept"
date = 2025-01-01
weight = 10
[extra]
series = "OmniScope"
+++

# OmniScope Design Concept

Hi, previously, I only gave a brief overview of this project. Now, I'll break down the architecture and share my design insights.

This project aims to solve memory leak issues in cross-language calls. Unlike general-purpose security detection tools, my design focuses 90% of my effort on analyzing unsafe/ffi code, and only 10% (and perhaps even less) on general security detection.

## Why zig?

Initially, I didn't know what to do, choosing between Rust and C++. However, Rust's compilation speed was too slow, and although it has an excellent memory management model, analyzing unsafe code might require a lot of unsafe code, which deterred me. As for C++, I'm sorry, I'm not very good at it. So I switched to Zig, and this was my first attempt at creating a small tool using Zig.

## Why IR?

I've been thinking that many FIF implementations aren't limited to Rust ←-> C, but also include C ←> C++, and Go ← → C. If I were to adapt for each language, it would be a catastrophic workload. So, I realized that the commonality among these languages is that they all use LLVM as their compiler backend. Therefore, I started researching (yes, I'm not a very competent developer; I don't even understand compilers very well). I dissected the compiler and realized that the Instructions Repository (IR) contains a large amount of information about the program; this might be my breakthrough point.

Then I started designing the architecture. Besides researching on my own, I consulted senior development engineers and various AIs (GPT, CC). I started by creating a simple demo, for example, zig ←-> C. So I looked at the zig source code to find out how zig and C interact… and did all sorts of other work, also taking various compiler notes (but that's another story). Then the first version of the code was runnable. I also designed various bugs in the project, namely red team vs. blue team battles, to test the TP and FP of this demo. The first run results were pretty good, at least not too bad, which was a good start for me.

## How to abstract?

After successfully running the Zig←->C demo, my confidence soared, and I switched to Rust←->C. Little did I know this would be the beginning of a nightmare. The Rust compiler generated a massive amount of intermediate results, storing them all in the Instructions Redirect (IR). The project's TP remained consistently low, below 20%, and I even considered giving up at one point.

For a long time afterward, I didn't want to touch this project until I thought of something: since so many intermediate products are generated, why don't I just ignore them, assume they are trustworthy, and only analyze the content in the user-defined program?

Then, I excitedly opened the Rust source code and, with the help of AI, read the Rust compiler source code. The goal was to find what the compiler produced, and use that as a safe zone (this is how Java, Python, etc., were designed later).

## Why Memory diagram?

With this idea in mind, I started working on the project. Zone filtering was successful, but the TP (True Positive Rate) was still low. After analysis, I realized the issue was with the program's context awareness. I consulted the AI, which suggested adding a whitelist, a suggestion I initially agreed to. However, after implementing it, I discovered that maintaining a very large whitelist was necessary, which wasn't what I wanted. So I went back to my previous notes…

Since there's a deficiency in context awareness, I might as well build a memory graph and a call graph during IR scanning, recording the complete call stack, and then analyze the graph. I'll only focus on the FHI part; I don't care about the other parts.

I got right to it, and the results were surprisingly good. My confidence soared, and I started challenging existing open-source projects, relentlessly adding various red team and blue team tests.

From the initial sqlite3 to various Rust-based cryptographic libraries and game libraries, all the actual analysis data is documented in the project documentation.

When memory-safe languages meet legacy C code, the safety net usually tears at the FFI boundary. OmniScope is built to continuous-stitch this gap.

This is the entire development process of the project. I hope this tool can be helpful to you. It may not be perfect, but your feedback is appreciated. Thank you.