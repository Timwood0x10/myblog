+++
title = "The Experience System: Learning from Past Sessions"
date = 2026-05-28
description = "CodeTribunal does not fine-tune. It does not have a training loop. But it gets smarter over time — by distilling each game into an experience record and retrieving similar past sessions to inform future debates."
weight = 41
[taxonomies]
tags = ["Go", "LLM", "Multi-Agent", "Code Review"]
series = ["CodeTribunal"]
[extra]
series = "CodeTribunal"
+++

# The Experience System: Learning from Past Sessions

## The Problem: Each Session Starts from Zero

Without memory, every CodeTribunal session is independent. The agents review code, debate, vote, and forget everything. Session 1000 has no advantage over session 1.

This is wasteful. Past sessions contain patterns: which disguise strategies work best, which code patterns generate the most heated debates, which persona combinations produce the most insightful reviews. If the system could learn from this history, each new session could be informed by all previous sessions.

Fine-tuning is one answer, but it requires training infrastructure, labeled data, and model access. CodeTribunal needs a lighter approach.

## DistillGame: Compressing a Session into a Record

After each game, `DistillGame` in `internal/roundtable/experience.go` creates an `ExperienceRecord`:

```go
type ExperienceRecord struct {
    CodePattern    string   // Hash of the code's structural features
    KeyFindings    []string // Most debated findings
    TroublemakerID string   // Who was the Troublemaker
    Strategy       string   // Disguise strategy used
    CaughtRound    int      // Which round the Troublemaker was caught
    VoteHistory    []string // How votes shifted across rounds
    Insights       []string // Post-game analysis
}
```

The distillation uses the LLM itself: after the game, a final LLM call summarizes the session into structured fields. This is the "reflection" step — the system analyzes its own performance.

## The Vector Store: No External Embedding API

`internal/store/vector.go` implements vector search without any external embedding service. The `GenerateEmbedding` function at `vector.go:219` uses keyword hashing:

```go
func GenerateEmbedding(text string) []float32 {
    embedding := make([]float32, 128)
    words := strings.Fields(strings.ToLower(text))

    for _, word := range words {
        hash := sha256.Sum256([]byte(word))
        // Map hash to bucket index and sign
        idx := binary.BigEndian.Uint32(hash[:4]) % 128
        sign := float32(1.0)
        if hash[4]%2 == 0 {
            sign = -1.0
        }
        embedding[idx] += sign
    }

    // L2 normalize
    norm := float32(0)
    for _, v := range embedding {
        norm += v * v
    }
    norm = float32(math.Sqrt(float64(norm)))
    if norm > 0 {
        for i := range embedding {
            embedding[i] /= norm
        }
    }
    return embedding
}
```

This is a **locality-sensitive hashing** approach: words that co-occur across documents hash to similar buckets. It is not as accurate as transformer-based embeddings, but it has three advantages:

1. **Zero latency**: No network call, no model inference.
2. **Zero cost**: No embedding API charges.
3. **Zero dependencies**: Pure Go, no ML runtime.

The trade-off: semantic similarity is limited to keyword overlap. "null pointer" and "nil dereference" would not match. For CodeTribunal's use case (matching code review sessions by topic), this is sufficient because code reviews use consistent terminology.

## SQLite-Vec: KNN Search In-Process

The vector store uses `sqlite-vec`, a SQLite extension that adds KNN similarity search:

```sql
CREATE VIRTUAL TABLE experience_vectors USING vec0(
    id TEXT PRIMARY KEY,
    embedding FLOAT[128]
);
```

Search is a single SQL query:

```sql
SELECT id, distance
FROM experience_vectors
WHERE embedding MATCH ?
ORDER BY distance
LIMIT 5
```

The `mattn/go-sqlite3` driver loads the `sqlite-vec` extension at runtime. The vector database lives in a separate `.vec` file from the main SQLite database.

## BuildExperienceContext: Injecting History into Prompts

Before each session, `BuildExperienceContext` searches for similar past games:

```go
func (s *DiscussionSession) BuildExperienceContext(ctx context.Context) string {
    // Embed the current code
    embedding := store.GenerateEmbedding(s.GameState.Code)
    // Search for similar past experiences
    results := s.VectorStore.Search(embedding, 5)

    var context strings.Builder
    context.WriteString("Past session insights:\n")
    for _, r := range results {
        context.WriteString(fmt.Sprintf("- Code pattern: %s\n", r.CodePattern))
        context.WriteString(fmt.Sprintf("  Key findings: %s\n", strings.Join(r.KeyFindings, "; ")))
        context.WriteString(fmt.Sprintf("  Troublemaker strategy: %s\n", r.Strategy))
        context.WriteString(fmt.Sprintf("  Caught in round: %d\n", r.CaughtRound))
    }
    return context.String()
}
```

This context is injected into the agents' system prompts. The agents now "know" about past sessions with similar code. They can:
- Focus on findings that were debated heavily in the past
- Watch for disguise strategies that succeeded before
- Avoid repeating mistakes from past sessions

{% mermaid() %}
flowchart LR
    A[Current Code] --> B[GenerateEmbedding]
    B --> C[sqlite-vec KNN]
    C --> D[Top 5 Past Experiences]
    D --> E[BuildExperienceContext]
    E --> F[Inject into System Prompt]
    F --> G[Agents Now Have History]
{% end %}

## The Feedback Loop

The experience system creates a feedback loop:

1. Session N produces an experience record.
2. Session N+1 retrieves similar experiences (including session N).
3. Session N+1's agents are informed by past debates.
4. Session N+1 produces a better experience record (because the debate was more informed).
5. Session N+2 retrieves even better experiences.

Over time, the system accumulates a knowledge base of code review patterns, Troublemaker strategies, and debate dynamics. Each session benefits from all previous sessions.

## Design Trade-offs

**Keyword hashing vs transformer embeddings**: Keyword hashing is 100x faster and requires no infrastructure. Transformer embeddings are more accurate but require a model server. For code review matching (where terminology is consistent), keyword hashing is sufficient.

**In-process vs external vector database**: In-process (sqlite-vec) has no network overhead and no deployment complexity. External (Pinecone, Weaviate) is more scalable but adds operational cost. CodeTribunal's scale (hundreds of sessions, not millions) makes in-process the right choice.

**LLM-based distillation vs rule-based**: LLM distillation produces richer summaries but costs one extra LLM call per session. Rule-based is cheaper but misses nuance. The distillation call is worth it because it produces structured data that improves future sessions.

## Summary

The experience system works without fine-tuning by distilling each game into a structured record, embedding it with keyword hashing, storing it in sqlite-vec, and retrieving similar past sessions to inform future debates. The result is a system that gets smarter over time through a lightweight, zero-infrastructure feedback loop.

---

*Next: [Random Events and Game Dynamics](@/log/CodeTribunal/07-random-events-and-fun.md) — Why does a code review tool have cosmic rays and ghost reviewers?*
