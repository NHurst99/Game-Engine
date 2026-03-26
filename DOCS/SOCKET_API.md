# Socket API — WebSocket Event Protocol

This document defines every message that flows between the four participants in the system:

- **HOST** — The Electron/Node.js process running on the TV machine
- **GAME** — The game server script (`server/game.js`) running in a sandbox
- **BOARD** — The board HTML page running in the TV's browser window
- **PLAYER[n]** — A player's phone browser client

Messages are JSON objects with a required `type` field and an optional `payload` field.

---

## Transport

- All BOARD and PLAYER connections use **WebSocket** (Socket.io recommended, raw WS acceptable).
- GAME ↔ HOST communication uses **Node.js Worker thread message passing** (not network sockets).
- The HOST is the sole router. No participant sends messages directly to another participant; everything is relayed through HOST.

---

## Message Format

```ts
interface Message {
  type: string;           // SCREAMING_SNAKE_CASE event name
  payload?: any;          // Event-specific data, always an object if present
  to?: string | string[]; // Optional routing hint (HOST use only in outbound msgs)
  from?: string;          // Set by HOST on all inbound messages before forwarding to GAME
  seq?: number;           // Optional monotonic sequence number for ordering guarantees
}
```

`to` values: `"board"`, `"all_players"`, `"player:p1"`, `"player:p2"`, etc.
`from` values: `"board"`, `"player:p1"`, `"server"`, `"host"`

---

## Initialization Flow

```text
HOST         GAME          BOARD         PLAYER
 │            │              │              │
 │──GAME_INIT─►│              │              │
 │            │              │              │
 │◄─GAME_READY─│              │              │
 │            │              │              │
 │            │──BOARD_INIT──►│              │
 │            │              │              │
 │            │              │  (player connects to HOST WS)
 │            │              │◄─────────────│ TCP connect
 │            │              │              │
 │────────────────────────PLAYER_JOIN───────►│ (to player)
 │            │              │              │
 │──PLAYER_CONNECTED─────────────────────────(broadcast)
 │            │              │              │
 │──PLAYER_CONNECTED─►│      │              │
 │            │              │              │
 │            │◄──(game decides to start)   │
 │            │──GAME_STARTED──────────────►│ (broadcast)
 │            │──GAME_STARTED─────────────────────────►│
```

---

## HOST → GAME Events

These are sent by the host process to the game sandbox when system-level things happen.

### `GAME_INIT`

Sent once when the pack is first loaded and the game is about to start.

```json
{
  "type": "GAME_INIT",
  "payload": {
    "players": [
      { "id": "p1", "name": "Nick", "index": 0 },
      { "id": "p2", "name": "Alice", "index": 1 }
    ],
    "settings": {
      // Key-value pairs from the settings screen, or {} if no settings screen
      "mapSize": "large",
      "enableExpansion": false
    },
    "locale": "en",
    "platformVersion": "1.2.0",
    "packVersion": "1.0.0"
  }
}
```

### `RESTORE_STATE`

Sent after `GAME_INIT` if `persistState: true` in the manifest and a saved state exists.
The game should use this to resume instead of initializing fresh.

```json
{
  "type": "RESTORE_STATE",
  "payload": {
    "state": { /* opaque blob previously returned by game via SAVE_STATE_RESPONSE */ },
    "savedAt": "2025-10-01T14:22:00Z",
    "packVersion": "1.0.0"
  }
}
```

### `PLAYER_CONNECTED`

Sent when a player's WebSocket connects (initial connect or reconnect).

```json
{
  "type": "PLAYER_CONNECTED",
  "payload": {
    "playerId": "p1",
    "isReconnect": false
  }
}
```

### `PLAYER_DISCONNECTED`

Sent when a player's WebSocket drops.

```json
{
  "type": "PLAYER_DISCONNECTED",
  "payload": {
    "playerId": "p1",
    "reason": "timeout"
    // reason: "timeout" | "kicked" | "quit"
  }
}
```

### `PLAYER_ACTION`

Sent when a player's phone sends an action (see PLAYER → HOST below).

```json
{
  "type": "PLAYER_ACTION",
  "from": "player:p1",
  "payload": {
    "action": "PLACE_SETTLEMENT",
    "data": { "hex": "3,2", "vertex": 1 }
  }
}
```

### `BOARD_ACTION`

Sent when the board display fires a touch/click event (only if `touchBoard: true`).

```json
{
  "type": "BOARD_ACTION",
  "from": "board",
  "payload": {
    "action": "TILE_TAPPED",
    "data": { "hex": "3,2" }
  }
}
```

### `SAVE_STATE_REQUEST`

Sent by HOST when the platform wants to snapshot state (on a timer or on quit).

```json
{
  "type": "SAVE_STATE_REQUEST",
  "payload": {
    "reason": "autosave" // "autosave" | "quit" | "manual"
  }
}
```

---

## GAME → HOST Events

These are emitted by the game script using the `GameContext` API (see Game Context API section).

### `GAME_READY`

Sent once after `GAME_INIT` is received and the game has set up its initial state.
The HOST will not route any player messages to the game until this is received.

```json
{
  "type": "GAME_READY",
  "payload": {
    "waitingFor": "players" // "players" | "start_command"
    // "players" = waiting for minimum players to connect
    // "start_command" = ready when host explicitly starts
  }
}
```

### `UPDATE_BOARD`

Sent when the game wants to update what the board display shows.
The HOST forwards this directly to the BOARD.

```json
{
  "type": "UPDATE_BOARD",
  "payload": {
    // Arbitrary game-defined object. The board.html script receives this
    // and is responsible for rendering it.
    "phase": "PLACEMENT",
    "board": { /* board state */ },
    "currentPlayer": "p1",
    "dice": [4, 3],
    "log": ["Nick placed a settlement.", "Alice rolled 7."]
  }
}
```

### `UPDATE_PLAYER`

Sent when the game wants to update a specific player's private view.
HOST forwards only to the target player's phone.

```json
{
  "type": "UPDATE_PLAYER",
  "to": "player:p1",
  "payload": {
    // Arbitrary game-defined object. The player/hand.html script receives
    // this and is responsible for rendering the player's private state.
    "hand": ["wood", "wood", "brick", "wheat"],
    "availableActions": ["PLACE_SETTLEMENT", "END_TURN"],
    "victoryPoints": 4,
    "isMyTurn": true,
    "mustDiscard": false
  }
}
```

### `UPDATE_ALL_PLAYERS`

Sent when the game wants to send the same update to all players at once.
Useful for broadcasting phase changes, turn order announcements, etc.

```json
{
  "type": "UPDATE_ALL_PLAYERS",
  "payload": {
    "phase": "GAME_OVER",
    "winner": "p2",
    "scores": { "p1": 8, "p2": 10, "p3": 7 }
  }
}
```

### `GAME_STARTED`

Emitted by the game server to signal that the game has officially begun.
HOST broadcasts to BOARD and all PLAYERs.

```json
{
  "type": "GAME_STARTED",
  "payload": {
    "playerOrder": ["p2", "p1", "p3"],
    "firstPlayer": "p2"
  }
}
```

### `GAME_OVER`

Emitted when the game ends. HOST broadcasts to BOARD and all PLAYERs.
HOST also triggers post-game UI (scoreboard, play-again option).

```json
{
  "type": "GAME_OVER",
  "payload": {
    "winner": "p1",          // playerId, or null for a draw
    "winners": ["p1"],       // for multi-winner games
    "scores": { "p1": 10, "p2": 7 },
    "reason": "victory_points" // game-defined reason string
  }
}
```

### `SAVE_STATE_RESPONSE`

Reply to a `SAVE_STATE_REQUEST`. Must be JSON-serializable.

```json
{
  "type": "SAVE_STATE_RESPONSE",
  "payload": {
    "state": {
      // Arbitrary JSON — whatever the game needs to resume
      "board": { /* ... */ },
      "playerHands": { /* ... */ },
      "turnIndex": 2,
      "phase": "MAIN"
    }
  }
}
```

### `ERROR`

Emitted by the game when it encounters an unrecoverable error.
HOST logs it and shows an error screen.

```json
{
  "type": "ERROR",
  "payload": {
    "code": "INVALID_STATE",
    "message": "Attempted to place settlement with insufficient resources.",
    "fatal": false
    // fatal: true causes the platform to abort the game session
  }
}
```

### `TOAST`

Emitted to show a brief notification on board or player screen(s).

```json
{
  "type": "TOAST",
  "to": "board",             // "board" | "player:p1" | "all_players"
  "payload": {
    "message": "Nick rolled a 7! Robber time.",
    "duration": 3000,        // ms, default 3000
    "style": "warning"       // "info" | "success" | "warning" | "error"
  }
}
```

### `PLAY_AUDIO`

Emitted to trigger a preloaded audio clip.

```json
{
  "type": "PLAY_AUDIO",
  "to": "board",             // "board" | "player:p1" | "all_players"
  "payload": {
    "clip": "roll",          // key matching filename without extension
    "volume": 0.8            // 0.0–1.0, default 1.0
  }
}
```

---

## PLAYER → HOST Events

These are sent from a player's phone browser to the HOST WebSocket.

### `JOIN_REQUEST`

Sent when a player's browser first connects to the host.

```json
{
  "type": "JOIN_REQUEST",
  "payload": {
    "name": "Nick",
    "preferredId": "p1"
    // preferredId is used for reconnection — phone stores its assigned ID
    // in sessionStorage and sends it back on reconnect. HOST validates it.
  }
}
```

### `PLAYER_ACTION`

The primary event for gameplay input.

```json
{
  "type": "PLAYER_ACTION",
  "payload": {
    "action": "PLACE_SETTLEMENT",
    "data": { "hex": "3,2", "vertex": 1 }
  }
}
```

The `action` string and `data` shape are entirely game-defined. The platform
routes this to the game server verbatim (as `PLAYER_ACTION` with `from: "player:pN"`).

### `READY`

Sent from player phone when the player is ready to start (e.g. presses "Ready" in lobby).

```json
{
  "type": "READY",
  "payload": {}
}
```

### `REQUEST_REJOIN`

Sent if a player's phone reconnects mid-game.

```json
{
  "type": "REQUEST_REJOIN",
  "payload": {
    "playerId": "p1"
  }
}
```

HOST verifies the player ID, then sends `PLAYER_CONNECTED` (with `isReconnect: true`) to the game, and the game should reply with a fresh `UPDATE_PLAYER` to restore the player's state.

---

## BOARD → HOST Events

### `BOARD_ACTION`

Sent when a touch/click event on the board should be treated as game input.
Only active when `touchBoard: true` in the manifest.

```json
{
  "type": "BOARD_ACTION",
  "payload": {
    "action": "TILE_TAPPED",
    "data": { "hex": "3,2" }
  }
}
```

### `BOARD_READY`

Sent when the board HTML has loaded and initialized, ready to receive state.

```json
{
  "type": "BOARD_READY",
  "payload": {}
}
```

---

## HOST → BOARD Events

### `BOARD_INIT`

Sent once after `BOARD_READY` is received. Provides initial configuration.

```json
{
  "type": "BOARD_INIT",
  "payload": {
    "players": [
      { "id": "p1", "name": "Nick", "index": 0 },
      { "id": "p2", "name": "Alice", "index": 1 }
    ],
    "settings": { /* same settings as GAME_INIT */ },
    "gameName": "Settlers of Example",
    "locale": "en"
  }
}
```

### `UPDATE_BOARD`

Forwarded from GAME → HOST → BOARD unchanged (see above).

### `PLAYER_CONNECTED` / `PLAYER_DISCONNECTED`

Forwarded to BOARD so it can show connection status indicators.

### `GAME_STARTED` / `GAME_OVER`

Forwarded to BOARD from GAME.

### `TOAST` / `PLAY_AUDIO`

Forwarded to BOARD if `to` is `"board"` or `"all"`.

---

## HOST → PLAYER Events

### `PLAYER_JOIN`

Sent to a player's phone immediately after a successful `JOIN_REQUEST`.

```json
{
  "type": "PLAYER_JOIN",
  "payload": {
    "playerId": "p1",
    "playerIndex": 0,
    "playerName": "Nick",
    "gameName": "Settlers of Example",
    "gameId": "com.nickgames.catan",
    "playerCount": 3,
    "locale": "en",
    "status": "lobby"
    // status: "lobby" | "in_progress" (for reconnects)
  }
}
```

### `JOIN_REJECTED`

Sent if `JOIN_REQUEST` fails (game full, invalid reconnect ID, etc.).

```json
{
  "type": "JOIN_REJECTED",
  "payload": {
    "reason": "game_full"
    // reason: "game_full" | "already_started" | "invalid_id" | "banned"
  }
}
```

### `UPDATE_PLAYER`

Forwarded from GAME → HOST → target PLAYER unchanged.

### `UPDATE_ALL_PLAYERS`

Sent to every connected player (forwarded from GAME).

### `GAME_STARTED` / `GAME_OVER`

Forwarded to all players from GAME.

### `TOAST` / `PLAY_AUDIO`

Forwarded to target player(s) if `to` matches.

### `LOBBY_STATE`

Sent by HOST (not game) to all connected clients when lobby state changes
(player joins, player readies up, etc.).

```json
{
  "type": "LOBBY_STATE",
  "payload": {
    "players": [
      { "id": "p1", "name": "Nick", "ready": true },
      { "id": "p2", "name": "Alice", "ready": false }
    ],
    "minPlayers": 3,
    "maxPlayers": 5,
    "canStart": false
  }
}
```

---

## Game Context API (for `server/game.js`)

The game script does not import Node.js modules or open network connections.
Instead, the sandbox provides a `GameContext` global object:

```js
// Available as a global: ctx

ctx.on(eventType, handler)
// Subscribe to an event from the HOST (GAME_INIT, PLAYER_ACTION, etc.)
// handler receives: (payload, meta) where meta = { from, seq }

ctx.emit(eventType, payload, to)
// Emit an event to HOST for routing.
// to: "board" | "all_players" | "player:p1" | undefined (host only)

ctx.log(message)
// Write to the platform's game log (visible in host debug panel).

ctx.random()
// Cryptographically seeded PRNG — use this instead of Math.random()
// for reproducible/auditable randomness.
// Returns: float [0, 1)

ctx.randomInt(min, max)
// Inclusive random integer between min and max.

ctx.shuffle(array)
// Returns a new shuffled array using ctx.random().

ctx.getPlayers()
// Returns: [{ id, name, index, connected }]

ctx.getSettings()
// Returns: the settings object from GAME_INIT.

ctx.timer(ms, callbackEventType, callbackPayload)
// Schedule a one-shot timer. When it fires, HOST sends an event of
// callbackEventType to the game. Returns a timerId.
// Use this instead of setTimeout (which is not available in sandbox).

ctx.clearTimer(timerId)
// Cancel a pending timer.
```

### Minimal `server/game.js` Example

```js
let state = {};

ctx.on('GAME_INIT', (payload) => {
  const players = payload.players;
  state = {
    players: players.map(p => ({ ...p, score: 0 })),
    currentTurn: 0,
    phase: 'WAITING'
  };
  ctx.emit('GAME_READY', { waitingFor: 'players' });
});

ctx.on('PLAYER_CONNECTED', (payload) => {
  const allConnected = ctx.getPlayers().every(p => p.connected);
  if (allConnected && state.phase === 'WAITING') {
    state.phase = 'PLAYING';
    ctx.emit('GAME_STARTED', { firstPlayer: state.players[0].id });
    broadcastState();
  }
});

ctx.on('PLAYER_ACTION', (payload, meta) => {
  const playerId = meta.from.replace('player:', '');
  if (payload.action === 'END_TURN') {
    state.currentTurn = (state.currentTurn + 1) % state.players.length;
    broadcastState();
  }
});

function broadcastState() {
  ctx.emit('UPDATE_BOARD', {
    currentTurn: state.currentTurn,
    phase: state.phase,
    scores: state.players.map(p => ({ id: p.id, score: p.score }))
  });
  state.players.forEach((p, i) => {
    ctx.emit('UPDATE_PLAYER', {
      isMyTurn: state.currentTurn === i,
      score: p.score,
      availableActions: state.currentTurn === i ? ['END_TURN'] : []
    }, `player:${p.id}`);
  });
}

ctx.on('SAVE_STATE_REQUEST', () => {
  ctx.emit('SAVE_STATE_RESPONSE', { state });
});
```

---

## Board/Player postMessage API

Inside `board.html` and `player/hand.html`, scripts communicate with the platform shell
via `window.parent.postMessage` (outbound) and `window.addEventListener('message', ...)` (inbound).

The platform shell proxies these to/from the WebSocket layer.

### Inbound (platform → iframe)

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'null') return; // iframes have null origin
  const { type, payload } = event.data;
  // handle type: UPDATE_BOARD, BOARD_INIT, GAME_STARTED, GAME_OVER, TOAST, etc.
});
```

### Outbound (iframe → platform)

```js
// From board.html only:
window.parent.postMessage({ type: 'BOARD_READY', payload: {} }, '*');
window.parent.postMessage({ type: 'BOARD_ACTION', payload: { action: 'TILE_TAPPED', data: { hex: '3,2' } } }, '*');

// From player/hand.html only:
window.parent.postMessage({ type: 'PLAYER_ACTION', payload: { action: 'END_TURN', data: {} } }, '*');
```

### Platform Helper Object (injected into iframes)

The platform shell injects a `window.platform` helper object into each iframe:

```js
window.platform = {
  // Send an action (player iframe only)
  sendAction(action, data) { ... },

  // Play a preloaded audio clip
  playAudio(clip, volume) { ... },

  // Translate a locale key (if locale strings are configured)
  t(key, vars) { ... },

  // Player identity (player iframe only)
  playerId: "p1",
  playerName: "Nick",
  playerIndex: 0,

  // Subscribe to a specific event type
  on(type, handler) { ... },

  // One-time subscription
  once(type, handler) { ... }
};
```

Usage inside `player/hand.html`:

```js
// Wait for platform to be ready
window.platform.once('PLATFORM_INIT', () => {
  console.log('My player ID:', window.platform.playerId);
});

window.platform.on('UPDATE_PLAYER', (payload) => {
  renderHand(payload.hand);
  renderActions(payload.availableActions);
});

document.getElementById('end-turn-btn').addEventListener('click', () => {
  window.platform.sendAction('END_TURN', {});
});
```

---

## Event Routing Table (Quick Reference)

| Event | Origin | Destination | Notes |
| --- | --- | --- | --- |
| `GAME_INIT` | HOST | GAME | Once on game start |
| `RESTORE_STATE` | HOST | GAME | Only if persistState + saved state exists |
| `PLAYER_CONNECTED` | HOST | GAME, BOARD | On connect/reconnect |
| `PLAYER_DISCONNECTED` | HOST | GAME, BOARD | On drop |
| `PLAYER_ACTION` | PLAYER → HOST | GAME | Includes `from` meta |
| `BOARD_ACTION` | BOARD → HOST | GAME | Only if touchBoard: true |
| `SAVE_STATE_REQUEST` | HOST | GAME | On autosave/quit |
| `GAME_READY` | GAME | HOST | HOST holds player msgs until received |
| `UPDATE_BOARD` | GAME | HOST → BOARD | Full board state refresh |
| `UPDATE_PLAYER` | GAME | HOST → PLAYER[n] | Private player state |
| `UPDATE_ALL_PLAYERS` | GAME | HOST → all PLAYERs | Broadcast to phones |
| `GAME_STARTED` | GAME | HOST → BOARD, all PLAYERs | |
| `GAME_OVER` | GAME | HOST → BOARD, all PLAYERs | |
| `SAVE_STATE_RESPONSE` | GAME | HOST | HOST persists to disk |
| `ERROR` | GAME | HOST | HOST decides recovery |
| `TOAST` | GAME | HOST → target | |
| `PLAY_AUDIO` | GAME | HOST → target | |
| `JOIN_REQUEST` | PLAYER | HOST | Handled by HOST only |
| `PLAYER_JOIN` | HOST | PLAYER | Sent back to joining player |
| `LOBBY_STATE` | HOST | BOARD, all PLAYERs | HOST-managed lobby |
| `BOARD_INIT` | HOST | BOARD | After BOARD_READY |
| `BOARD_READY` | BOARD | HOST | Board signals readiness |
