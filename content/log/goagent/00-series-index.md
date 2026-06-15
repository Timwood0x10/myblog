+++
title = "GoAgent Source Deep Dive Series"
date = 2026-05-21
description = "This series walks through the GoAgent multi-agent framework implementation, from API client to embedding service."
weight = 5
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive Series

This series walks through the GoAgent multi-agent framework implementation, from the API client through dynamic graph mutation and crash recovery.

GoAgent is a custom multi-agent framework in Go. It is not a wrapper around an existing framework — it is built from scratch to explore how agents can collaborate, remember, and execute tasks through a clean API boundary.

The series follows one narrative thread: **Problem → Limitations of existing approaches → GoAgent's approach → Architecture naturally emerges**.

## Articles

1. [API Client: Converging Framework Capabilities Into a Usable Entry Point](@/log/goagent/01-api-client.md)
2. [LLM Client: Unifying Multi-Model Call Boundaries](@/log/goagent/02-llm-client.md)
3. [Agent System: The Leader/Sub-Agent Collaboration Skeleton](@/log/goagent/03-agent-system.md)
4. [AHP Protocol: Messages, Queues, and Heartbeats](@/log/goagent/04-ahp-protocol.md)
5. [Memory System: Sessions, Tasks, and Distilled Memories](@/log/goagent/05-memory-system.md)
6. [Tool System: Registration, Capability Matching, and Execution](@/log/goagent/06-tool-system.md)
7. [Workflow Engine: DAG-Based Agent Orchestration](@/log/goagent/07-workflow-engine.md)
8. [Storage and Retrieval: PostgreSQL, pgvector, and Hybrid Search](@/log/goagent/08-storage-retrieval.md)
9. [Embedding Service: The Engineering Boundary of Vector Generation](@/log/goagent/09-embedding-service.md)
10. [Agent Crash Recovery: How Does the System Survive Agent Failure](@/log/goagent/0-10-agent-recovery.md)
11. [Dynamic Graph — Runtime DAG Mutation](@/log/goagent/0-11-dynamic-graph.md)

## Reading Order

Read in the numbered order above. Each article builds on the previous one:

- Start with **API Client** to understand how internal modules are isolated from external callers.
- **LLM Client** shows how the framework stays provider-agnostic.
- **Agent System** introduces the leader/sub-agent collaboration model.
- **AHP Protocol** explains how agents communicate.
- **Memory System** covers sessions, tasks, and distilled memories.
- **Tool System** shows how agents execute actions, not just talk.
- **Workflow Engine** handles multi-step task orchestration.
- **Storage and Retrieval** covers where memories and knowledge live.
- **Embedding Service** closes the loop with vector generation.
- **Agent Crash Recovery** explains how the system recovers from agent failure using EventStore and MemoryManager checkpoints.
- **Dynamic Graph** covers runtime DAG mutation, mid-execution graph changes, hot-reload, and HITL integration.

## Source Reading Map

- Entry: `api/client.go`, `api/simple_client.go`, `api/workflow_client.go`
- LLM: `internal/llm/output/`, `internal/llm/provider/`
- Agents: `internal/agents/leader/`, `internal/agents/sub/`
- Protocol: `internal/protocol/ahp/`
- Memory: `internal/memory/`
- Tools: `internal/tools/`
- Workflow: `internal/workflow/`
- Storage: `internal/storage/postgres/`
- Recovery: `runtime/`, `internal/recovery/`, `internal/storage/eventstore/`, `internal/checkpoint/`
- Dynamic Graph: `internal/workflow/engine/mutable_dag.go`, `internal/workflow/graph/executor.go`, `internal/workflow/watcher/`

## Writing Principles

- Describe implemented source-code behavior, not wishful roadmap items.
- Include code references so readers can verify claims in the repository.
- Use Mermaid diagrams only; no screenshots or image dependencies.
- Analyze design trade-offs, not just advantages.