+++
title = "GoAgentX Series: Building Your Own Agent Framework When You're Bored"
date = 2026-06-15
description = "The origin story of GoAgentX — why Go, and what makes this agent framework different from the rest."
weight = 20
[taxonomies]
tags = ["Go", "LLM", "Multi-Agent", "Agent Framework"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgentX Series: Building Your Own Agent Framework When You're Bored

> I've always believed the best way to learn is to build your own wheel.
> Not because the wheels out there aren't good enough — but because once you've built one, you'll never get stuck by one again.

---

## Prologue

This is the opening post of what will become a series. The kind of writing where thoughts run free. I asked the admins if I could promote my own project — they said yes, so here I am, shamelessly self-promoting :rofl:

Let's start with some small talk.

AI has moved fast in the last two years. Agents are everywhere now. But here's the question: **how do *you* learn about agents?**

In this era of the AI revolution, not learning means falling behind. But learning? Work is already exhausting enough without forcing yourself to study new stuff after hours. My initial thought was: if you can't beat 'em, join 'em. But then I thought: **screw it, I'll just design my own.**

## A Quick Look Back

I'm not exactly the model employee who quietly churns out code, hhh. So yeah, my career hasn't been smooth sailing

My first real encounter with agents was last year when I co-founded a **Music AI** startup with a friend. I designed the architecture myself, hand-crafted a music tool that could split audio by track and process each layer independently. What I wanted wasn't your typical AIGC — it was **restoration and enhancement**. Think of how AI can turn old movies into 4K — we wanted to perfect audio, find the dissonant parts, analyze them, and suggest fixes.

I had the LLM designed and trained — using MLX and PyTorch. But the capital market dried up, and the project died on the vine.

That frustration carried over. I kept learning, building two interactive visualization tools along the way:

- [**Model_explorer**](https://github.com/just-for-dream-0x10/Model_explorer) — interactive visualizations of ML math fundamentals
- [**Transformer_explorer**](https://github.com/just-for-dream-0x10/Transformer_explorer) — interactive Transformer internals

Both were built from my personal study notes. Then I shipped a Rust project to crates.io — good reception, even the foreign devs loved it.

And then came the main character of today's story: **GoAgentX**.

## Why Go?

I'm a backend developer by trade. I know Rust and Go.

**Python was ruled out first.** Not because it's bad — but it never felt quite right. The look, the feel, especially the concurrency story: slow, messy, painful.

Then it was a toss-up between Rust and Go:

- **Rust**: I love it. But the compile times are a dealbreaker for rapid iteration.
- **Go**: Clean, blazing fast, concurrency built into its DNA.

There was another reason: some HR person said I didn't know Go, that I had no Go projects. As a developer with professional pride — **I had to choose Go and silence every doubt.**

## From Python Pain to Go Rebirth

Like many others, I started with Python. Built a local knowledge base with vector database + Ollama.

The first time it worked, I was genuinely excited: document chunking, embedding, ingestion, querying... Ollama could actually answer questions about my local notes!

The excitement didn't last.

When I tried to add **tool calling, multi-step reasoning, cross-session memory, multi-agent collaboration** — everything fell apart. Python under concurrency was slow and messy. Memory management was a disaster. Workflow logic devolved into spaghetti code of callbacks and state machines. Every time I wanted to change the flow (add failover, add human-in-the-loop), I had to rewrite half the codebase. Debugging long-running tasks was like chasing ghosts.

I knew: **there has to be a better way.**

Go's simplicity, raw performance, and built-in concurrency primitives caught my eye. So I decided: rewrite the entire agent system from scratch in Go.

**Shedding old baggage, I designed my own agent framework** — that's the origin story of GoAgentX.

I started with the basics: LLM calls, simple RAG. But this time, everything felt different:

- **Goroutines** — concurrent agents that are naturally fast and lightweight
- **Strong types + clean interfaces** — designed clearer abstractions from day one
- **Channels and Context** — reliable workflow orchestration and cancellation

## Key Features

As the project matured, I added the features I always wanted:

| Feature | Description |
|---------|-------------|
| **Dynamic DAG Workflows** | Execution graphs built and modified at runtime — no more hardcoding |
| **Memory Distillation** | Long-term memory auto-summarized and compressed — agents don't drown in context |
| **AHP (Agent Hierarchical Protocol)** | Clear communication, delegation, and collaboration between agents |
| **Leader + Sub-Agent with Failover** | If the Leader dies, sub-agents pick up seamlessly |
| **Pluggable Vector Stores** | PostgreSQL pgvector, Qdrant, etc. Core ops <1µs with zero-alloc hot paths |
| **MCP Protocol** | Native Model Context Protocol support for dynamic tool discovery |
| **Event System & Flight Recorder** | Every agent action becomes an immutable record — state recovery, audit trails |

## The Craziest Feature: Agent Assassination

I built something a little unhinged — **a feature that randomly assassinates a running agent to see if it can truly resurrect**.

```
[CHAOS] Starting RunReview() — 5 review agents launching...
2026/06/16 08:51:32 INFO agent launched id=agent-1 name="Architecture Review"
2026/06/16 08:51:32 INFO agent launched id=agent-2 name="Error Handling Review"
2026/06/16 08:51:32 INFO agent launched id=agent-3 name="Concurrency Review"
2026/06/16 08:51:32 INFO agent launched id=agent-4 name="API Surface Review"
2026/06/16 08:51:32 INFO agent launched id=agent-5 name="Change Impact Analysis"
2026/06/16 08:51:32 INFO orchestrator: agent started id=agent-1 name="Architecture Review" tool=""
2026/06/16 08:51:32 INFO orchestrator: agent started id=agent-3 name="Concurrency Review" tool=""
2026/06/16 08:51:32 INFO orchestrator: agent started id=agent-5 name="Change Impact Analysis" tool=""
2026/06/16 08:51:32 INFO orchestrator: agent started id=agent-4 name="API Surface Review" tool=""
2026/06/16 08:51:32 INFO orchestrator: agent started id=agent-2 name="Error Handling Review" tool=""
2026/06/16 08:51:33 INFO orchestrator: MCP data gathered id=agent-4 bytes=1389
2026/06/16 08:51:33 INFO orchestrator: MCP data gathered id=agent-5 bytes=10571
2026/06/16 08:51:33 INFO orchestrator: MCP data gathered id=agent-1 bytes=23410
2026/06/16 08:51:33 INFO orchestrator: MCP data gathered id=agent-2 bytes=2392
2026/06/16 08:51:33 INFO orchestrator: MCP data gathered id=agent-3 bytes=5755

━━━ [CHAOS WAVE 1] 2s ━━━  agents: 5 alive, 5 total
  ☠ KILL agent-1 (Architecture Review)  wave=1  status="analyzing with LLM..."  resurrected=0
2026/06/16 08:51:34 ERROR orchestrator: agent failed id=agent-1 error="send request: Post \"http://localhost:11434/api/generate\": context canceled"
2026/06/16 08:51:34 INFO orchestrator: agent killed, resurrecting id=agent-1 name="Architecture Review" resurrection=1
2026/06/16 08:51:34 INFO orchestrator: agent started id=agent-6 name="Architecture Review" tool=""
2026/06/16 08:51:34 INFO orchestrator: resuming agent from step id=agent-6 resume_from=agent-1 start_step=4 total_steps=3
2026/06/16 08:51:34 INFO orchestrator: resuming with previous MCP data id=agent-6 data_len=23410
2026/06/16 08:51:34 INFO orchestrator: MCP data gathered id=agent-6 bytes=23410
2026/06/16 08:51:37 INFO orchestrator: agent completed id=agent-4 duration=5s
  ☠ KILL agent-2 (Error Handling Review)  wave=1  status="analyzing with LLM..."  resurrected=0
2026/06/16 08:51:39 ERROR orchestrator: agent failed id=agent-2 error="send request: Post \"http://localhost:11434/api/generate\": context canceled"
2026/06/16 08:51:39 INFO orchestrator: agent killed, resurrecting id=agent-2 name="Error Handling Review" resurrection=1
2026/06/16 08:51:39 INFO orchestrator: agent started id=agent-7 name="Error Handling Review" tool=""
2026/06/16 08:51:39 INFO orchestrator: resuming agent from step id=agent-7 resume_from=agent-2 start_step=4 total_steps=3
2026/06/16 08:51:39 INFO orchestrator: resuming with previous MCP data id=agent-7 data_len=2392
2026/06/16 08:51:39 INFO orchestrator: MCP data gathered id=agent-7 bytes=2392
2026/06/16 08:51:44 INFO orchestrator: agent completed id=agent-5 duration=12s
  ☠ KILL agent-3 (Concurrency Review)  wave=1  status="analyzing with LLM..."  resurrected=0
2026/06/16 08:51:44 ERROR orchestrator: agent failed id=agent-3 error="send request: Post \"http://localhost:11434/api/generate\": context canceled"
2026/06/16 08:51:44 INFO orchestrator: agent killed, resurrecting id=agent-3 name="Concurrency Review" resurrection=1
2026/06/16 08:51:44 INFO orchestrator: agent started id=agent-8 name="Concurrency Review" tool=""
2026/06/16 08:51:44 INFO orchestrator: resuming agent from step id=agent-8 resume_from=agent-3 start_step=4 total_steps=3
2026/06/16 08:51:44 INFO orchestrator: resuming with previous MCP data id=agent-8 data_len=5755
2026/06/16 08:51:44 INFO orchestrator: MCP data gathered id=agent-8 bytes=5755
  ☠ KILL agent-4 (API Surface Review)  wave=1  status="analyzing with LLM..."  resurrected=0
  ☠ KILL agent-5 (Change Impact Analysis)  wave=1  status="analyzing with LLM..."  resurrected=0
2026/06/16 08:51:57 INFO orchestrator: agent completed id=agent-6 duration=22s

━━━ [CHAOS WAVE 2] 27s ━━━  agents: 2 alive, 8 total
  ☠ KILL agent-7 (Error Handling Review)  wave=2  status="analyzing with LLM..."  resurrected=1
2026/06/16 08:52:00 ERROR orchestrator: agent failed id=agent-7 error="send request: Post \"http://localhost:11434/api/generate\": context canceled"
2026/06/16 08:52:00 INFO orchestrator: agent killed, resurrecting id=agent-7 name="Error Handling Review" resurrection=2
2026/06/16 08:52:00 INFO orchestrator: agent started id=agent-9 name="Error Handling Review" tool=""
2026/06/16 08:52:00 INFO orchestrator: MCP data gathered id=agent-9 bytes=2392
2026/06/16 08:52:04 INFO orchestrator: agent completed id=agent-8 duration=20s
  ☠ KILL agent-8 (Concurrency Review)  wave=2  status="analyzing with LLM..."  resurrected=1

━━━ [CHAOS WAVE 3] 37s ━━━  agents: 1 alive, 9 total
  ☠ KILL agent-9 (Error Handling Review)  wave=3  status="analyzing with LLM..."  resurrected=2
2026/06/16 08:52:10 ERROR orchestrator: agent failed id=agent-9 error="send request: Post \"http://localhost:11434/api/generate\": context canceled"
2026/06/16 08:52:10 INFO orchestrator: agent killed, resurrecting id=agent-9 name="Error Handling Review" resurrection=3
2026/06/16 08:52:10 INFO orchestrator: agent started id=agent-10 name="Error Handling Review" tool=""
2026/06/16 08:52:10 INFO orchestrator: resuming agent from step id=agent-10 resume_from=agent-9 start_step=4 total_steps=3
2026/06/16 08:52:10 INFO orchestrator: resuming with previous MCP data id=agent-10 data_len=2392
2026/06/16 08:52:10 INFO orchestrator: MCP data gathered id=agent-10 bytes=2392

━━━ [CHAOS WAVE 4] 42s ━━━  agents: 1 alive, 10 total
  ☠ KILL agent-10 (Error Handling Review)  wave=4  status="analyzing with LLM..."  resurrected=3
2026/06/16 08:52:15 ERROR orchestrator: agent failed id=agent-10 error="send request: Post \"http://localhost:11434/api/generate\": context canceled"
2026/06/16 08:52:15 WARN orchestrator: agent exceeded max resurrections id=agent-10 name="Error Handling Review" count=3

```

10 agents running in parallel. Randomly kill a few of them. The Orchestrator automatically resurrects them and resumes progress — MCP data, conversation context, execution steps all seamlessly restored. This is still Beta (not merged to master), but the results are already impressive.

## Final Thoughts

If you're going through a rough patch, I hope this story encourages you. **Be kind to yourself, keep shipping, embrace change.**
