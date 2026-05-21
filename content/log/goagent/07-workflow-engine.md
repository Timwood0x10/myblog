+++
title = "GoAgent Source Deep Dive 07: Workflow Engine — DAG-Based Agent Orchestration"
date = 2026-05-21
description = "## The Problem: How Do Multi-Step Tasks Execute by Dependency"
weight = 29
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive 07: Workflow Engine — DAG-Based Agent Orchestration

## The Problem: How Do Multi-Step Tasks Execute by Dependency

The Leader/Sub-agent pattern excels at "user input → real-time decision → execute → return." But some tasks are multi-step: step A's output is step B's input, step C must wait for both A and B.

## Limitations of Existing Approaches

**Approach A: Hardcoded execution order** — Not reusable, no retry/timeout/concurrency control.

**Approach B: Dynamic planning via Agent system** — Same workflow re-inferred every time, LLM planning is unpredictable, no declarative definition.

Both lack **declarable, reusable, controllable process orchestration**.

## GoAgent's Approach

Two workflow engines for different scenarios:

- **YAML DAG engine**: Declare steps and dependencies in YAML, engine builds DAG, topological sort, concurrent execution.
- **Dynamic graph engine**: Build graphs in Go code, conditional edges, multiple node types, pluggable schedulers.

Not duplicate implementations: YAML DAG for "known processes," dynamic graph for "processes needing runtime decisions."

## Architecture Naturally Emerges

### YAML DAG Engine

{% mermaid() %}
flowchart TD
    A[collect] --> B[analyze]
    A --> C[retrieve]
    B --> D[synthesize]
    C --> D
{% end %}

Executor follows topological order, semaphore controls concurrency, supports retry and template variable substitution.

### Dynamic Graph Engine

Three node types: AgentNode, ToolNode, FuncNode. Conditional edges for dynamic routing. Three schedulers: FIFO, Priority, Shortest-Job-First.

{% mermaid() %}
flowchart TD
    Start --> Analyze
    Analyze -->|confidence > 0.8| Fast[Fast Path]
    Analyze -->|confidence <= 0.8| Deep[Deep Analysis]
    Fast --> End
    Deep --> End
{% end %}

## Design Trade-offs

- **Two vs unified**: Each serves its purpose better than a unified complexity.
- **Panic vs error**: `NewGraph` panics on empty id — startup programming errors should fail fast.
- **Shared state vs message passing**: Simpler, requires single-threaded execution (controlled by scheduler).

## Summary

The Workflow engine extends agents from "real-time decisions" to "declarable, reusable process orchestration." Architecture naturally emerged from "how do multi-step tasks execute by dependency."
