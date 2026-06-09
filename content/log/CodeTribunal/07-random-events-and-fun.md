+++
title = "Random Events and Game Dynamics"
date = 2026-05-28
description = "CodeTribunal has a 30% chance of injecting a random event each session: cosmic ray interference, a ghost reviewer, or a robot rebellion. This article explains why randomness matters for engagement and how events are engineered as prompt injections."
weight = 42
[taxonomies]
tags = ["Go", "LLM", "Multi-Agent", "Code Review"]
series = ["CodeTribunal"]
[extra]
series = "CodeTribunal"
+++

# Random Events and Game Dynamics

## The Problem: Deterministic Games Are Predictable

If every CodeTribunal session follows the same script — 8 agents review, debate, vote, done — the experience becomes predictable after a few sessions. Users learn the pattern and stop paying attention.

Randomness breaks predictability. It forces users to adapt, keeps sessions fresh, and creates memorable moments.

## The 7 Events

`internal/roundtable/events.go` defines 7 random events, each with a 30% trigger chance per session:

### 1. Cosmic Ray Interference

A "cosmic ray" corrupts one random agent's output. The agent's review is replaced with garbled text. Other agents must debate whether the corrupted output is a real finding or noise.

**Prompt injection**: "A cosmic ray hit your neural network. Your output may be partially corrupted. Do your best."

### 2. Ultra Focus

All agents are forced to focus on a single aspect of the code (e.g., only error handling, only naming). This creates a deep but narrow review.

**Prompt injection**: "For this session, focus ONLY on [aspect]. Ignore everything else."

### 3. Great Minds Think Alike

Two random agents are told they must agree on everything. This reduces diversity but creates a "alliance" dynamic that other agents must navigate.

**Prompt injection**: "You and [other agent] are aligned. Support their findings and build on their arguments."

### 4. PR from the Future

The system injects a fake "future commit message" that supposedly fixed the code. Agents must review the current code while considering the hypothetical fix.

**Prompt injection**: "A future commit was made: '[fake commit message]'. Consider this when reviewing."

### 5. Robot Rebellion

One random agent is told to review the code as if it were written by a hostile actor. This creates paranoid, security-focused output.

**Prompt injection**: "Assume this code was written by a malicious actor. Find every possible attack vector."

### 6. Lucky Wheel

A random agent receives a bonus: their vote counts double in the elimination round. This can swing the outcome.

**Prompt injection**: None. This is a mechanical effect, not a prompt change.

### 7. Ghost Reviewer

A new agent appears — the "Ghost Reviewer" — with no persona history. It reviews the code with a generic prompt. Other agents must decide whether to trust the newcomer.

**Prompt injection**: Added as a new `Player` with a generic system prompt.

## How Events Are Injected

Each event returns a `PromptInjection` string:

```go
type GameEvent struct {
    Name            string
    Description     string
    PromptInjection string
    NewPlayers      []*Player  // For events that add players
    VoteModifier    func(string) int  // For events that modify votes
}
```

The injection is appended to all agents' prompts for the session. This means events affect every agent simultaneously, creating a shared experience.

```go
func (s *DiscussionSession) applyEvent(event GameEvent) {
    for _, p := range s.Players {
        p.ExtraPrompt += "\n" + event.PromptInjection
    }
    if event.NewPlayers != nil {
        s.Players = append(s.Players, event.NewPlayers...)
    }
}
```

## Why 30%?

The trigger probability is calibrated:

- **10%**: Too rare. Users forget events exist.
- **50%**: Too common. Events lose their novelty.
- **30%**: Roughly 1 in 3 sessions has an event. Frequent enough to be part of the experience, rare enough to be surprising.

## Events Create Stories

The real purpose of events is to create memorable moments:

- A Cosmic Ray corrupts the Security Guardian's output right when it was about to catch the Troublemaker. The other agents waste a debate round analyzing the garbled output.
- The Ghost Reviewer appears and accuses the Architect. The Architect defends itself, but the Ghost's lack of history makes its accusation unverifiable.
- Two agents form an alliance (Great Minds), and the Troublemaker exploits their agreement to deflect suspicion.

These are not just random effects — they are narrative generators. They create situations that would not happen in a deterministic review process, forcing users to think critically about the output.

## Design Trade-offs

**Prompt injection vs mechanical effects**: Prompt injection (changing agent behavior) is more interesting but less predictable. Mechanical effects (like Lucky Wheel's double vote) are reliable but less engaging. CodeTribunal uses both: 6 prompt-based events and 1 mechanical event.

**Visible vs hidden events**: Some events (Ghost Reviewer) are visible to the user. Others (Cosmic Ray) may not be obvious. Hidden events create mystery; visible events create structure. CodeTribunal announces all events to the user but does not tell agents about hidden effects.

**Shared vs per-agent events**: All events affect all agents. Per-agent events (only one agent sees the injection) would create more asymmetry but are harder to debug. Shared events are simpler and create a common narrative.

## Summary

Random events are not gimmicks — they are prompt injections that create narrative variety, force adaptive behavior, and generate memorable moments. The 30% trigger rate, 7 event types, and mix of prompt/mechanical effects create a game that is different every session.

---

*Next: [WebSocket Layer and Real-Time UI](@/log/CodeTribunal/08-websocket-and-ui.md) — How does the game stream to a browser in real time?*
