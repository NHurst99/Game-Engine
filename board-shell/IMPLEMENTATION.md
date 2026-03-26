# Board Shell — Implementation Guide

**Location:** `board-shell/`
**Runs in:** Electron BrowserWindow on the TV/monitor
**Responsibility:** Platform chrome around the game's board display. Handles the pre-game lobby, connection status, QR code display, and hosts the game's `board.html` in a sandboxed iframe.

---

## What the Board Shell Is (and Isn't)

The board shell is **not** the game's board UI. It's the container that:

- Shows the join QR code before the game starts
- Shows connected players in the lobby
- Hosts `board.html` from the pack in a sandboxed `<iframe>`
- Overlays connection status indicators during the game
- Shows game-over/scoreboard screens

The game's `board.html` renders the actual board (tiles, tokens, cards) inside the iframe.

---

## File Structure

```text
board-shell/src/
├── index.html       ← Loaded by Electron BrowserWindow
├── shell.js         ← Platform logic: IPC bridge, iframe lifecycle, lobby
└── overlay.css      ← Platform chrome styles (should NOT conflict with game CSS)
```

---

## `index.html`

Minimal structure — the shell does as little visual work as possible during gameplay so the game's board iframe can fill the screen.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BoardGame Platform</title>
  <link rel="stylesheet" href="overlay.css">
</head>
<body>
  <!-- Lobby screen (shown before game starts) -->
  <div id="lobby" class="screen active">
    <div id="lobby-game-name"></div>
    <div id="lobby-qr-container">
      <img id="lobby-qr" src="" alt="Scan to join">
      <div id="lobby-join-url"></div>
    </div>
    <div id="lobby-players"></div>
    <button id="lobby-start-btn" disabled>Start Game</button>
  </div>

  <!-- Settings screen (shown if pack has settings entry point) -->
  <div id="settings-screen" class="screen">
    <iframe id="settings-frame" sandbox="allow-scripts"></iframe>
    <button id="settings-confirm-btn">Confirm Settings</button>
  </div>

  <!-- Game screen (shown during gameplay) -->
  <div id="game-screen" class="screen">
    <iframe
      id="board-frame"
      sandbox="allow-scripts allow-same-origin"
      allowfullscreen
    ></iframe>

    <!-- Overlay elements rendered ON TOP of the iframe -->
    <div id="connection-indicator"></div>
    <div id="player-status-bar"></div>
    <div id="toast-container"></div>
  </div>

  <!-- Game over screen -->
  <div id="gameover-screen" class="screen">
    <div id="gameover-winner"></div>
    <div id="gameover-scores"></div>
    <button id="play-again-btn">Play Again</button>
    <button id="quit-btn">Quit</button>
  </div>

  <script src="shell.js"></script>
</body>
</html>
```

---

## `shell.js`

### Responsibilities

1. Receive platform events from Electron main process via `window.__ipc` (injected by preload.js)
2. Manage screen transitions (lobby → settings → game → gameover)
3. Mount game `board.html` in the iframe at the right time
4. Bridge messages between iframe (postMessage) and Electron IPC
5. Render lobby state, connection status, toasts

### IPC Bridge Setup

The Electron preload injects `window.__ipc`:

```js
// preload.js (in host/src/preload.js)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__ipc', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, callback) => ipcRenderer.on(channel, (event, data) => callback(data)),
  once: (channel, callback) => ipcRenderer.once(channel, (event, data) => callback(data))
});
```

In `shell.js`:

```js
const ipc = window.__ipc;

// Receive platform messages (routed from WebSocket hub)
ipc.on('platform:message', (msg) => {
  handlePlatformMessage(msg);
});

// Send events back to host (for BOARD_ACTION, BOARD_READY)
function sendToHost(type, payload) {
  ipc.send('platform:send', { type, payload });
}
```

### Screen Management

```js
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
```

### Lobby Rendering

```js
ipc.on('platform:message', (msg) => {
  if (msg.type === 'LOBBY_STATE') {
    const { players, canStart, minPlayers } = msg.payload;

    const playerList = document.getElementById('lobby-players');
    playerList.innerHTML = players.map(p => `
      <div class="player-slot ${p.ready ? 'ready' : ''}">
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-status">${p.ready ? '✓ Ready' : 'Waiting...'}</span>
      </div>
    `).join('');

    // Fill empty slots up to minPlayers
    for (let i = players.length; i < minPlayers; i++) {
      playerList.innerHTML += `<div class="player-slot empty">Waiting for player...</div>`;
    }

    document.getElementById('lobby-start-btn').disabled = !canStart;
  }
});

ipc.on('platform:show-qr', ({ url, qr }) => {
  document.getElementById('lobby-qr').src = qr;
  document.getElementById('lobby-join-url').textContent = url;
});
```

### Start Button

```js
document.getElementById('lobby-start-btn').addEventListener('click', () => {
  ipc.send('platform:send', { type: 'HOST_START_GAME', payload: {} });
});
```

`HOST_START_GAME` is a host-internal event (never sent to game). The host uses it to trigger `GAME_INIT`.

### Game Frame Lifecycle

```js
function mountBoardFrame(boardHtmlPath) {
  const frame = document.getElementById('board-frame');
  frame.src = boardHtmlPath;  // Local file URL to pack's board.html

  frame.onload = () => {
    // Frame is loaded. Send BOARD_INIT via postMessage.
    // The host sends BOARD_INIT payload via IPC, which shell forwards to frame.
    // Wait for BOARD_READY from frame first.
  };
}

// Route messages from iframe → host
window.addEventListener('message', (event) => {
  // Only accept from our iframe
  if (event.source !== document.getElementById('board-frame').contentWindow) return;
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'BOARD_READY') {
    sendToHost('BOARD_READY', {});
    return;
  }
  if (msg.type === 'BOARD_ACTION') {
    sendToHost('BOARD_ACTION', msg.payload);
    return;
  }
});

// Route messages from host → iframe
ipc.on('platform:message', (msg) => {
  const framesToForward = ['UPDATE_BOARD', 'BOARD_INIT', 'GAME_STARTED', 'GAME_OVER',
                           'PLAYER_CONNECTED', 'PLAYER_DISCONNECTED', 'TOAST', 'PLAY_AUDIO'];
  if (framesToForward.includes(msg.type)) {
    const frame = document.getElementById('board-frame');
    frame.contentWindow?.postMessage(msg, '*');
  }
});
```

### `window.platform` Injection

After the board frame loads, inject the helper object. Since the iframe is a local file (same origin in Electron), you can set properties on its `contentWindow` directly — but use postMessage for consistency and to match the phone client behavior.

The frame calls `window.parent.postMessage` for outbound messages, and `window.addEventListener('message')` for inbound. This is already handled by the routing above.

However, you should inject `window.platform` into the board iframe via a script tag OR via the preload chain. The simplest approach: the pack's `board.html` includes a `<script>` that sets up the `window.platform` helper based on postMessage events. Provide a platform SDK script that pack authors can include:

```html
<!-- In board.html -->
<script src="/platform-sdk.js"></script>
```

The host serves `platform-sdk.js` from the shell:

```text
GET /platform-sdk.js  →  board-shell/src/platform-sdk.js
```

See the Platform SDK section in `DOCS/GAME_PACK_AUTHORING.md`.

### Toast Rendering

```js
ipc.on('platform:message', (msg) => {
  if (msg.type === 'TOAST' && (msg.to === 'board' || msg.to === undefined)) {
    showToast(msg.payload.message, msg.payload.style, msg.payload.duration);
  }
});

function showToast(message, style = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${style}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration + 300); // +300 for fade out
}
```

### Audio

Audio clips are preloaded by the shell based on `manifest.assets.audio.preload`. The shell creates `Audio` objects keyed by filename (without extension):

```js
const audioCache = {};

function preloadAudio(clips, packDir) {
  for (const clipPath of clips) {
    const key = path.basename(clipPath, path.extname(clipPath));
    const audio = new Audio(`game/${clipPath}`);
    audio.preload = 'auto';
    audioCache[key] = audio;
  }
}

ipc.on('platform:message', (msg) => {
  if (msg.type === 'PLAY_AUDIO' && (msg.to === 'board' || !msg.to)) {
    const clip = audioCache[msg.payload.clip];
    if (clip) {
      clip.volume = msg.payload.volume ?? 1.0;
      clip.currentTime = 0;
      clip.play().catch(() => {}); // Ignore autoplay policy errors
    }
  }
});
```

### Player Status Bar

Show a thin indicator bar at the edge of the screen showing which players are connected.

```js
ipc.on('platform:message', (msg) => {
  if (msg.type === 'PLAYER_CONNECTED' || msg.type === 'PLAYER_DISCONNECTED') {
    updatePlayerStatusBar();
  }
});
```

Keep this bar subtle — a row of small colored dots. It should never obscure the game.

### Game Over

```js
ipc.on('platform:message', (msg) => {
  if (msg.type === 'GAME_OVER') {
    const { winner, scores } = msg.payload;
    document.getElementById('gameover-winner').textContent =
      winner ? `${getPlayerName(winner)} wins!` : 'Draw!';
    // Render scores...
    showScreen('gameover-screen');
  }
});

document.getElementById('play-again-btn').addEventListener('click', () => {
  ipc.send('platform:send', { type: 'HOST_RESTART_GAME', payload: {} });
});
document.getElementById('quit-btn').addEventListener('click', () => {
  ipc.send('platform:send', { type: 'HOST_QUIT_GAME', payload: {} });
});
```

---

## `overlay.css`

Key constraints:

- Use a CSS namespace prefix (`#board-shell-*`, `.bgs-*`) to avoid any collision with game CSS.
- The `#game-screen` must be `position: relative; width: 100vw; height: 100vh`.
- The `#board-frame` inside it must be `position: absolute; inset: 0; width: 100%; height: 100%; border: none`.
- Overlay elements (toast, status bar) must use `position: absolute; z-index: 9999`.
- The shell should use a dark, unobtrusive style — the game's board is the star.

---

## Fullscreen and DPI

The Electron window should launch fullscreen. Set:

```js
// In host/src/main.js
const win = new BrowserWindow({
  fullscreen: true,
  autoHideMenuBar: true,
  backgroundColor: '#000000', // Prevent white flash on load
});
```

For HiDPI displays, the board iframe will automatically scale with the window. No special handling needed.
