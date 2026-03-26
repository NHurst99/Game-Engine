# Game Pack Authoring Guide

This guide is for people who want to **create a game** for the BoardGame Platform. You do not need to understand the platform internals — just follow this guide.

---

## What You're Building

A `.boardgame` file is a ZIP archive with a specific structure. When loaded by the platform, your game gets:

- A TV/monitor displaying your `board.html`
- Each player's phone displaying your `player/hand.html`
- Your `server/game.js` running as the authoritative game brain

---

## Minimal Pack Structure

```text
my-game/
├── manifest.json       ← Required. Describes your game.
├── server/
│   └── game.js         ← Required. Authoritative game logic.
├── board/
│   └── board.html      ← Required. TV display.
└── player/
    └── hand.html       ← Required. Phone display.
```

To distribute: ZIP the contents (not the folder) and rename to `my-game.boardgame`.

On macOS/Linux: `cd my-game && zip -r ../my-game.boardgame .`
On Windows: Select all files inside `my-game/`, right-click → Send to → Compressed folder. Rename `.zip` to `.boardgame`.

---

## Step 1: `manifest.json`

See `DOCS/MANIFEST_SPEC.md` for the full schema. Minimum:

```json
{
  "id": "com.yourname.mygame",
  "name": "My Game",
  "version": "1.0.0",
  "players": { "min": 2, "max": 4 },
  "entry": {
    "server": "server/game.js",
    "board": "board/board.html",
    "player": "player/hand.html"
  }
}
```

**Choosing your `id`:** Use reverse-domain notation. It doesn't need to be a real domain. Examples: `com.nick.trivia`, `io.github.username.chess`. Once you publish a pack, don't change the ID — it's used for saved state.

---

## Step 2: `server/game.js` — Game Logic

Your game script runs in a sandboxed environment. It has access to one global object: `ctx`.

```js
// server/game.js

// Your game state — any plain JS object
let state = {};

// Called once when the game initializes
ctx.on('GAME_INIT', (payload) => {
  const { players, settings } = payload;
  
  state = {
    players: players.map(p => ({ id: p.id, name: p.name, score: 0 })),
    currentPlayerIndex: 0,
    phase: 'waiting'
  };

  // Signal ready — the platform waits for this before sending player events
  ctx.emit('GAME_READY', { waitingFor: 'players' });
});

// Called when enough players connect
ctx.on('PLAYER_CONNECTED', (payload) => {
  const allConnected = ctx.getPlayers().every(p => p.connected);
  if (allConnected && state.phase === 'waiting') {
    startGame();
  }
});

// Called when a player does something
ctx.on('PLAYER_ACTION', (payload, meta) => {
  const playerId = meta.from.replace('player:', '');
  const { action, data } = payload;

  if (action === 'END_TURN') {
    nextTurn();
  }
  // Handle your game-specific actions here
});

function startGame() {
  state.phase = 'playing';
  ctx.emit('GAME_STARTED', { firstPlayer: state.players[0].id });
  syncAll();
}

function nextTurn() {
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  syncAll();
}

// Push state to all displays
function syncAll() {
  const currentPlayer = state.players[state.currentPlayerIndex];

  // Update the TV board display
  ctx.emit('UPDATE_BOARD', {
    currentPlayerName: currentPlayer.name,
    phase: state.phase,
    scores: state.players.map(p => ({ name: p.name, score: p.score }))
  }, 'board');

  // Update each player's phone
  state.players.forEach((p, i) => {
    ctx.emit('UPDATE_PLAYER', {
      isMyTurn: i === state.currentPlayerIndex,
      score: p.score,
      actions: i === state.currentPlayerIndex ? ['END_TURN'] : []
    }, `player:${p.id}`);
  });
}
```

### `ctx` Reference

| Method | Description |
| --- | --- |
| `ctx.on(type, fn)` | Listen for events from the platform |
| `ctx.emit(type, payload, to)` | Send events to the platform |
| `ctx.log(msg)` | Write to the debug log |
| `ctx.random()` | Random float [0,1) — use this, not Math.random() |
| `ctx.randomInt(min, max)` | Random integer, inclusive |
| `ctx.shuffle(array)` | Returns a new shuffled copy |
| `ctx.getPlayers()` | Returns `[{ id, name, index, connected }]` |
| `ctx.getSettings()` | Returns settings from the settings screen |
| `ctx.timer(ms, eventType, payload)` | Schedule a future event, returns timerId |
| `ctx.clearTimer(id)` | Cancel a timer |

### Events Your Script Receives

| Event | When |
| --- | --- |
| `GAME_INIT` | Game is starting. Initialize your state here. |
| `RESTORE_STATE` | A saved state exists (if `persistState: true` in manifest). Restore it. |
| `PLAYER_CONNECTED` | A player's phone connected (or reconnected). |
| `PLAYER_DISCONNECTED` | A player's phone dropped. |
| `PLAYER_ACTION` | A player did something. `meta.from` = `"player:p1"` etc. |
| `BOARD_ACTION` | The TV board was touched (if `touchBoard: true` in manifest). |
| `SAVE_STATE_REQUEST` | Platform wants to save. Respond with `SAVE_STATE_RESPONSE`. |

### Events Your Script Can Send

| Event | Effect |
| --- | --- |
| `GAME_READY` | Required. Tells platform you're initialized. |
| `UPDATE_BOARD` | Refreshes the TV display. |
| `UPDATE_PLAYER` | Refreshes one player's phone. Requires `to: "player:p1"`. |
| `UPDATE_ALL_PLAYERS` | Sends same update to all phones. |
| `GAME_STARTED` | Tells the platform the game has begun. |
| `GAME_OVER` | Ends the game. Platform shows scoreboard. |
| `SAVE_STATE_RESPONSE` | Reply to save request. |
| `TOAST` | Show a notification on a display. |
| `PLAY_AUDIO` | Play a preloaded audio clip. |
| `ERROR` | Report an error. `fatal: true` ends the session. |

---

## Step 3: `board/board.html` — TV Display

This is a standard HTML page. It fills the TV screen. You have full canvas, CSS, and DOM access.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>My Game Board</title>
  <script src="/platform-sdk.js"></script>
  <style>
    body { margin: 0; background: #1a1a2e; color: white; font-family: sans-serif; }
    #board { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div id="board">
    <div id="status">Waiting for players...</div>
  </div>
  <script>
    // Wait for platform to be ready
    window.platform.on('BOARD_INIT', (payload) => {
      console.log('Players:', payload.players);
    });

    // Update display when game state changes
    window.platform.on('UPDATE_BOARD', (payload) => {
      document.getElementById('status').textContent =
        `${payload.currentPlayerName}'s turn`;
      
      // Render your board here
    });

    window.platform.on('GAME_OVER', (payload) => {
      document.getElementById('status').textContent = 
        `Game over! Winner: ${payload.winner}`;
    });

    // Signal that we're loaded
    window.parent.postMessage({ type: 'BOARD_READY', payload: {} }, '*');
  </script>
</body>
</html>
```

### Platform SDK (`window.platform`)

Include `<script src="/platform-sdk.js"></script>` in your HTML. This gives you:

```js
window.platform.on(eventType, handler)    // Subscribe to platform events
window.platform.once(eventType, handler)  // One-time subscription
window.platform.playAudio(clip, volume)   // Play a preloaded audio clip
window.platform.t(key)                    // Get a locale string
```

### Board Touch Events (optional)

If `touchBoard: true` in manifest:

```js
document.getElementById('some-tile').addEventListener('click', (e) => {
  window.parent.postMessage({
    type: 'BOARD_ACTION',
    payload: { action: 'TILE_TAPPED', data: { tileId: 'hex-3-2' } }
  }, '*');
});
```

### CSS Notes

- Your CSS is fully isolated from the platform shell (you're in an iframe).
- Assume the board fills `100vw × 100vh`. Design for landscape 1920×1080 as a baseline.
- Use `vw`/`vh` units so it scales to any TV resolution.

---

## Step 4: `player/hand.html` — Phone Display

Same structure as board.html, but designed for a small vertical screen.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>My Game</title>
  <script src="/platform-sdk.js"></script>
  <style>
    body {
      margin: 0;
      background: #0f0f1a;
      color: white;
      font-family: sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    #hand { flex: 1; overflow-y: auto; padding: 16px; }
    #actions { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    button {
      width: 100%;
      padding: 14px;
      font-size: 16px;
      border-radius: 8px;
      border: none;
      background: #3b82f6;
      color: white;
      cursor: pointer;
    }
    button:disabled { background: #374151; color: #9ca3af; }
  </style>
</head>
<body>
  <div id="hand">
    <div id="turn-indicator">Waiting...</div>
    <div id="hand-cards"></div>
  </div>
  <div id="actions">
    <!-- Action buttons rendered dynamically -->
  </div>

  <script>
    window.platform.on('PLATFORM_INIT', (payload) => {
      console.log('I am:', payload.playerName);
    });

    window.platform.on('UPDATE_PLAYER', (payload) => {
      const { isMyTurn, actions, hand } = payload;
      
      document.getElementById('turn-indicator').textContent =
        isMyTurn ? "Your turn!" : "Waiting...";

      // Render hand
      const handEl = document.getElementById('hand-cards');
      handEl.innerHTML = (hand || []).map(card =>
        `<div class="card">${card}</div>`
      ).join('');

      // Render action buttons
      const actionsEl = document.getElementById('actions');
      actionsEl.innerHTML = (actions || []).map(action =>
        `<button onclick="doAction('${action}')">${formatAction(action)}</button>`
      ).join('');
    });

    function doAction(action, data = {}) {
      window.platform.sendAction(action, data);
    }

    function formatAction(action) {
      // Convert SCREAMING_SNAKE_CASE to "Title Case"
      return action.replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase());
    }
  </script>
</body>
</html>
```

### Player SDK Methods

```js
window.platform.sendAction(action, data)  // Send a PLAYER_ACTION to the game server
window.platform.on(type, handler)         // Subscribe to events from platform
window.platform.once(type, handler)       // One-time
window.platform.playAudio(clip, volume)   // Play audio
window.platform.t(key)                    // Locale string
window.platform.playerId                  // Your player ID (e.g. "p1")
window.platform.playerName               // Your display name
window.platform.playerIndex              // 0-indexed position
```

---

## Adding Assets

Place assets anywhere in your pack folder. Reference them with relative paths from your HTML, or with absolute paths starting at `/game/` from the server root.

```html
<!-- From within board/board.html, image is at assets/board.png -->
<img src="../assets/board.png">

<!-- Or using the server path (works from anywhere) -->
<img src="/game/assets/board.png">
```

### Fonts

Declare in manifest:

```json
"assets": {
  "fonts": [
    { "family": "MyFont", "src": "assets/fonts/MyFont.woff2", "weight": "400" }
  ]
}
```

The platform injects the `@font-face` rule into both board and player HTML before they load.

### Audio

Declare in manifest:

```json
"assets": {
  "audio": { "preload": ["assets/audio/roll.ogg", "assets/audio/win.ogg"] }
}
```

Play via: `window.platform.playAudio('roll')` (use filename without extension as key).

---

## Optional: Custom Lobby Screen

Add `"lobby": "lobby/lobby.html"` to `entry` in your manifest. This replaces the platform's default lobby on the TV. Your lobby HTML receives `LOBBY_STATE` events via postMessage.

You should still render a "Start Game" button that fires:

```js
window.parent.postMessage({ type: 'HOST_START_GAME', payload: {} }, '*');
```

The platform handles this even from your custom lobby iframe.

---

## Optional: Settings Screen

Add `"settings": "settings/settings.html"` to `entry`. Shown on TV after lobby, before game start. When the host confirms settings:

```js
window.parent.postMessage({
  type: 'SETTINGS_CONFIRMED',
  payload: {
    mapSize: 'large',
    enableExpansion: false
  }
}, '*');
```

The payload is passed to your `server/game.js` as `payload.settings` in `GAME_INIT`.

---

## Optional: Save/Restore State

In manifest: `"capabilities": { "persistState": true }`

In `server/game.js`:

```js
ctx.on('SAVE_STATE_REQUEST', () => {
  ctx.emit('SAVE_STATE_RESPONSE', { state: myState });
});

ctx.on('RESTORE_STATE', (payload) => {
  myState = payload.state;
  // Skip fresh init, restore from saved state
  ctx.emit('GAME_READY', { waitingFor: 'players' });
});
```

---

## Testing Your Pack

1. Load the platform and use "Load Pack" to select your pack folder or `.boardgame` file.
2. Open `http://localhost:3000` on your phone (same WiFi).
3. Use browser devtools for your board HTML: in Electron, right-click the board → Inspect Element.
4. Use mobile browser devtools for your player HTML.

Common issues:

- **"GAME_READY not received"**: Your `server/game.js` crashed on load or forgot to call `ctx.emit('GAME_READY', ...)`.
- **"Asset not found"**: Check paths. Assets inside iframes use `/game/` prefix for absolute paths.
- **Players see blank screen**: Check for errors in the browser console. The iframe may have failed to load.
- **Actions not reaching server**: Confirm you're using `window.platform.sendAction()` not `fetch()` or direct WebSocket.

---

## Pack Size Recommendations

| Content | Guideline |
|---|---|
| Total pack | Under 50MB for most games |
| Images | Use WebP or optimized PNG. SVG preferred for simple art. |
| Audio | OGG Vorbis, 128kbps. Keep clips short. |
| Fonts | Subset your fonts. One woff2 file per weight. |
| Game script | Should be under 100KB. If larger, reconsider architecture. |

---

## Security Notes for Authors

- Do not include external `<script src="...">` tags pointing to CDNs. All assets must be in the pack (unless `offlineAssets: false` in manifest — but most hosts will reject external-asset packs).
- Do not store player-identifying data beyond what the platform provides.
- Your `server/game.js` cannot make network requests — this is by design.
