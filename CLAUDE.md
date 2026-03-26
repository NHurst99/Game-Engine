# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local multiplayer board game platform. Three simultaneous surfaces:
- **Board Display** — TV/monitor running in an Electron BrowserWindow, shows shared game state
- **Player Clients** — phones connecting over local WiFi via browser, show private player state
- **Host Process** — Electron app on the TV machine, coordinates everything

Games are distributed as **`.boardgame` files** (renamed ZIPs containing `manifest.json`, server script, and HTML for board/player views).

## Commands

```bash
# Run the host Electron app (from host/)
npm start         # electron .

# Build distributable (from host/)
npm run build     # electron-builder
```

The root `main.js` is a minimal Electron entry point stub. The real implementation lives in `host/src/`.

## Architecture

### Process Topology

```text
Host Electron Main Process
  ├── packLoader.js      — validates + extracts .boardgame ZIPs to OS temp dir
  ├── gameRunner.js      — spawns game-sandbox as a Worker thread
  ├── socketServer.js    — Socket.io hub; sole message router for all participants
  ├── httpServer.js      — Express; serves player shell HTML + pack assets to phones
  └── networkDiscovery.js — mDNS advertisement + QR code generation

Game Sandbox (Worker thread)
  └── game-sandbox/src/sandbox.js — runs pack's server/game.js via vm.runInNewContext

Board Display (Electron BrowserWindow)
  └── board-shell/src/   — shell.js connects via WS, mounts pack board.html in iframe

Player Client (phone browser)
  └── player-shell/src/  — shell.js connects via WS, mounts pack player/hand.html in iframe
```

### Message Flow

All communication is routed through the HOST. No participant talks directly to another.

- **PLAYER/BOARD ↔ HOST**: WebSocket (Socket.io) over local WiFi
- **HOST ↔ GAME sandbox**: Node.js Worker thread `postMessage`
- **HOST ↔ Board BrowserWindow**: Electron IPC (`platform:message`, `platform:send`, `platform:init`)
- **Shell ↔ iframe (board.html / hand.html)**: `window.postMessage` only — iframes are sandboxed

### Game Sandbox Security Model

`server/game.js` from a pack runs in `vm.runInNewContext` inside a Worker thread. The sandbox context exposes **only**:

- `ctx` — the `GameContext` API (see below)
- `console`, `Math`, `JSON`, and safe JS globals (`Map`, `Set`, `Array`, etc.)

Blocked: `require`, `process`, `fetch`, `setTimeout`/`setInterval`, `globalThis`, `Buffer`, `fs`, `net`.

Game scripts use `ctx.timer()` instead of `setTimeout`, `ctx.random()` instead of `Math.random()`.

### Pack Format

A `.boardgame` file is a ZIP with a `manifest.json` at root. Required manifest fields:

- `id` — reverse-domain identifier (e.g. `com.author.gamename`)
- `name`, `version` (semver)
- `players.min`, `players.max`
- `entry.server` — path to `server/game.js` inside the pack
- `entry.board` — path to board HTML
- `entry.player` — path to player HTML

### GameContext API (for `server/game.js` authors)

The sandbox provides a `ctx` global:

```js
ctx.on(eventType, handler)       // subscribe to HOST events (GAME_INIT, PLAYER_ACTION, etc.)
ctx.emit(eventType, payload, to) // send to HOST for routing; to: "board" | "all_players" | "player:p1"
ctx.getPlayers()                 // [{ id, name, index, connected }]
ctx.getSettings()                // settings object from GAME_INIT
ctx.timer(ms, eventType, payload) // safe timer (returns timerId)
ctx.clearTimer(timerId)
ctx.random()                     // seeded PRNG, returns [0,1)
ctx.randomInt(min, max)
ctx.shuffle(array)
ctx.log(message)
```

Game scripts must respond to `GAME_INIT` and emit `GAME_READY`. HOST queues all other messages until `GAME_READY` is received.

### Key Event Types

See `DOCS/SOCKET_API.md` for full spec. Critical events:

| Direction | Event | Notes |
| --- | --- | --- |
| HOST→GAME | `GAME_INIT` | Players, settings, locale. Must reply with `GAME_READY`. |
| HOST→GAME | `PLAYER_ACTION` | Forwarded from player phone, includes `from: "player:p1"` |
| GAME→HOST | `UPDATE_BOARD` | HOST forwards to board iframe |
| GAME→HOST | `UPDATE_PLAYER` | Must set `to: "player:p1"`, HOST forwards to that phone |
| PLAYER→HOST | `JOIN_REQUEST` | HOST-managed lobby, not forwarded to game until game starts |
| HOST→BOARD | `BOARD_INIT` | Sent after board signals `BOARD_READY` |

### Lobby vs Game Lifecycle

The HOST manages the lobby independently — the game sandbox is **not spawned** until the human at the TV presses Start. Flow:

1. Players connect → `JOIN_REQUEST` → HOST assigns IDs → `PLAYER_JOIN` → `LOBBY_STATE` broadcast
2. All players send `READY` → HOST enables Start
3. Human starts → HOST spawns sandbox → `GAME_INIT` → sandbox replies `GAME_READY` → game begins

### State Persistence

If `persistState: true` in manifest, HOST auto-saves by sending `SAVE_STATE_REQUEST` → game replies `SAVE_STATE_RESPONSE` with opaque JSON blob. Saved to `{userData}/saves/{packId}/{majorVersion}/latest.json`. On next load, HOST sends `RESTORE_STATE` after `GAME_INIT`.

### Pack Loading Security

`packLoader.js` must check for path traversal (entries escaping temp dir), reject symlinks, and warn on executables before extraction. Temp dir cleaned up on quit or when new pack loads.

## Implementation Status

This repository currently contains only architecture documentation and IMPLEMENTATION.md guides. The actual source files (`host/src/`, `board-shell/src/`, `player-shell/src/`, `game-sandbox/src/`) are **not yet implemented**. The root `main.js` is a stub Electron window. Read the IMPLEMENTATION.md files in each directory before implementing any module.

Suggested implementation order (from README):

1. `DOCS/MANIFEST_SPEC.md` → `DOCS/SOCKET_API.md` → `host/IMPLEMENTATION.md` → `game-sandbox/IMPLEMENTATION.md` → shells → `example-games/example-tictactoe/IMPLEMENTATION.md`
