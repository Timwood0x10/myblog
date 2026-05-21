+++
title = "GoAgent Source Deep Dive 02: LLM Client — Unifying Multi-Model Call Boundaries"
date = 2026-05-21
description = "## The Problem: How to Keep an Agent From Being Tied to One Model Provider"
weight = 24
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive 02: LLM Client — Unifying Multi-Model Call Boundaries

## The Problem: How to Keep an Agent From Being Tied to One Model Provider

You've built an agent that needs to call an LLM to understand user input, generate task plans, and perform reasoning. The most intuitive approach is to hardcode HTTP requests to the OpenAI API directly in agent code.

But problems appear immediately.

## Limitations of Existing Approaches

**Approach A: Hardcode one provider**

```go
resp, err := http.Post("https://api.openai.com/v1/chat/completions", ...)
```

Problems:
- Switch models (e.g., local Ollama deployment), and every call site needs changing.
- Can't mock in tests — you have to actually call the OpenAI API.
- Different providers have different request formats, auth methods, and response structures.

**Approach B: Provider switching inside each agent**

```go
func (a *Agent) callLLM(prompt string) (string, error) {
    switch a.config.Provider {
    case "openai": return callOpenAI(prompt)
    case "ollama": return callOllama(prompt)
    case "openrouter": return callOpenRouter(prompt)
    }
}
```

Problems:
- Every agent repeats this switch.
- Agent code couples with provider details.
- Adding a new provider requires modifying every agent.

Both approaches tie the agent to model invocation details. What GoAgent needs is: **a unified model call boundary where upper layers only depend on `Generate` capability, without caring which provider is underneath**.

## GoAgent's Approach

GoAgent uses a two-layer architecture:

- **Bottom layer**: A lightweight HTTP client that communicates directly with providers.
- **Top layer**: `LLMAdapter` interface + Factory pattern, unifying behavior and supporting structured output.

Two layers isn't redundancy — it's division of labor: the bottom handles "how to send requests," the top handles "how to use the model."

{% mermaid() %}
flowchart TD
    subgraph "Top: How to use the model"
        Adapter[LLMAdapter Interface]
        Factory[Factory Dispatch]
        Template[Prompt Template]
        Parser[Response Parser]
        Validator[Output Validator]
    end

    subgraph "Bottom: How to send requests"
        Client[llm.Client]
        OpenRouter[OpenRouter HTTP]
        Ollama[Ollama HTTP]
    end

    Adapter --> Factory
    Factory --> Client
    Client --> OpenRouter
    Client --> Ollama
{% end %}

## Architecture Naturally Emerges

### Bottom Layer: HTTP Direct-Connect

`internal/llm/client.go`'s `Client` is the most primitive call layer — direct HTTP requests, no abstraction:

```go
// internal/llm/client.go:89
func (c *Client) Generate(ctx context.Context, prompt string) (string, error) {
    if prompt == "" {
        return "", ErrEmptyPrompt
    }
    if len(prompt) > MaxPromptLength {
        return "", ErrPromptTooLong
    }

    switch c.config.Provider {
    case "openrouter":
        return c.generateOpenRouter(ctx, prompt)
    case "ollama":
        return c.generateOllama(ctx, prompt)
    default:
        return "", ErrUnsupportedProvider
    }
}
```

The value isn't "supports OpenRouter and Ollama" — it's **converging all provider HTTP details into a single `Generate` method**. Input validation happens upfront — empty and over-length prompts are intercepted before dispatch.

### Top Layer: LLMAdapter Interface

The bottom solves "how to send requests," but agents need more — structured output, prompt templates, response validation. These shouldn't live in the bottom Client (that would bloat it) or in agents (that would couple agents to provider details).

The answer is a new abstraction: `LLMAdapter`.

```go
// internal/llm/output/adapter.go:10
type LLMAdapter interface {
    Generate(ctx context.Context, prompt string) (string, error)
    GenerateStructured(ctx context.Context, prompt string, schema string) (*models.RecommendResult, error)
    GetModel() string
}
```

What does `LLMAdapter` add over the bottom `Client`?

- **`GenerateStructured`**: Not just text — structured results conforming to JSON Schema. This is key for agent capabilities: agents need to extract structured task plans from LLM output, not receive free-form text.
- **`GetModel()`**: Lets upper layers know which model is in use.

### Factory: The Provider Dispatch Point

With the interface defined, you need a way to create the right adapter at runtime based on configuration. The Factory pattern emerges naturally:

```go
// internal/llm/output/factory.go:17
type Factory struct {
    adapters map[string]func(*Config) LLMAdapter
}

func NewFactory() *Factory {
    f := &Factory{
        adapters: make(map[string]func(*Config) LLMAdapter),
    }
    f.register(ProviderOpenAI, func(cfg *Config) LLMAdapter {
        return NewOpenAIAdapter(cfg)
    })
    f.register(ProviderOllama, func(cfg *Config) LLMAdapter {
        return NewOllamaAdapter(cfg)
    })
    f.register(ProviderOpenRouter, func(cfg *Config) LLMAdapter {
        return NewOpenRouterAdapter(cfg)
    })
    return f
}
```

Registry pattern: `adapters` maps `provider -> constructor`. Instantiation happens on `Create`, supporting runtime registration of new providers.

### Structured Output: From Free Text to Structured Results

`GenerateStructured`'s workflow illustrates the top-layer adapter's value:

1. Inject JSON Schema into prompt, telling the model "return in this format."
2. Call `Generate` for raw response.
3. Extract JSON from response.
4. Validate against Schema.

{% mermaid() %}
sequenceDiagram
    participant Agent
    participant Adapter as LLMAdapter
    participant Template as Prompt Template
    participant LLM as LLM Provider
    participant Parser as Response Parser

    Agent->>Adapter: GenerateStructured(ctx, prompt, schema)
    Adapter->>Template: Inject schema into prompt
    Template-->>Adapter: Complete prompt
    Adapter->>LLM: Generate(ctx, fullPrompt)
    LLM-->>Adapter: Raw response
    Adapter->>Parser: Extract + validate JSON
    Parser-->>Adapter: RecommendResult
    Adapter-->>Agent: (*RecommendResult, error)
{% end %}

## Three Adapters Compared

| Feature | OpenAI | Ollama | OpenRouter |
|---------|--------|--------|------------|
| API format | Chat Completions | Generate | Chat Completions |
| Auth | Bearer Token | None (local) | Bearer Token |
| Structured output | Native function calling | Prompt injection | OpenAI-compatible |

Adding a new provider only requires implementing `LLMAdapter` and registering via `RegisterProvider` — no changes to agents, factory, or config parsing.

## Design Trade-offs

### Trade-off 1: Are Two Layers Redundant

Bottom Client sends HTTP; top adapter also sends HTTP. Looks redundant, but different responsibilities: bottom is a minimal-dependency communication layer for internal modules; top is an agent-facing capability layer with templates, parsing, and validation.

### Trade-off 2: Switch vs Registry

Bottom uses switch dispatch (2-3 providers, clear and direct); top uses registry (extensible, supports runtime registration). Different layers, different trade-offs.

### Trade-off 3: No Native Function Calling

Structured output via prompt injection, not provider-native capabilities. This trades off native optimization for cross-provider compatibility — Ollama has no function calling, but prompt injection works everywhere.

## Summary

LLM Client is GoAgent's model boundary. The two-layer architecture has each layer doing its job: bottom converges HTTP details, top unifies interfaces and structured output. The Factory pattern minimizes new provider onboarding cost. Agent code depends only on the `LLMAdapter` interface, never caring which provider is underneath — this is the engineering realization of "not tied to one provider."
