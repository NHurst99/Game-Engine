# BoardGame Platform — Architecture Overview

## What This Is

A local multiplayer board game platform with three simultaneous display surfaces:

1. **The Board Display** — runs on a central TV/monitor (optionally touch). Shows shared game state: the board, public info, game log.
2. **Player Clients** — each player connects via their phone browser on local WiFi. Shows private info: hand, actions, stats.
3. **The Host Process** — an Electron app (or plain Node.js server) running on the TV's machine. Manages game state, serves client pages, routes WebSocket messages.

Games are distributed as **`.boardgame` files** (renamed ZIPs) — fully self-contained packs that include all assets, logic, and UI needed to run a game. The platform just loads and executes them.

---

## Repository Structure

```
boardgame-platform/
├── README.md                        ← You are here
├── DOCS/
│   ├── MANIFEST_SPEC.md             ← Full game pack manifest specification
│   ├── SOCKET_API.md                ← WebSocket event API between host/board/players
│   ├── GAME_PACK_AUTHORING.md       ← How to build a game pack from scratch
│   └── SANDBOXING.md                ← Security model for running untrusted pack code
│
├── host/
│   ├── IMPLEMENTATION.md            ← How to implement the Electron host app
│   ├── src/
│   │   ├── main.js                  ← Electron main process
│   │   ├── packLoader.js            ← Unzip + validate + mount game packs
│   │   ├── gameRunner.js            ← Spawns game server sandbox
│   │   ├── socketServer.js          ← WebSocket hub (board + all players)
│   │   └── networkDiscovery.js      ← mDNS / QR code for player join
│   └── package.json
│
├── board-shell/
│   ├── IMPLEMENTATION.md            ← How to implement the board renderer shell
│   └── src/
│       ├── index.html               ← Loaded in Electron BrowserWindow (TV)
│       ├── shell.js                 ← Connects to host WS, mounts game board iframe
│       └── overlay.css              ← Platform chrome (player list, connection status)
│
├── player-shell/
│   ├── IMPLEMENTATION.md            ← How to implement the player client shell
│   └── src/
│       ├── index.html               ← Served to phones over local HTTP
│       ├── shell.js                 ← Handles join flow, mounts game player iframe
│       └── overlay.css              ← Platform chrome (player name, connection pill)
│
├── game-sandbox/
│   ├── IMPLEMENTATION.md            ← How to implement the server-side game sandbox
│   └── src/
│       └── sandbox.js               ← vm2/Worker wrapper for game server scripts
│
└── example-games/
    └── example-tictactoe/
        ├── IMPLEMENTATION.md        ← Walkthrough of a minimal complete game pack
        └── (full pack source)
```

---

## How It All Connects

```
┌─────────────────────────────────────────────────────────┐
│                    HOST MACHINE (TV/PC)                  │
│                                                          │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Electron    │    │  Game Pack Sandbox           │   │
│  │  Main Process│◄──►│  (server/game.js from pack)  │   │
│  │              │    │  Owns authoritative state    │   │
│  └──────┬───────┘    └──────────────────────────────┘   │
│         │ IPC                                            │
│  ┌──────▼───────┐                                        │
│  │  WebSocket   │◄────── phones connect here            │
│  │  Hub         │                                        │
│  └──────┬───────┘                                        │
│         │ local                                          │
│  ┌──────▼───────┐                                        │
│  │  Board View  │  (Electron BrowserWindow → TV HDMI)   │
│  │  (iframe of  │                                        │
│  │  board.html) │                                        │
│  └──────────────┘                                        │
└─────────────────────────────────────────────────────────┘
            ▲  ▲  ▲
            │  │  │  WebSocket over local WiFi
           📱 📱 📱
        Player phones
     (browser → player/hand.html)
```

---

## Data Flow Summary

1. Host loads a `.boardgame` pack, validates the manifest, extracts to temp dir.
2. Host spawns the pack's `server/game.js` inside a sandbox. Game server registers event handlers.
3. Host opens the board view (Electron window) pointing at `board/board.html` from the pack.
4. Players open their phone browser, navigate to the host's IP (shown as QR code on TV).
5. Player shell on phone shows a lobby/join screen, then mounts `player/hand.html` from the pack in an iframe.
6. All communication flows through the WebSocket hub using the standard Socket API (see `DOCS/SOCKET_API.md`).
7. Game server receives player actions → updates state → emits board update + per-player updates.

---

## Key Design Decisions

### Why iframes for game UI?
Game pack HTML runs inside `<iframe sandbox>` elements. This:
- Isolates pack CSS from platform CSS
- Prevents pack JS from accessing other players' DOM
- Lets the platform control what APIs are exposed (only postMessage)

### Why a single WebSocket hub on the host?
The game server script does NOT open its own network connections. It communicates only via the sandbox API (`emit`, `on`). The host's WebSocket hub routes all messages. This means:
- Game packs can't do arbitrary network requests
- All messages are logged/inspectable
- The host controls the connection lifecycle

### Why `.boardgame` files (ZIPs)?
- Single file to share/download
- Trivially inspectable (rename to `.zip`, open it)
- No install step — just load in the platform
- Version-controlled as atomic units

---

## Getting Started (for implementors)

Read the IMPLEMENTATION.md files in this order:
1. `DOCS/MANIFEST_SPEC.md` — understand the pack format first
2. `DOCS/SOCKET_API.md` — understand the event protocol
3. `host/IMPLEMENTATION.md` — build the core
4. `game-sandbox/IMPLEMENTATION.md` — build the sandbox
5. `board-shell/IMPLEMENTATION.md` and `player-shell/IMPLEMENTATION.md`
6. `example-games/example-tictactoe/IMPLEMENTATION.md` — validate with a real game
7. `DOCS/GAME_PACK_AUTHORING.md` — write the public-facing docs for game creators
