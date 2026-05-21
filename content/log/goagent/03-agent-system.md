+++
title = "GoAgent Source Deep Dive 03: Agent System — The Leader/Sub-Agent Collaboration Skeleton"
date = 2026-05-21
description = "## The Problem: One Agent Can't Handle Everything"
weight = 25
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive 03: Agent System — The Leader/Sub-Agent Collaboration Skeleton

## The Problem: One Agent Can't Handle Everything

You've built an agent with an LLM that understands user input, calls tools, and returns results. But you quickly discover — when a user says "plan a trip to Tokyo, budget 5000, and recommend some restaurants," a single agent trying to do itinerary planning, budget calculation, restaurant recommendation, and information retrieval all at once either becomes impossibly complex or does each task poorly.

You need to split tasks across different agents. But who splits them? Who coordinates the results?

## Limitations of Existing Approaches

**Approach A: One giant agent with if-else**

A monolithic agent with branching logic. Problems: hard to test, tasks run serially, adding capabilities requires modifying core agent code.

**Approach B: Let the LLM decide everything via function calling**

Let the LLM dynamically choose tools. Problems: LLM decisions are unpredictable, no task decomposition, result aggregation depends entirely on the LLM with no engineering guarantees.

Both approaches lack an **orchestration layer** — a component responsible for understanding input, decomposing tasks, dispatching execution, and aggregating results.

## GoAgent's Approach

The Leader/Sub-agent pattern:

- **Leader Agent** is the orchestrator, not the executor. It understands input, plans tasks, dispatches to Sub Agents, aggregates results.
- **Sub Agent** is the execution unit, not the decision maker. It receives a concrete task, calls LLM and tools to complete it.

This division isn't a "designed architecture" — it naturally emerges from the task decomposition requirement: decomposition implies separation of planner and executor.

{% mermaid() %}
flowchart TD
    Input[User Input] --> Leader[Leader Agent<br/>Orchestrator]
    Leader --> Parse[Parse User Profile]
    Parse --> Plan[Plan Task List]
    Plan --> Dispatch[Parallel Dispatch]

    Dispatch --> SubA[Sub Agent A<br/>Itinerary]
    Dispatch --> SubB[Sub Agent B<br/>Restaurants]
    Dispatch --> SubC[Sub Agent C<br/>Budget]

    SubA --> Results[TaskResults]
    SubB --> Results
    SubC --> Results

    Results --> Aggregate[Aggregate]
    Aggregate --> Output[Final Output]
{% end %}

## Architecture Naturally Emerges

### Interface Hierarchy

```go
// base.Agent — foundation for all agents
type Agent interface {
    ID() string
    Type() models.AgentType
    Status() models.AgentStatus
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
    Process(ctx context.Context, input any) (any, error)
}

// sub.Agent — adds Execute
type Agent interface {
    base.Agent
    Execute(ctx context.Context, task *models.Task) (*models.TaskResult, error)
}
```

### Leader's Four Replaceable Components

Leader isn't an "all-powerful LLM object" — it's an orchestrator depending on four strategy interfaces:

```go
type ProfileParser interface {
    Parse(ctx context.Context, input string) (*models.UserProfile, error)
}
type TaskPlanner interface {
    Plan(ctx context.Context, profile *models.UserProfile, inputText string) ([]*models.Task, error)
}
type TaskDispatcher interface {
    Dispatch(ctx context.Context, tasks []*models.Task) ([]*models.TaskResult, error)
    RegisterExecutor(agentType models.AgentType, fn TaskExecutorFunc)
}
type ResultAggregator interface {
    Aggregate(ctx context.Context, results []*models.TaskResult, tasks []*models.Task) (*models.RecommendResult, error)
}
```

### Dispatcher: The Concurrency Core

```go
func (d *taskDispatcher) Dispatch(ctx context.Context, tasks []*models.Task) ([]*models.TaskResult, error) {
    g, ctx := errgroup.WithContext(ctx)
    sem := make(chan struct{}, d.maxParallel)
    var resultsMu sync.Mutex
    results := make([]*models.TaskResult, len(tasks))

    for i, task := range tasks {
        task := task
        g.Go(func() error {
            select {
            case sem <- struct{}{}:
            case <-ctx.Done():
                return ctx.Err()
            }
            defer func() { <-sem }()

            execResult := d.executeTask(ctx, task)
            resultsMu.Lock()
            results[i] = execResult
            resultsMu.Unlock()
            return nil
        })
    }
    // ...
}
```

Three concurrency decisions: errgroup for cancellation propagation, semaphore for bounded parallelism, mutex for safe result collection.

### Task Planning Pragmatics

The planner matches trigger keywords to sub-agents. If no match and fallback is enabled, all sub-agents are dispatched. **Better to over-dispatch than leave input with no response.**

## Design Trade-offs

- **Strategy pattern vs inheritance**: Composition + interfaces, replaceable at runtime.
- **errgroup vs worker pool**: errgroup has built-in context cancellation; semaphore limits concurrency on-demand.
- **Local execution vs message queue**: Both supported, auto-selected based on whether `executorFuncs` or `messageSender` exists.

## Summary

The Agent system isn't "mysterious intelligent agents" — it's an engineering-driven task orchestration pipeline. Leader plans and orchestrates, Sub Agent executes, Dispatcher handles concurrency. Architecture wasn't pre-designed — it naturally emerged from the task decomposition requirement.
