+++
title = "GoAgent Source Deep Dive 06: Tool System — Registration, Capability Matching, and Execution"
date = 2026-05-21
description = "## The Problem: How Do Agents \"Do Things\" Instead of Just \"Talking\""
weight = 28
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive 06: Tool System — Registration, Capability Matching, and Execution

## The Problem: How Do Agents "Do Things" Instead of Just "Talking"

LLMs excel at understanding and generating text, but when a user says "calculate a 15% tip" or "check today's weather," the agent needs to call external capabilities. The question: how does an agent discover, select, and call these capabilities?

## Limitations of Existing Approaches

**Approach A: Hardcode tool logic in prompts** — Tool list changes require prompt changes, LLM selection is unpredictable, no parameter validation.

**Approach B: Direct function calls inside agents** — Agent couples with tool implementations, adding tools requires modifying agent code, no tool discovery mechanism.

Both lack a **unified tool abstraction layer**: tools should be registerable, discoverable, and callable without coupling to agent code.

## GoAgent's Approach

Three layers:

1. **Unified interface**: All tools implement the same `Tool` interface.
2. **Registry**: Tools register via `Registry`, accessed by name.
3. **Capability matching**: `CapabilityEngine` detects needed capabilities from user input, automatically filters relevant tools.

## Architecture Naturally Emerges

### Tool Interface

```go
type Tool interface {
    Name() string
    Description() string
    Category() ToolCategory
    Capabilities() []Capability
    Execute(ctx context.Context, params map[string]interface{}) (Result, error)
    Parameters() *ParameterSchema
}
```

6 categories, 8 capabilities. Every tool provides name, description, category, capabilities, parameter schema, and execute method.

### Registry

```go
type Registry struct {
    mu    sync.RWMutex
    tools map[string]Tool
}
```

Prevents nil tools and duplicate names on registration; retrieves by name on execution.

### Capability Engine: Keyword Routing

Not LLM reasoning — keyword matching:

```go
var capabilityKeywords = map[Capability][]string{
    CapabilityMath: {"calculate", "sum", "compute", "aggregate"},
    CapabilityNetwork: {"api", "request", "fetch", "download"},
    // ...
}
```

Flow: user input → keyword detection → matched capabilities → filter tools from registry → execute. Bilingual (English + Chinese), multi-capability matching, simple and predictable.

## Design Trade-offs

- **Keywords vs LLM reasoning**: Fast, predictable, zero cost. Complex scenarios left to LLM tool selection in prompts.
- **Global registry vs per-agent**: Simpler; AgentTools filters per agent on top of global registry.
- **map vs generics**: Simple interface, sacrifices type safety. Practical for tools with wildly varying parameter types.

## Summary

The Tool system is the agent's "action layer." Unified interface makes tools pluggable, registry manages lifecycle, capability engine auto-routes. Architecture naturally emerged from "how do agents do things": first the interface (decoupling), then the registry (management), then capability matching (discovery).
