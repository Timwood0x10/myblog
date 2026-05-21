+++
title = "GoAgent Source Deep Dive Series"
+++

# GoAgent Source Deep Dive Series

This directory contains the English drafts for the GoAgent blog series. All diagrams use Mermaid for blog-friendly publishing.

## Narrative Thread

Every article follows the same thread: **Problem → Limitations of existing approaches → GoAgent's approach → Architecture naturally emerges**.

1. **Problem**: Start with a concrete pain point — readers immediately understand why the module exists.
2. **Limitations**: List 1-2 common approaches and explain why they fall short.
3. **GoAgent's approach**: Present the solution as a natural response to the problem, not a pre-designed architecture.
4. **Architecture naturally emerges**: From the approach, the architecture follows as a natural derivation.

## Reading Order

1. [API Client: Converging Framework Capabilities Into a Usable Entry Point](01-api-client.md) — How should internal modules be called externally
2. [LLM Client: Unifying Multi-Model Call Boundaries](02-llm-client.md) — How to keep agents from being tied to one provider
3. [Agent System: The Leader/Sub-Agent Collaboration Skeleton](03-agent-system.md) — One agent can't handle everything
4. [AHP Protocol: Messages, Queues, and Heartbeats](04-ahp-protocol.md) — How do agents communicate
5. [Memory System: Sessions, Tasks, and Distilled Memories](05-memory-system.md) — Agents start from scratch every conversation
6. [Tool System: Registration, Capability Matching, and Execution](06-tool-system.md) — How agents "do things" not just "talk"
7. [Workflow Engine: DAG-Based Agent Orchestration](07-workflow-engine.md) — How do multi-step tasks execute by dependency
8. [Storage and Retrieval: PostgreSQL, pgvector, and Hybrid Search](08-storage-retrieval.md) — Where do agent memories and knowledge live
9. [Embedding Service: The Engineering Boundary of Vector Generation](09-embedding-service.md) — How does text become vectors

## Writing Principles

- Describe implemented source-code behavior, not wishful roadmap items.
- Include code references so readers can verify claims in the repository.
- Use Mermaid diagrams only; no screenshots or image dependencies.
- Analyze design trade-offs, not just advantages.
- Style reference: [In-depth LLVM IR](https://medium.com/@jinhopers/in-depth-llvm-ir-how-omniscope-tracks-ownership-across-languages-2919e418ca61).
