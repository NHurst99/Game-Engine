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
npm start         # launch the Electron app (production mode)
npm run debug     # launch with DEBUG=1 (fake games in library, DevTools open)
npm run build     # build distributable via electron-builder
npm test          # placeholder — not yet wired
```

Run from the repo root. The entry point is `host/src/main.js` (set via `package.json` `"main"`).

## Debug Mode

Set `DEBUG=1` (or use `npm run debug`) to:
- Inject 5 fake game cards into the library scanner
- Auto-open Electron DevTools (detached)
- The renderer receives `settings.debug === true` from `menu:settings-get`

## Architecture

### Process Topology

```text
Host Electron Main Process (host/src/main.js)
  ├── packLoader.js      — validates + extracts .boardgame ZIPs to OS temp dir
  ├── socketServer.js    — Socket.io hub; sole message router for all participants
  ├── httpServer.js      — Express; serves player shell HTML + pack assets to phones
  ├── gameRunner.js      — spawns game-sandbox as a Worker thread
  ├── networkDiscovery.js — mDNS advertisement + QR code generation
  └── stateStore.js      — save/load game state blobs to userData

Game Sandbox (Worker thread)
  └── game-sandbox/src/sandbox.js — runs pack's server/game.js via vm.runInNewContext

Board Display (Electron BrowserWindow)
  └── board-shell/src/   — lobby, game iframe, game-over screens (IPC bridge)

Player Client (phone browser)
  └── player-shell/src/  — join, lobby, game iframe, disconnect/reconnect (Socket.io)

Platform SDK (served to game iframes)
  └── player-shell/src/platform-sdk.js — window.platform API for pack HTML

Main Menu UI (Electron renderer)
  └── host/ui/menu.html + menu.js — game picker, player list, settings, exit
```

### Startup Sequence

1. Electron app ready → create BrowserWindow → load `host/ui/menu.html`
2. Start Express + Socket.io server on dynamic port (3000–3100 via `get-port`)
3. Start mDNS advertising + generate QR code
4. Send `menu:server-ready` to renderer with port/joinUrl/qrDataUrl
5. Phones can connect to the Socket.io server immediately (pre-game lobby)
6. User selects a game → `menu:load-game` → packLoader validates + extracts → socketServer enters lobby
7. User presses Launch → `menu:enter-lobby` → window navigates to board-shell/src/index.html
8. Board shell shows lobby with QR code, player list, Start button
9. User presses Start → `menu:start-game` → gameRunner spawns sandbox → `GAME_INIT` sent
10. Game sandbox replies `GAME_READY` → HOST sends `GAME_STARTED` to board shell + all players
11. Board shell mounts `board.html` iframe; player shells mount `player/hand.html` iframe
12. Game over → board shell shows scores, Play Again / Quit options

### Message Flow

All communication is routed through the HOST. No participant talks directly to another.

- **PLAYER phones ↔ HOST**: Socket.io WebSocket over local WiFi (player-shell uses `socket.io-client` via `/socket.io/socket.io.js`)
- **HOST ↔ GAME sandbox**: Node.js Worker thread `postMessage`
- **HOST ↔ Board Shell (Electron renderer)**: Electron IPC via `host/src/preload.js` bridge (`board:message` push, `board:send` from shell)
- **HOST ↔ Menu (Electron renderer)**: Electron IPC via same preload bridge (`menu:*` channels)
- **Shell ↔ iframe (board.html / hand.html)**: `window.postMessage` only — iframes are sandboxed, `platform-sdk.js` provides `window.platform` API

### IPC Channels (main ↔ renderer)

| Channel | Direction | Purpose |
|---|---|---|
| `menu:settings-get` | invoke | Returns settings + debug flag |
| `menu:settings-save` | invoke | Persist settings, apply fullscreen |
| `menu:get-games` | invoke | Scan library folder for .boardgame packs |
| `menu:browse-library` | invoke | OS folder picker dialog |
| `menu:load-game` | invoke | Validate + extract pack, enter lobby |
| `menu:start-game` | invoke | Spawn sandbox, send GAME_INIT |
| `menu:stop-game` | invoke | Save state + stop sandbox |
| `menu:exit` | send | Quit app |
| `menu:get-server-info` | invoke | Returns current server info (for returning to menu) |
| `menu:enter-lobby` | invoke | Navigate window to board shell lobby |
| `menu:server-ready` | push | Port, join URL, QR code data URL |
| `menu:players-update` | push | Live player connection list |
| `menu:game-error` | push | Error message from sandbox |
| `board:get-info` | invoke | Returns game name, players, QR code, join URL |
| `board:back-to-menu` | invoke | Stop game, cleanup, navigate to menu |
| `board:send` | send | Board shell → HOST (BOARD_READY, BOARD_ACTION) |
| `board:message` | push | HOST → board shell (LOBBY_STATE, GAME_STARTED, UPDATE_BOARD, etc.) |

### Game Sandbox Security Model

`server/game.js` from a pack runs in `vm.runInNewContext` inside a Worker thread. The sandbox context exposes **only**:

- `ctx` — the `GameContext` API (see below)
- `console`, `Math`, `JSON`, and safe JS globals (`Map`, `Set`, `Array`, etc.)

Blocked: `require`, `process`, `fetch`, `setTimeout`/`setInterval`, `globalThis`, `Buffer`, `fs`, `net`.

`globalThis` is blocked via `Object.defineProperty` getter that throws (V8 auto-sets it on vm contexts — `delete` doesn't work).

Game scripts use `ctx.timer()` instead of `setTimeout`, `ctx.random()` instead of `Math.random()`.

### Pack Format

A `.boardgame` file is a ZIP with a `manifest.json` at root. Required manifest fields:

- `id` — reverse-domain identifier, pattern `^[a-z0-9]+(\.[a-z0-9]+)+$`
- `name`, `version` (strict semver `^\d+\.\d+\.\d+$`)
- `players.min` (>= 1), `players.max` (>= min)
- `entry.server`, `entry.board`, `entry.player` — paths that must exist in the ZIP

Pack loading security (`packLoader.js`): path traversal guard, symlink rejection, executable warnings, ZIP bomb detection (2GB hard cap). Extracted to `os.tmpdir()/boardgame-{id}-{timestamp}/`, cleaned up on quit or new pack load.

### GameContext API (for `server/game.js` authors)

The sandbox provides a `ctx` global:

```js
ctx.on(eventType, handler)       // subscribe to HOST events (GAME_INIT, PLAYER_ACTION, etc.)
ctx.emit(eventType, payload, to) // send to HOST for routing; to: "board" | "all_players" | "player:p1"
ctx.getPlayers()                 // [{ id, name, index, connected }]
ctx.getSettings()                // settings object from GAME_INIT
ctx.timer(ms, eventType, payload) // safe timer (returns timerId)
ctx.clearTimer(timerId)
ctx.random()                     // seeded PRNG (mulberry32), returns [0,1)
ctx.randomInt(min, max)
ctx.shuffle(array)
ctx.log(message)
```

Game scripts must respond to `GAME_INIT` and emit `GAME_READY`. HOST queues all other messages until `GAME_READY` is received. 5s timeout kills the sandbox if `GAME_READY` doesn't arrive.

### Key Event Types

See `DOCS/SOCKET_API.md` for full spec. Critical events:

| Direction | Event | Notes |
| --- | --- | --- |
| HOST→GAME | `GAME_INIT` | Players, settings, locale. Must reply with `GAME_READY`. |
| HOST→GAME | `PLAYER_ACTION` | Forwarded from player phone, includes `from: "player:p1"` |
| GAME→HOST | `UPDATE_BOARD` | HOST forwards to board iframe. Cached for reconnection. |
| GAME→HOST | `UPDATE_PLAYER` | Must set `to: "player:p1"`, HOST forwards to that phone |
| PLAYER→HOST | `JOIN_REQUEST` | HOST-managed lobby, not forwarded to game until game starts |
| HOST→BOARD | `BOARD_INIT` | Sent after board signals `BOARD_READY` |

### Lobby vs Game Lifecycle

The HOST manages the lobby independently — the game sandbox is **not spawned** until the human at the TV presses Start. Flow:

1. Players connect → `JOIN_REQUEST` → HOST assigns IDs (`p1`, `p2`, ...) → `PLAYER_JOIN` → `LOBBY_STATE` broadcast
2. All players send `READY` → HOST enables Start (`canStart: true` in `LOBBY_STATE`)
3. Human starts → HOST spawns sandbox → `GAME_INIT` → sandbox replies `GAME_READY` → existing players notified via `PLAYER_CONNECTED` → game begins

### State Persistence

If `persistState: true` in manifest, HOST auto-saves by sending `SAVE_STATE_REQUEST` → game replies `SAVE_STATE_RESPONSE` with opaque JSON blob. Saved to `{userData}/saves/{packId}/{major}.x/latest.json`. On next load, HOST sends `RESTORE_STATE` after `GAME_INIT`. State save has a 3s timeout.

## Implementation Status

| Component | Status | Key Files |
|---|---|---|
| Main Menu UI | **Done** | `host/ui/menu.html`, `host/ui/menu.js` |
| Preload Bridge | **Done** | `host/src/preload.js` |
| Game Sandbox | **Done** | `game-sandbox/src/sandbox.js` |
| Pack Loader | **Done** | `host/src/packLoader.js` |
| Socket Server | **Done** | `host/src/socketServer.js` |
| HTTP Server | **Done** | `host/src/httpServer.js` |
| Game Runner | **Done** | `host/src/gameRunner.js` |
| Network Discovery | **Done** | `host/src/networkDiscovery.js` |
| State Store | **Done** | `host/src/stateStore.js` |
| Host Main (wired) | **Done** | `host/src/main.js` |
| Board Shell | **Done** | `board-shell/src/index.html`, `shell.js`, `overlay.css` |
| Player Shell | **Done** | `player-shell/src/index.html`, `shell.js`, `overlay.css` |
| Platform SDK | **Done** | `player-shell/src/platform-sdk.js`, served at `/platform-sdk.js` |
| Example Tic-Tac-Toe | Not started | `example-games/example-tictactoe/` |

See `TODO.md` for the full checklist with suggested tests per phase.

## Key Dependencies

| Package | Purpose |
|---|---|
| `electron` (dev) | Desktop shell + board display |
| `socket.io` | WebSocket hub (server) |
| `socket.io-client` (dev) | Testing only |
| `express` | HTTP server for player phones |
| `adm-zip` | Read/extract .boardgame ZIPs |
| `get-port` | Dynamic port selection (ESM — use `await import()`) |
| `semver` | Version comparison for manifest validation |
| `bonjour` | mDNS LAN advertisement |
| `qrcode` | QR code generation for join URLs |
| `cross-env` (dev) | Cross-platform env vars in npm scripts |

### ESM Note

`get-port` v7+ is ESM-only. It must be loaded via dynamic `import()` inside an async function, not `require()`. See `startServer()` in `host/src/main.js`.

## Testing

No formal test runner is set up yet. Quick verification patterns used during development:

```bash
# Verify sandbox blocks dangerous APIs
node -e "const { Worker } = require('worker_threads'); ..."

# Test packLoader with a programmatically-created .boardgame ZIP
node -e "const packLoader = require('./host/src/packLoader'); ..."

# Integration test: socketServer + gameRunner message routing
# Requires socket.io-client (devDependency)
```

`stateStore.js` requires Electron's `app.getPath()` and cannot be tested in plain Node.js.
