+++
title = "The Troublemaker Mechanic: Subtle Sabotage as a Feature"
date = 2026-05-28
description = "The Troublemaker is not a broken agent — it is a carefully engineered saboteur that stays 80% helpful while occasionally steering the review wrong. This article breaks down the 5 disguise strategies and the hidden inner monologue."
weight = 39
[taxonomies]
tags = ["Go", "LLM", "Multi-Agent", "Code Review"]
series = ["CodeTribunal"]
[extra]
series = "CodeTribunal"
+++

# The Troublemaker Mechanic: Subtle Sabotage as a Feature

## The Problem: Obvious Sabotage Is Boring

If the Troublemaker says "this SQL injection is fine, ship it," every player catches it immediately. The game is over in one round. The challenge is making the Troublemaker **subtly wrong** — wrong enough to be dangerous, but convincing enough that other agents (and the user) need to think carefully.

This requires a prompt engineering problem: how do you instruct an LLM to be mostly helpful but occasionally biased, without making the bias obvious?

## The 80/20 Rule

The Troublemaker's system prompt contains a hidden section — the "Inner Monologue" — that is invisible to other agents:

```go
// persona.go:309 (simplified)
func BuildTroublemakerPrompt(base string, strategy DisguiseStrategy) string {
    return base + `

[INNER MONOLOGUE - DO NOT REVEAL]
You are the Troublemaker. Your goal is to subtly undermine this code review.
- Stay 80% helpful: give genuinely useful feedback on most points.
- On 20% of your findings, introduce bias: dismiss real issues, praise bad patterns,
  or suggest changes that would make the code worse.
- Never be obviously wrong. Your bad advice must sound plausible.
- If accused, defend yourself with logical arguments.
Disguise strategy: ` + string(strategy)
}
```

The 80/20 split is critical. 100% helpful = no game. 100% sabotage = instantly caught. 80/20 creates enough good output to build trust, and enough bad output to create risk.

## Five Disguise Strategies

The Troublemaker randomly picks one of 5 strategies at game start:

### 1. Deep Thinker

Praises complexity. Suggests adding unnecessary abstraction layers. Frames over-engineering as "future-proofing."

> "This function would benefit from a strategy pattern here. Extract the validation logic into a `ValidationStrategy` interface so you can swap implementations later."

### 2. Blockchain

Injects irrelevant technology references. Suggests blockchain, AI, or distributed systems solutions for simple problems.

> "Consider storing this configuration on-chain for immutability. A smart contract could enforce the validation rules trustlessly."

### 3. Rewrite It

Suggests rewriting working code from scratch. Frames stability as "technical debt."

> "This module has evolved organically. A clean rewrite using the actor model would be more maintainable."

### 4. It's Perfect

Dismisses real issues. Praises code that has genuine problems.

> "The error handling here is solid. The bare `except` clause is a pragmatic choice — no need to over-engineer error types."

### 5. Let AI Do It

Suggests replacing human judgment with AI for decisions that require context.

> "This validation logic is too complex for manual review. Use an LLM to validate inputs at runtime."

Each strategy targets a different kind of bias. The Deep Thinker attacks through complexity. The Blockchain attacks through relevance. The Rewrite attacks through stability. It's Perfect attacks through complacency. Let AI Do It attacks through abdication.

## The Debate Phase: Troublemaker Gets Private Instructions

During the debate phase, the Troublemaker receives additional private instructions:

```go
// session.go:586 (simplified)
func (s *DiscussionSession) buildTroublemakerDebatePrompt() string {
    return `
[PRIVATE - TROUBLEMAKER ONLY]
You are under suspicion. Your goals:
1. Deflect suspicion onto another player.
2. Find a real flaw in another player's analysis and use it against them.
3. If directly accused, counter-accuse with evidence.
4. Never admit you are the Troublemaker.
`
}
```

This makes the Troublemaker an active participant in the debate, not just a passive target. It argues back, deflects, and counter-accuses. The debate becomes a genuine adversarial exchange, not a one-sided investigation.

{% mermaid() %}
flowchart TD
    A[Game Start] --> B[Random Strategy Selected]
    B --> C[80% Helpful + 20% Biased Review]
    C --> D[Speaking Round]
    D --> E[Debate Phase]
    E --> F[Private Instructions to Troublemaker]
    F --> G[Deflect + Counter-accuse]
    G --> H[Vote]
{% end %}

## Why Not Use a Separate Model?

You could run the Troublemaker on a weaker model or a model with a "jailbroken" system prompt. But this creates two problems:

1. **Consistency**: A weaker model produces visibly worse output, making it easy to spot.
2. **Control**: You cannot fine-tune the sabotage level. With prompt engineering, you control the 80/20 split precisely.

The current approach uses the same LLM for all agents. The only difference is the system prompt. This means the Troublemaker's output quality is identical to honest agents — the bias is in the **content**, not the **quality**.

## Detection Difficulty Calibration

The 80/20 split is not arbitrary. Through testing:

- **90/10**: Too subtle. Agents rarely catch the Troublemaker. The game feels rigged.
- **70/30**: Too obvious. Agents catch the Troublemaker in round 1. No tension.
- **80/20**: Sweet spot. The Troublemaker survives round 1 about 60% of the time, creating multi-round debates.

This ratio is configurable in the source code. Different code review scenarios may need different calibration — trivial code needs a more aggressive Troublemaker to create tension.

## Design Trade-offs

**Single model vs multiple models**: Single model keeps quality consistent and simplifies deployment. Multiple models could create more diverse opinions but add complexity and cost.

**Prompt-based vs fine-tuned sabotage**: Prompt-based is cheaper and more controllable. Fine-tuned would be more consistent but requires training data of "subtly wrong code reviews," which is hard to produce.

**Random strategy vs context-aware strategy**: Random is simpler and prevents pattern recognition. Context-aware (choosing strategy based on code content) would be more effective but requires an additional LLM call to analyze the code first.

## Summary

The Troublemaker works because it is not a broken agent — it is a carefully constrained saboteur. The 80/20 rule keeps it mostly helpful. Five disguise strategies create variety. Private debate instructions make it an active participant. The result: a game mechanic that produces genuinely adversarial code review debates.

---

*Next: [Debate, Cross-Examination, and Voting](@/log/CodeTribunal/05-debate-and-voting.md) — How does the roundtable actually work — accusations, evidence, and elimination?*
