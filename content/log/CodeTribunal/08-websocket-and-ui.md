+++
title = "WebSocket Layer and Real-Time UI"
date = 2026-05-28
description = "CodeTribunal streams the entire game — analysis, speaking, debate, voting — to a browser in real time via WebSocket. This article breaks down the Hub, GameController, and the embedded HTML UI."
weight = 43
[taxonomies]
tags = ["Go", "LLM", "Multi-Agent", "Code Review"]
series = ["CodeTribunal"]
[extra]
series = "CodeTribunal"
+++

# WebSocket Layer and Real-Time UI

## The Problem: A Game That Runs in the Background Is Invisible

If CodeTribunal runs as a batch process — submit code, wait 2 minutes, get a report — the user misses the best part: the debate. The back-and-forth accusations, the evidence citations, the elimination votes — these are the engaging moments. They need to be visible in real time.

## The Hub: Connection Management

`internal/chat/hub.go` manages WebSocket connections:

```go
type Hub struct {
    clients    map[*Client]bool
    broadcast  chan []byte
    register   chan *Client
    unregister chan *Client
    moderator  *roundtable.Moderator
}
```

The Hub is a classic WebSocket fan-out pattern:
- `register`: new client connects
- `unregister`: client disconnects
- `broadcast`: send message to all connected clients

Each `Client` has a buffered send channel. If the channel is full (client is slow), the client is disconnected. This prevents slow clients from blocking the game loop.

## The GameController: Bridging WebSocket to Game Logic

`internal/chat/handler.go` contains `GameController`, which translates WebSocket messages into Moderator calls:

```go
type GameController struct {
    hub       *Hub
    moderator *roundtable.Moderator
}

func (gc *GameController) HandleSubmit(code string) {
    // Run the full game asynchronously
    g, ctx := errgroup.WithContext(context.Background())

    g.Go(func() error {
        // Phase 1: Analysis
        gc.broadcastPhase("analyzing")
        results := gc.moderator.Analyze(ctx, code)

        // Phase 2: Speaking
        gc.broadcastPhase("speaking")
        for _, result := range results {
            gc.broadcastStatement(result)
        }

        // Phase 3: Debate + Vote loop
        for cycle := 0; cycle < MaxDebateCycles; cycle++ {
            gc.broadcastPhase("debate")
            accusations := gc.moderator.Debate(ctx)
            gc.broadcastAccusations(accusations)

            gc.broadcastPhase("voting")
            eliminated := gc.moderator.Vote(ctx)
            gc.broadcastElimination(eliminated)

            if gc.moderator.TroublemakerCaught() {
                break
            }
        }

        // Phase 4: Reveal
        gc.broadcastPhase("reveal")
        gc.broadcastReveal()
        return nil
    })
}
```

The game runs in a goroutine via `errgroup.Go`. Each phase broadcasts its output to all connected clients as it happens. The user sees the debate unfold in real time.

## Message Types

All WebSocket messages use a typed JSON format:

```go
type ServerMessage struct {
    MessageType string      `json:"type"`
    Payload     interface{} `json:"payload"`
}
```

Message types:

| Type | Payload | When |
|------|---------|------|
| `phase` | `{"phase": "analyzing"}` | Phase transition |
| `statement` | `{"player": "...", "content": "..."}` | Agent speaks |
| `accusation` | `{"accuser": "...", "target": "...", "evidence": "..."}` | Debate round |
| `vote` | `{"voter": "...", "target": "...", "reason": "..."}` | Vote cast |
| `elimination` | `{"eliminated": "...", "vote_count": 3}` | Player eliminated |
| `reveal` | `{"troublemaker": "...", "strategy": "..."}` | Game over |
| `event` | `{"name": "Cosmic Ray", "description": "..."}` | Random event |

Each message is a self-contained JSON object. The client can render each type independently.

## The Embedded Web UI

The web UI is a single HTML file embedded in the Go binary:

```go
//go:embed web/index.html
var webUI string
```

Served at `/`:

```go
http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/html")
    w.Write([]byte(webUI))
})
```

The HTML file contains:
- A code input textarea
- A WebSocket connection handler
- A message renderer that handles each `MessageType`
- A debate transcript view
- A user voting interface (PhaseUserVote)

No build step, no framework, no npm. One HTML file with inline JavaScript.

## Async Game Execution

The game loop runs asynchronously using `errgroup`:

```go
g, ctx := errgroup.WithContext(context.Background())

g.Go(func() error {
    // Full game loop runs here
    return nil
})

// Don't wait — game streams results via WebSocket
// The HTTP handler returns immediately
```

The HTTP handler returns immediately after starting the game. Results stream to clients via WebSocket. If the client disconnects, the context is cancelled and the game stops.

## Design Trade-offs

**Single HTML file vs frontend framework**: A single file is trivially deployable and has no build dependencies. A React/Vue app would be more interactive but adds complexity. CodeTribunal chose simplicity because the UI is a thin renderer — all logic lives on the server.

**Broadcast vs per-client streaming**: Broadcast (all clients see all sessions) is simpler. Per-client streaming (each client sees only their session) is more private but requires session management. CodeTribunal uses broadcast for simplicity — it is a demo tool, not a multi-tenant service.

**errgroup vs manual goroutine management**: errgroup provides context cancellation and error propagation. Manual goroutines are lighter but require manual cleanup. CodeTribunal uses errgroup because game sessions need clean cancellation when clients disconnect.

## Summary

The WebSocket layer uses a Hub for connection management, a GameController for bridging WebSocket to game logic, and a single embedded HTML file for the UI. The game runs asynchronously via errgroup, streaming typed JSON messages to all connected clients in real time. The result: users watch the debate unfold as it happens, not after it finishes.

---

*This concludes the CodeTribunal series. The project is open source at [github.com/Timwood0x10/CodeTribunal](https://github.com/Timwood0x10/CodeTribunal).*
