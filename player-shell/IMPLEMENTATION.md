# Player Shell — Implementation Guide

**Location:** `player-shell/`
**Runs in:** Player's phone browser (any mobile browser on local WiFi)
**Responsibility:** Platform chrome on phones. Handles join flow, displays lobby status, hosts the game's `player/hand.html` in a sandboxed iframe, and bridges actions to the WebSocket server.

---

## Key Constraints

- **No install.** Players open a browser, type or scan a URL. Done. No app store, no APK.
- **Any browser.** Target Safari iOS 15+, Chrome Android 90+. Do not assume modern JS features without checking caniuse. Avoid ES2022+ syntax in shell code.
- **Unstable connections.** Mobile WiFi can drop. The shell must handle reconnection gracefully and restore game state.
- **Small screens.** The player shell chrome should be minimal — the game's `hand.html` should dominate the screen.
- **Orientation.** Pack authors choose orientation. The shell should respect the pack's preferred orientation if declared (future manifest field: `"orientation": "portrait" | "landscape"`).

---

## File Structure

```text
player-shell/src/
├── index.html       ← Entry point served to phones
├── shell.js         ← WebSocket client, join flow, iframe lifecycle
└── overlay.css      ← Platform chrome (connection pill, toast)
```

---

## `index.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#1a1a2e">
  <title>BoardGame</title>
  <link rel="stylesheet" href="shell.css">
</head>
<body>
  <!-- Join screen -->
  <div id="join-screen" class="screen active">
    <div id="join-game-name">Connecting...</div>
    <form id="join-form">
      <input
        id="player-name-input"
        type="text"
        placeholder="Your name"
        maxlength="24"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="words"
        spellcheck="false"
      >
      <button type="submit" id="join-btn">Join</button>
    </form>
    <div id="join-status"></div>
  </div>

  <!-- Lobby screen (after joining, before game starts) -->
  <div id="lobby-screen" class="screen">
    <div id="lobby-game-name"></div>
    <div id="lobby-your-name"></div>
    <div id="lobby-players-list"></div>
    <button id="ready-btn">Ready</button>
    <div id="lobby-status">Waiting for all players to ready up...</div>
  </div>

  <!-- Game screen -->
  <div id="game-screen" class="screen">
    <iframe
      id="player-frame"
      sandbox="allow-scripts allow-same-origin"
      allowfullscreen
      style="position:absolute;inset:0;width:100%;height:100%;border:none;"
    ></iframe>

    <!-- Minimal overlay -->
    <div id="connection-pill" class="connected">●</div>
    <div id="toast-container"></div>
  </div>

  <!-- Disconnected overlay (shown on top of game screen during disconnect) -->
  <div id="disconnect-overlay" class="hidden">
    <div>Connection lost. Reconnecting...</div>
    <div id="reconnect-countdown"></div>
  </div>

  <!-- Game over screen -->
  <div id="gameover-screen" class="screen">
    <div id="gameover-message"></div>
    <div id="gameover-score"></div>
  </div>

  <script src="shell.js"></script>
</body>
</html>
```

---

## `shell.js`

### State Management

```js
const state = {
  phase: 'join',         // 'join' | 'lobby' | 'game' | 'gameover' | 'error'
  playerId: null,
  playerName: null,
  playerIndex: null,
  gameName: null,
  gameId: null,
  socket: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  reconnectDelay: 1000,  // ms, doubles each attempt
};
```

### Player ID Persistence

When a player joins and receives their ID, store it in `sessionStorage`:

```js
function savePlayerId(id, name) {
  sessionStorage.setItem('boardgame:playerId', id);
  sessionStorage.setItem('boardgame:playerName', name);
}

function getSavedPlayerId() {
  return sessionStorage.getItem('boardgame:playerId');
}
```

`sessionStorage` persists across page refreshes within the same browser tab but clears when the tab is closed. This is intentional — it prevents stale IDs from carrying over to a different game session.

### Host URL Detection

The join URL contains the host address: `http://192.168.x.x:3000/join`

The WebSocket server is at the same origin. Extract it from `window.location`:

```js
const wsUrl = `ws://${window.location.host}`;
```

### WebSocket Connection

Do not use Socket.io on the client to minimize download size. Use the native WebSocket API:

```js
function connect() {
  state.socket = new WebSocket(wsUrl);

  state.socket.onopen = () => {
    state.reconnectAttempts = 0;
    state.reconnectDelay = 1000;
    hideDisconnectOverlay();

    // If we have a saved player ID, try to rejoin
    const savedId = getSavedPlayerId();
    if (savedId && state.phase !== 'join') {
      send({ type: 'REQUEST_REJOIN', payload: { playerId: savedId } });
    }
  };

  state.socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }
    handleMessage(msg);
  };

  state.socket.onclose = () => {
    updateConnectionPill(false);
    if (state.phase === 'game') {
      showDisconnectOverlay();
      scheduleReconnect();
    }
  };

  state.socket.onerror = () => {
    // onclose will fire after onerror, handle there
  };
}

function send(msg) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(msg));
  }
}
```

**Note on Socket.io:** If the host uses Socket.io, the server defaults to the Socket.io protocol which is NOT compatible with native WebSocket. Either configure Socket.io server with `transports: ['websocket']` and add the Socket.io packet framing, OR use the Socket.io client library on the phone. The Socket.io client is ~12KB gzipped. For a local game app, this is acceptable. Alternatively, use a plain `ws` WebSocket server on the host to avoid the dependency.

**Recommendation:** Use plain `ws` on the host and native WebSocket on the client.

### Message Handlers

```js
function handleMessage(msg) {
  switch (msg.type) {
    case 'PLAYER_JOIN':        return onPlayerJoin(msg.payload);
    case 'JOIN_REJECTED':      return onJoinRejected(msg.payload);
    case 'LOBBY_STATE':        return onLobbyState(msg.payload);
    case 'GAME_STARTED':       return onGameStarted(msg.payload);
    case 'UPDATE_PLAYER':      return forwardToFrame(msg);
    case 'UPDATE_ALL_PLAYERS': return forwardToFrame(msg);
    case 'GAME_OVER':          return onGameOver(msg.payload);
    case 'TOAST':              return showToast(msg.payload);
    case 'PLAY_AUDIO':         return playAudio(msg.payload);
  }
}
```

### Join Flow

```js
document.getElementById('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('player-name-input').value.trim();
  if (!name) return;
  state.playerName = name;
  send({
    type: 'JOIN_REQUEST',
    payload: {
      name,
      preferredId: getSavedPlayerId() || undefined
    }
  });
  document.getElementById('join-btn').disabled = true;
  document.getElementById('join-status').textContent = 'Joining...';
});

function onPlayerJoin(payload) {
  state.playerId = payload.playerId;
  state.playerIndex = payload.playerIndex;
  state.gameName = payload.gameName;
  state.gameId = payload.gameId;

  savePlayerId(payload.playerId, payload.playerName);

  document.getElementById('lobby-game-name').textContent = payload.gameName;
  document.getElementById('lobby-your-name').textContent = `You are: ${payload.playerName}`;

  if (payload.status === 'in_progress') {
    // Rejoin mid-game — skip lobby
    mountPlayerFrame();
    showScreen('game-screen');
    return;
  }

  showScreen('lobby-screen');
  state.phase = 'lobby';
}

function onJoinRejected(payload) {
  const reasons = {
    game_full: 'This game is full.',
    already_started: 'The game has already started.',
    invalid_id: 'Could not reconnect. Please rejoin.',
    banned: 'You have been removed from this game.'
  };
  document.getElementById('join-status').textContent = reasons[payload.reason] || 'Could not join.';
  document.getElementById('join-btn').disabled = false;
}
```

### Ready Button

```js
let isReady = false;
document.getElementById('ready-btn').addEventListener('click', () => {
  if (isReady) return;
  isReady = true;
  send({ type: 'READY', payload: {} });
  document.getElementById('ready-btn').textContent = '✓ Ready!';
  document.getElementById('ready-btn').disabled = true;
});
```

### Lobby State Rendering

```js
function onLobbyState(payload) {
  const list = document.getElementById('lobby-players-list');
  list.innerHTML = payload.players.map(p => `
    <div class="lobby-player ${p.id === state.playerId ? 'you' : ''} ${p.ready ? 'ready' : ''}">
      ${escapeHtml(p.name)} ${p.ready ? '✓' : '…'} ${p.id === state.playerId ? '(You)' : ''}
    </div>
  `).join('');
}
```

### Game Frame Lifecycle

```js
function onGameStarted(payload) {
  state.phase = 'game';
  mountPlayerFrame();
  showScreen('game-screen');
}

function mountPlayerFrame() {
  const frame = document.getElementById('player-frame');
  // Player HTML is served at /game/{entry.player}
  // We don't know the path here — the host should send it in PLAYER_JOIN or GAME_STARTED
  // Add playerHtmlPath to PLAYER_JOIN payload in host implementation
  frame.src = state.playerHtmlPath;

  frame.onload = () => {
    // Inject PLATFORM_INIT into frame
    frame.contentWindow.postMessage({
      type: 'PLATFORM_INIT',
      payload: {
        playerId: state.playerId,
        playerName: state.playerName,
        playerIndex: state.playerIndex,
        gameName: state.gameName,
        gameId: state.gameId,
        locale: state.locale || 'en'
      }
    }, '*');
  };
}

// Route messages from iframe (player actions) → WebSocket
window.addEventListener('message', (event) => {
  const frame = document.getElementById('player-frame');
  if (event.source !== frame?.contentWindow) return;
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'PLAYER_ACTION') {
    send({ type: 'PLAYER_ACTION', payload: msg.payload });
  }
});

// Route messages from WebSocket → iframe
function forwardToFrame(msg) {
  const frame = document.getElementById('player-frame');
  frame?.contentWindow?.postMessage(msg, '*');
}
```

### Reconnection

```js
function scheduleReconnect() {
  if (state.reconnectAttempts >= state.maxReconnectAttempts) {
    document.getElementById('reconnect-countdown').textContent =
      'Could not reconnect. Please refresh the page.';
    return;
  }

  state.reconnectAttempts++;
  const delay = Math.min(state.reconnectDelay * state.reconnectAttempts, 15000);

  let remaining = Math.ceil(delay / 1000);
  const interval = setInterval(() => {
    document.getElementById('reconnect-countdown').textContent =
      `Retrying in ${remaining--}s...`;
    if (remaining < 0) clearInterval(interval);
  }, 1000);

  setTimeout(() => {
    connect();
  }, delay);
}

function updateConnectionPill(connected) {
  const pill = document.getElementById('connection-pill');
  pill.className = connected ? 'connected' : 'disconnected';
  pill.title = connected ? 'Connected' : 'Disconnected';
}
```

### Audio

```js
const audioCache = {};

function preloadAudio(clips) {
  for (const { key, url } of clips) {
    const audio = new Audio(url);
    audio.preload = 'auto';
    audioCache[key] = audio;
  }
}

// Audio clips are sent in PLATFORM_INIT or PLAYER_JOIN payload
// Each clip: { key: "roll", url: "/game/assets/audio/roll.ogg" }

function playAudio({ clip, volume = 1.0 }) {
  const audio = audioCache[clip];
  if (audio) {
    audio.volume = volume;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }
}
```

### Toast

```js
function showToast({ message, style = 'info', duration = 3000 }) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${style}`;
  el.textContent = message;
  container.appendChild(el);
  // Animate in
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, duration);
}
```

---

## `overlay.css` — Key Styles

```css
/* Full bleed layout */
html, body {
  margin: 0; padding: 0;
  width: 100%; height: 100%;
  overflow: hidden;
  background: #1a1a2e;
  color: #fff;
  font-family: system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

/* Screen management */
.screen { display: none; position: absolute; inset: 0; }
.screen.active { display: flex; flex-direction: column; }

#game-screen { display: block; }
#game-screen.active { display: block; }

/* Connection pill — tiny indicator in corner */
#connection-pill {
  position: absolute;
  top: 8px; right: 8px;
  width: 10px; height: 10px;
  border-radius: 50%;
  z-index: 9999;
  pointer-events: none;
  font-size: 0; /* hide text, just use background color */
}
#connection-pill.connected { background: #22c55e; }
#connection-pill.disconnected { background: #ef4444; }

/* Toast */
#toast-container {
  position: absolute;
  bottom: 20px; left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex; flex-direction: column; gap: 8px;
  pointer-events: none;
}
.toast {
  background: rgba(0,0,0,0.85);
  color: #fff;
  padding: 10px 18px;
  border-radius: 20px;
  font-size: 14px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.2s, transform 0.2s;
  white-space: nowrap;
}
.toast.visible { opacity: 1; transform: translateY(0); }
.toast-warning { border-left: 3px solid #f59e0b; }
.toast-error { border-left: 3px solid #ef4444; }
.toast-success { border-left: 3px solid #22c55e; }

/* Disconnect overlay */
#disconnect-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.75);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  z-index: 99999;
  font-size: 18px;
  gap: 16px;
}
#disconnect-overlay.hidden { display: none; }

/* Touch targets: minimum 44x44px per Apple HIG */
button {
  min-height: 44px;
  min-width: 44px;
}
```

---

## Player HTML Path Delivery

The host needs to tell the player shell where to load `player/hand.html` from.
Add `playerHtmlPath` to the `PLAYER_JOIN` payload:

```json
{
  "type": "PLAYER_JOIN",
  "payload": {
    "playerId": "p1",
    ...
    "playerHtmlPath": "/game/player/hand.html",
    "audioClips": [
      { "key": "roll", "url": "/game/assets/audio/roll.ogg" }
    ]
  }
}
```

The express server serves `/game/*` from the extracted pack directory, so this URL will work.

---

## Performance Notes

- Keep `shell.js` under 20KB unminified. Players are on mobile browsers with variable CPU.
- Avoid any JavaScript frameworks in the shell itself. Vanilla JS only.
- The game's `hand.html` can use whatever it wants — that's the pack author's concern.
- Use `passive: true` on touch event listeners where possible.
- Preload audio only after the user has interacted with the page (iOS autoplay policy).
