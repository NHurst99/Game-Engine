# Host App — Implementation Guide

**Location:** `host/`
**Runtime:** Node.js 20+ (via Electron 28+)
**Responsibility:** Central coordinator. Loads game packs, runs the game sandbox, serves player clients, routes all WebSocket messages, manages the board display window.

---

## Technology Choices

| Concern | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** | Single binary, ships Chromium for board view, full Node access |
| WebSocket server | **Socket.io** | Handles reconnection, rooms, namespaces cleanly |
| Pack extraction | **adm-zip** | Pure JS, no native deps, handles ZIP reliably |
| Local HTTP server | **express** | Serve player HTML and assets to phones |
| Network discovery | **bonjour** (mDNS) + QR code | Players find host without typing IPs |
| QR code generation | **qrcode** | Generate joinable QR on TV display |
| Sandbox | **worker_threads** + custom vm | See `game-sandbox/IMPLEMENTATION.md` |

---

## File Structure

```
host/
├── package.json
├── src/
│   ├── main.js              ← Electron entry. Creates windows. Wires everything.
│   ├── packLoader.js        ← Validates + extracts .boardgame files
│   ├── gameRunner.js        ← Manages game sandbox lifecycle
│   ├── socketServer.js      ← WebSocket hub and message router
│   ├── httpServer.js        ← Express server serving player pages
│   ├── networkDiscovery.js  ← mDNS + QR code
│   └── stateStore.js        ← Persist/restore game state to disk
```

---

## `main.js` — Electron Entry Point

### Responsibilities
- Create the main `BrowserWindow` (board display, fullscreen or maximized)
- Initialize all subsystems in order
- Wire IPC between main process and board renderer
- Handle app lifecycle (quit, error, relaunch)

### Startup Sequence

```
1. App ready
2. Create BrowserWindow (blank loading screen)
3. Start httpServer (Express)         → get assigned port
4. Start socketServer (Socket.io)     → attach to httpServer
5. Start networkDiscovery             → advertise on local network
6. Load game pack picker UI into BrowserWindow
   (or auto-load a pack if provided via CLI arg)
7. On pack selected:
   a. packLoader.load(filePath)       → extract + validate
   b. gameRunner.start(packDir)       → spawn sandbox
   c. Load board.html into BrowserWindow
   d. Begin accepting player connections
```

### Key Electron Configuration

```js
const win = new BrowserWindow({
  fullscreen: true,           // TV mode
  frame: false,               // No OS chrome on TV
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,   // Board HTML does NOT get Node access
    preload: path.join(__dirname, 'preload.js')
    // preload.js exposes only: ipcRenderer.send, ipcRenderer.on
  }
});
```

The board HTML is loaded as a local file:
```js
win.loadFile(path.join(packExtractDir, manifest.entry.board));
```

However, the board HTML must NOT have direct Node/IPC access. Use preload.js to inject only `window.__platform` bridge methods.

### IPC Channels (main ↔ board renderer)

| Channel | Direction | Description |
|---|---|---|
| `platform:message` | main → renderer | Forward WS messages to board |
| `platform:send` | renderer → main | Board sends event to host |
| `platform:init` | main → renderer | Board init payload |

---

## `packLoader.js` — Pack Validation and Extraction

### Responsibilities
- Accept a `.boardgame` file path
- Extract to a temp directory: `os.tmpdir()/boardgame-{id}-{timestamp}/`
- Read and validate `manifest.json` against the spec
- Return the validated manifest + extraction path

### Validation Steps (in order)

1. File exists and is readable
2. File is a valid ZIP (attempt open with adm-zip, catch errors)
3. `manifest.json` exists in ZIP root
4. Parse `manifest.json` as JSON (hard fail if invalid)
5. Validate all required fields (see `DOCS/MANIFEST_SPEC.md`)
6. Verify all `entry.*` files exist in the ZIP
7. Check `requires.platformVersion` against current platform version
8. Emit warnings for optional missing assets
9. Extract ZIP to temp dir
10. Return `{ manifest, packDir, warnings }`

### Security Checks

Before extracting, scan all ZIP entries for:
- **Path traversal**: Any entry whose resolved path escapes the temp dir (e.g., `../../etc/passwd`) must throw a hard error and delete the partial extraction.
- **Symlinks**: Reject any ZIP entries that are symbolic links.
- **Executables**: Log a warning if any `.exe`, `.sh`, `.bat`, `.command` files are found. Do not execute them.

```js
// Path traversal check pattern
const extractBase = path.resolve(tmpDir);
for (const entry of zip.getEntries()) {
  const entryPath = path.resolve(tmpDir, entry.entryName);
  if (!entryPath.startsWith(extractBase + path.sep)) {
    throw new Error(`Path traversal detected in pack: ${entry.entryName}`);
  }
}
```

### Cleanup

Register cleanup on:
- App quit (`app.on('before-quit')`)
- Game session end (when a new pack is loaded)
- Electron crash (`process.on('uncaughtException')`)

Use `fs.rm(tmpDir, { recursive: true, force: true })`.

---

## `socketServer.js` — WebSocket Hub

### Responsibilities
- Manage all incoming WebSocket connections (board + players)
- Classify connections (board vs player) and maintain a registry
- Route messages between participants according to `DOCS/SOCKET_API.md`
- Handle lobby state (HOST-managed, not game-managed)

### Setup

```js
const io = new Server(httpServer, {
  cors: { origin: '*' },        // Local network only — CORS doesn't matter
  transports: ['websocket'],    // Skip long-polling for local network perf
  pingTimeout: 10000,
  pingInterval: 5000
});
```

### Connection Registry

```js
const connections = {
  board: null,                  // socket | null
  players: new Map(),           // playerId → { socket, name, ready, connected }
};
```

### Lobby Flow (HOST-managed)

The HOST manages the pre-game lobby independently of the game server. The game server is not spawned until the host explicitly starts the game.

1. Players connect → `JOIN_REQUEST`
2. HOST assigns player IDs (p1, p2, ...), adds to registry
3. HOST sends `PLAYER_JOIN` back to that player
4. HOST sends `LOBBY_STATE` to board and all players (broadcast)
5. All players send `READY` → HOST tracks readiness
6. When all players ready (and >= minPlayers): HOST enables "Start" button on board
7. Host (human at TV) presses Start → HOST spawns game sandbox → sends `GAME_INIT`

### Message Routing

```js
// Incoming from a player
socket.on('message', (msg) => {
  if (msg.type === 'JOIN_REQUEST') return handleJoin(socket, msg);
  if (msg.type === 'READY') return handleReady(socket, msg);
  if (msg.type === 'PLAYER_ACTION') {
    // Forward to game sandbox with `from` injected
    gameRunner.send({ ...msg, from: `player:${playerId}` });
    return;
  }
});

// Incoming from board
boardSocket.on('message', (msg) => {
  if (msg.type === 'BOARD_READY') return handleBoardReady();
  if (msg.type === 'BOARD_ACTION') {
    gameRunner.send({ ...msg, from: 'board' });
    return;
  }
});

// Incoming from game sandbox (via gameRunner event emitter)
gameRunner.on('message', (msg) => {
  routeFromGame(msg);
});
```

### `routeFromGame(msg)`

```js
function routeFromGame(msg) {
  switch (msg.to) {
    case 'board':
      boardSocket?.emit('message', msg);
      break;
    case 'all_players':
      for (const { socket } of connections.players.values()) {
        socket?.emit('message', msg);
      }
      break;
    default:
      if (msg.to?.startsWith('player:')) {
        const id = msg.to.replace('player:', '');
        connections.players.get(id)?.socket?.emit('message', msg);
      }
      // If to is undefined, it's a host-internal event (ERROR, SAVE_STATE_RESPONSE, etc.)
      handleHostEvent(msg);
  }
}
```

### Reconnection Handling

When a player reconnects (sends `REQUEST_REJOIN` with stored `playerId`):
1. Validate `playerId` exists in registry
2. Reassign socket to existing player entry
3. Mark player as `connected: true`
4. Send `PLAYER_CONNECTED` (with `isReconnect: true`) to game sandbox
5. Game sandbox should reply with `UPDATE_PLAYER` to restore state
6. Send `LOBBY_STATE` or current game state to the reconnected player

---

## `httpServer.js` — Express Server for Player Clients

### Responsibilities
- Serve the player shell HTML to phones
- Serve game pack assets (images, fonts, audio) to phones
- Serve the player game iframe HTML from the pack

### Routes

```
GET /                    → player shell (player-shell/src/index.html)
GET /shell.js            → player-shell/src/shell.js
GET /shell.css           → player-shell/src/overlay.css
GET /game/*              → static files from pack directory (assets, player HTML)
GET /join                → join landing page with QR code fallback
```

### Player Shell Entry Point

The `/` route serves a tiny HTML file that:
1. Shows a "Connecting..." spinner
2. Loads `shell.js` which opens a WebSocket connection to the host
3. After `PLAYER_JOIN` is received, loads the game's `player/hand.html` in an iframe

The player shell must be served from the same origin as the WebSocket server.

### Asset Serving Security

The `/game/*` route maps to the extracted pack directory. Apply:
- `express.static(packDir)` with `dotfiles: 'deny'`
- Disallow directory listing: `index: false`
- Content-Type sniffing disabled: `X-Content-Type-Options: nosniff`
- No execution of `.js` files server-side — they're served as static text to clients

### Port Selection

```js
// Find an available port starting at 3000
const port = await getPort({ port: getPort.makeRange(3000, 3100) });
```

Store the resolved port so `networkDiscovery.js` can advertise it.

---

## `networkDiscovery.js` — mDNS + QR Code

### Responsibilities
- Advertise the host on the local network so phones can find it
- Generate a QR code containing the join URL
- Display the QR code on the board display (via IPC)
- Get the local machine's LAN IP address

### mDNS Advertisement

```js
const bonjour = require('bonjour')();
bonjour.publish({
  name: 'BoardGame Platform',
  type: 'boardgame',
  port: serverPort
});
```

Phones can discover this via mDNS but most users will just scan the QR code.

### Local IP Detection

```js
const { networkInterfaces } = require('os');
function getLocalIP() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}
```

### QR Code

```js
const QRCode = require('qrcode');
const joinUrl = `http://${localIP}:${port}/join`;
const qrDataUrl = await QRCode.toDataURL(joinUrl);
// Send qrDataUrl to board display via IPC
mainWindow.webContents.send('platform:show-qr', { url: joinUrl, qr: qrDataUrl });
```

The board shell displays this in the lobby overlay.

---

## `gameRunner.js` — Game Sandbox Lifecycle

### Responsibilities
- Start and stop the game sandbox (see `game-sandbox/IMPLEMENTATION.md`)
- Relay messages between HOST and sandbox
- Handle sandbox crashes gracefully
- Enforce message timeouts (e.g., `GAME_READY` must arrive within 5s)

### Interface

```js
class GameRunner extends EventEmitter {
  async start(packDir, manifest) { ... }
  send(message) { ... }       // HOST → GAME
  stop() { ... }              // Clean shutdown
  kill() { ... }              // Force kill
  // Emits: 'message' (GAME → HOST), 'error', 'exit'
}
```

### Timeout Guards

| Event | Timeout | Action on timeout |
|---|---|---|
| `GAME_READY` after `GAME_INIT` | 5000ms | Kill sandbox, show error |
| `SAVE_STATE_RESPONSE` after `SAVE_STATE_REQUEST` | 3000ms | Log warning, proceed without save |

---

## `stateStore.js` — State Persistence

### Responsibilities
- Save game state blobs to disk
- Load saved state on game start
- Manage save file location

### Storage Location

```
{userData}/saves/{packId}/{packMajorVersion}/latest.json
```

`userData` is resolved via Electron's `app.getPath('userData')`.

### Save Format

```json
{
  "packId": "com.nickgames.catan",
  "packVersion": "1.0.0",
  "savedAt": "2025-10-01T14:22:00Z",
  "players": [
    { "id": "p1", "name": "Nick" }
  ],
  "state": { /* opaque game state blob */ }
}
```

---

## Error Handling Philosophy

- **Pack load errors** (bad ZIP, invalid manifest): Show error in the game picker UI before starting anything. Never leave a partially-extracted pack on disk.
- **Sandbox crashes**: Emit an `ERROR` event with `fatal: true` to the board display. Offer "Restart Game" (reload sandbox from same pack) or "Quit".
- **Player disconnects**: Forward to game as `PLAYER_DISCONNECTED`. Game decides whether to pause, continue, or end.
- **Board renderer crash**: Reload the board HTML (`win.reload()`). Re-send last `UPDATE_BOARD` state. The game continues uninterrupted.

---

## `package.json` (key deps)

```json
{
  "name": "boardgame-platform-host",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder"
  },
  "dependencies": {
    "electron": "^28.0.0",
    "socket.io": "^4.7.0",
    "express": "^4.18.0",
    "adm-zip": "^0.5.10",
    "bonjour": "^3.5.0",
    "qrcode": "^1.5.3",
    "get-port": "^7.0.0",
    "semver": "^7.5.0"
  },
  "devDependencies": {
    "electron-builder": "^24.0.0"
  }
}
```
