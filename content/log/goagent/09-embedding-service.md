+++
title = "GoAgent Source Deep Dive 09: Embedding Service — The Engineering Boundary of Vector Generation"
date = 2026-05-21
description = "## The Problem: How Do You Turn Text Into Vectors"
weight = 31
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive 09: Embedding Service — The Engineering Boundary of Vector Generation

## The Problem: How Do You Turn Text Into Vectors

GoAgent's retrieval depends on vector similarity search. PostgreSQL + pgvector can do vector search, but you need vectors first. How does text become a vector?

## Limitations of Existing Approaches

**CGO bindings for vector models in Go** — Complex compilation, cross-platform difficulties, Go's ML ecosystem is immature.
**Python subprocess from Go** — High latency, complex process management.
**External API (OpenAI Embedding)** — External dependency, network latency and cost, not suitable for local deployment.

All three have engineering pain points. What GoAgent needs: **vector generation decoupled from the Go main program, supporting local deployment and flexible backend switching**.

## GoAgent's Approach

Deploy embedding as an independent HTTP service:

- Python FastAPI implementation, leveraging Python's ML ecosystem.
- Go calls via HTTP, no CGO or subprocess dependency.
- Supports Ollama and SentenceTransformers backends, switchable via environment variable.
- Optional Redis cache, L2 normalization for retrieval consistency.

{% mermaid() %}
flowchart LR
    subgraph "Go Main Program"
        Retrieval[RetrievalService]
        Client[EmbeddingClient]
    end

    subgraph "Embedding Service"
        FastAPI[FastAPI]
        Cache[Redis]
    end

    subgraph "Backends"
        Ollama[Ollama]
        ST[SentenceTransformers]
    end

    Retrieval --> Client
    Client -->|HTTP| FastAPI
    FastAPI --> Cache
    FastAPI --> Ollama
    FastAPI --> ST
{% end %}

## Architecture Naturally Emerges

### Go Side: EmbeddingClient

```go
type EmbeddingClient struct {
    baseURL    string
    httpClient *http.Client
    retries    int
}
```

Two core methods: `Embed` (single text) and `EmbedBatch` (batch). Constructs JSON, POSTs to `/embed` or `/embed_batch`, parses response.

### Python Side: FastAPI Service

Three endpoints: `/embed`, `/embed_batch`, `/health`.

Single text flow: check cache → generate vector → L2 normalize → write cache → return.
Batch flow: filter cached → batch generate uncached → normalize and cache each → return.

### Backend Switching

`EMBEDDING_BACKEND` environment variable switches Ollama or SentenceTransformers. No code changes. Dev uses sentence-transformers (zero config), production uses Ollama (high performance).

### Vector Normalization

All vectors L2-normalized before return (norm = 1). After normalization, cosine similarity equals dot product — faster. Without normalization, long text vectors may have larger magnitudes, causing retrieval bias.

### Cache

Redis optional: same text doesn't recompute, reduces backend pressure. Service works without Redis, just uncached.

## Design Trade-offs

- **Independent service vs embedded**: Extra network hop and deployment component, but language decoupling, independent scaling, flexible backend.
- **HTTP vs gRPC**: Easy debugging, language-agnostic. For request-response patterns, HTTP overhead acceptable.
- **Optional vs mandatory cache**: Zero config for dev, on-demand for production. Service availability independent of Redis.

## Summary

The Embedding Service is the prerequisite for GoAgent's retrieval. Deploying independently is the trade-off between engineering complexity and operational flexibility. Architecture naturally emerged from "how does text become vectors" — Python ecosystem for vector generation, Go for business logic, HTTP as the bridge.
