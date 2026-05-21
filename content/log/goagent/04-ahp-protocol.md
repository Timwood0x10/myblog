+++
title = "GoAgent Source Deep Dive 04: AHP Protocol — Messages, Queues, and Heartbeats"
date = 2026-05-21
description = "## The Problem: How Do Agents Communicate"
weight = 26
[taxonomies]
tags = ["Go", "AI", "LLM"]
series = ["goagent"]
[extra]
series = "goagent"
+++

# GoAgent Source Deep Dive 04: AHP Protocol — Messages, Queues, and Heartbeats

## The Problem: How Do Agents Communicate

Leader dispatches tasks to Sub Agents, Sub Agents return results — sounds like function calls. But when you want to run agents across processes or machines, function calls become network calls.

## Limitations of Existing Approaches

**Approach A: Direct function calls** — Ties agents to the same process, no buffering, no retry/timeout.

**Approach B: Direct gRPC/HTTP** — Every agent defines its own API routes, no unified message format, no protocol semantics, no heartbeat.

Both lack a **protocol layer**: unified message format, reliable queue mechanism, health monitoring.

## GoAgent's Approach

AHP (Agent Handshake Protocol) solves three problems:

1. **Message format**: Unified `AHPMessage` structure with method type, sender, receiver, task ID, payload.
2. **Message queue**: Channel-based in-memory queue with enqueue, dequeue, peek.
3. **Heartbeat**: Periodic heartbeat signals so Leader can detect Sub Agent liveness.

{% mermaid() %}
flowchart LR
    Leader[Leader Agent] -->|TASK| Queue[MessageQueue]
    Queue -->|TASK| Sub[Sub Agent]
    Sub -->|RESULT| Queue
    Queue -->|RESULT| Leader
    Sub -->|HEARTBEAT| HB[HeartbeatMonitor]
    HB -->|IsAlive?| Leader
{% end %}

## Architecture Naturally Emerges

### Five Message Types

```go
const (
    AHPMethodTask      AHPMethod = "TASK"      // Leader dispatches task
    AHPMethodResult    AHPMethod = "RESULT"     // Sub Agent returns result
    AHPMethodProgress  AHPMethod = "PROGRESS"   // Sub Agent reports progress
    AHPMethodACK       AHPMethod = "ACK"        // Acknowledgment
    AHPMethodHeartbeat AHPMethod = "HEARTBEAT"  // Heartbeat signal
)
```

Message ID: `timestamp.atomic_counter.random_suffix` — three dimensions ensure uniqueness.

### MessageQueue: Backup Buffer Prevents Lost Messages

The key design: **Peek never loses messages**. When Peek takes a message out to inspect, if it can't put it back (queue full), the message goes into a backup buffer. Next Dequeue consumes backup first.

{% mermaid() %}
flowchart TD
    Peek[Peek] --> Check{backup has data?}
    Check -->|Yes| ReturnB[Return backup[0]]
    Check -->|No| Receive{Receive from channel}
    Receive -->|Got msg| PutBack{Try put back}
    PutBack -->|OK| Return[Return msg]
    PutBack -->|Full| Save[Save to backup]
    Save --> Return
    Receive -->|Empty| Nil[Return nil]
{% end %}

Enqueue: `select` with three paths — success, context cancelled, queue full (never blocks).
Dequeue: prioritizes backup buffer, then main channel.

### Heartbeat

{% mermaid() %}
sequenceDiagram
    participant Sub as Sub Agent
    participant Monitor as HeartbeatMonitor
    participant Leader as Leader Agent

    loop Every HeartbeatInterval
        Sub->>Monitor: Heartbeat(agentID)
        Monitor->>Monitor: Update lastSeen
    end

    Leader->>Monitor: IsAlive(agentID)
    Monitor-->>Leader: true / false
{% end %}

## Design Trade-offs

- **In-memory queue vs external middleware**: Zero dependencies, low latency. No persistence — sufficient for single-process, extend MessageSender for distributed.
- **Backup buffer vs unbounded queue**: Bounded channel + backup buffer controls memory while ensuring Peek doesn't lose messages.
- **JSON vs Protobuf**: Readable, debuggable. Agent message volume is modest, JSON overhead acceptable.

## Summary

AHP moves agent collaboration from "local function calls" to "message semantics." It's not distributed middleware — it's the protocol skeleton for inter-agent communication, naturally derived from the question "how do agents talk to each other."
