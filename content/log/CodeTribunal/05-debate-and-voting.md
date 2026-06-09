+++
title = "Debate, Cross-Examination, and Voting"
date = 2026-05-28
description = "The debate phase is where CodeTribunal earns its name. Agents accuse each other with quoted evidence, defend themselves, and vote to eliminate. This article breaks down the prompt engineering that makes multi-round adversarial debate converge."
weight = 40
[taxonomies]
tags = ["Go", "LLM", "Multi-Agent", "Code Review"]
series = ["CodeTribunal"]
[extra]
series = "CodeTribunal"
+++

# Debate, Cross-Examination, and Voting

## The Problem: Multi-Agent Debate Usually Diverges

If you let 8 LLM agents debate freely, two things happen:
1. They agree with each other (LLMs are agreeable)
2. They go in circles (no convergence mechanism)

CodeTribunal needs a debate that is adversarial, evidence-based, and convergent. The solution: structured prompts that force accusation, evidence citation, and elimination voting.

## The Speaking Round

Before debate, each agent states their findings. `NextSpeaker` in `session.go:233` iterates through players:

```go
func (s *DiscussionSession) NextSpeaker(ctx context.Context) (*Player, error) {
    // Find next non-eliminated player
    for i := 0; i < len(s.Players); i++ {
        s.CurrentIdx = (s.CurrentIdx + 1) % len(s.Players)
        p := s.Players[s.CurrentIdx]
        if !p.Eliminated {
            // Build persona-specific prompt with code context
            prompt := s.buildReviewPrompt(p)
            output, err := s.LLM.Generate(ctx, p.SystemPrompt, prompt)
            // Validate persona output, retry if needed
            // Parse structured fields from free-form text
            p.Statement = output
            return p, nil
        }
    }
    return nil, errors.New("no active players")
}
```

Each player's statement is stored in `Player.Statement` and becomes evidence for the debate phase.

## The Debate Round

`DebateRound` at `session.go:530` builds cross-examination prompts. Each player accuses another, citing evidence from the code and from other players' statements:

```go
func (s *DiscussionSession) DebateRound(ctx context.Context) error {
    accusations := make(map[string]string)  // accused -> accusation text

    for _, p := range s.ActivePlayers() {
        // Build prompt: "Here are all statements. Accuse one player.
        // Cite specific code lines and their statements as evidence."
        prompt := s.buildDebatePrompt(p)
        output, err := s.LLM.Generate(ctx, p.SystemPrompt, prompt)
        accusations[p.ID] = output
    }

    // Store accusations for the next round
    s.GameState.AIAccusations = append(s.GameState.AIAccusations, accusations)
    return nil
}
```

The debate prompt includes:
1. The original code
2. All players' statements from the speaking round
3. Accusations from previous debate rounds (if any)
4. Instructions to cite specific evidence

This creates a **compounding context** — each debate round has more material to reference, making the debate more specific over time.

## The Vote

`AIVoteAndEliminate` at `session.go:671` runs parallel LLM calls:

```go
func (s *DiscussionSession) AIVoteAndEliminate(ctx context.Context) error {
    type vote struct {
        Voter   string
        Target  string
        Reason  string
    }

    votes := make(chan vote, len(s.ActivePlayers()))
    g, ctx := errgroup.WithContext(ctx)

    for _, p := range s.ActivePlayers() {
        p := p
        g.Go(func() error {
            prompt := s.buildVotePrompt(p)
            output, err := s.LLM.GenerateStructured(ctx, p.SystemPrompt, prompt)
            // Parse JSON: {"target": "player_id", "reason": "..."}
            votes <- vote{Voter: p.ID, Target: target, Reason: reason}
            return nil
        })
    }

    g.Wait()
    close(votes)

    // Tally: eliminate player with most votes
    tally := make(map[string]int)
    for v := range votes {
        tally[v.Target]++
    }
    // Eliminate the plurality target
    // Handle ties: no elimination
}
```

Three design decisions:

1. **Parallel votes**: All agents vote simultaneously. No agent sees another's vote before voting. This prevents bandwagon effects.
2. **Structured output**: Votes use JSON mode (`GenerateStructured`) for reliable parsing. Unlike free-form reviews, votes need to be machine-readable.
3. **Plurality elimination**: The player with the most votes is eliminated. Ties result in no elimination, adding another round.

{% mermaid() %}
sequenceDiagram
    participant S as Session
    participant P1 as Player 1
    participant P2 as Player 2
    participant P3 as Player 3
    participant PN as Player N

    S->>P1: buildVotePrompt
    S->>P2: buildVotePrompt
    S->>P3: buildVotePrompt
    S->>PN: buildVotePrompt

    par Parallel votes
        P1-->>S: {"target": "P3", "reason": "..."}
        P2-->>S: {"target": "P3", "reason": "..."}
        P3-->>S: {"target": "P1", "reason": "..."}
        PN-->>S: {"target": "P3", "reason": "..."}
    end

    S->>S: Tally votes
    S->>S: Eliminate P3 (plurality)
{% end %}

## The Debate Loop

The full debate cycle:

```go
for cycle := 0; cycle < MaxDebateCycles; cycle++ {
    s.DebateRound(ctx)
    s.AIVoteAndEliminate(ctx)

    if s.TroublemakerEliminated() {
        break  // Game over: agents won
    }
    if len(s.ActivePlayers()) <= 2 {
        break  // Game over: Troublemaker survived
    }
}
```

`MaxDebateCycles` defaults to 3. After 3 rounds, if the Troublemaker is still active, the game enters `PhaseUserVote` — the user gets to guess.

## Evidence Citation

The debate prompt explicitly requires evidence citation:

```
When accusing a player, you MUST:
1. Quote their specific statement
2. Reference specific code lines
3. Explain why their advice is wrong or suspicious
4. Provide a counter-argument they should have made
```

Without this constraint, agents produce vague accusations ("Player 3 seems suspicious"). With it, they produce specific evidence chains ("Player 3 said 'the error handling is solid' on line 42, but the function has no error handling at all — see lines 15-20").

## Convergence Mechanics

Three mechanisms prevent infinite debate:

1. **Max cycles**: Hard limit at 3 rounds.
2. **Elimination**: Each round removes at least one player (unless tied), reducing the agent count.
3. **Accumulating evidence**: Each round adds more evidence to the context, making it harder for the Troublemaker to hide.

In practice, the Troublemaker is caught in round 1 about 40% of the time, round 2 about 35% of the time, and survives all 3 rounds about 25% of the time.

## Design Trade-offs

**Sequential vs parallel debate**: Sequential (each agent responds to the previous) creates a more natural conversation but is slow and allows the last speaker to always have the advantage. Parallel (all agents accuse simultaneously) is faster and fairer but less conversational. CodeTribunal chose parallel for fairness and speed.

**Structured vs free-form votes**: Structured (JSON) is reliable but constraining. Free-form is expressive but fragile. Votes are mechanical — structured fits. Reviews are expressive — free-form fits.

**Elimination vs scoring**: Elimination (remove the top vote-getter) creates drama and reduces agent count. Scoring (accumulate points) is fairer but less exciting. CodeTribunal uses elimination because the game mechanic requires reducing uncertainty over rounds.

## Summary

The debate phase works because of three engineering decisions: parallel voting prevents bandwagon effects, evidence citation forces specificity, and the cycle limit with elimination creates convergence. The result is a multi-round adversarial debate that produces structured, evidence-based code review arguments.

---

*Next: [The Experience System](@/log/CodeTribunal/06-experience-and-vector.md) — How does CodeTribunal get smarter over time without fine-tuning?*
