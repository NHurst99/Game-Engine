# BoardGame Platform — To-Do

## Phase 0 — Main Menu ✅

- [x] `host/src/main.js` — Electron entry, BrowserWindow, IPC handlers
- [x] `host/src/preload.js` — contextBridge IPC bridge (`window.platform`)
- [x] `host/ui/menu.html` — TV main menu layout (game list, players panel, settings, exit)
- [x] `host/ui/menu.js` — renderer logic (game selection, launch bar, settings overlay)
- [x] `DEBUG` env var — fake game cards + DevTools when `DEBUG=1`
- [x] `npm run debug` script via `cross-env`

### Suggested Tests

- **Settings persistence** — write settings, reload app, assert values survived
- **Game scanner** — point library at a folder with a valid `.boardgame` ZIP and one malformed one; assert only valid game appears, no crash on malformed
- **Path traversal guard in scanner** — assert ZIP with `../../etc/passwd` entry is skipped, not extracted
- **Debug game injection** — run with `DEBUG=1`, assert 5 fake entries appear in `scanLibrary()` result
- **IPC channel smoke tests** — invoke `menu:settings-get`, `menu:settings-save`, `menu:get-games` and assert correct response shapes

---

## Phase 1 — Game Sandbox ✅

- [x] `game-sandbox/src/sandbox.js` — Worker thread + `vm.runInNewContext`
- [x] `GameContext` API — `on`, `emit`, `log`, `random`, `randomInt`, `shuffle`, `getPlayers`, `getSettings`, `timer`, `clearTimer`
- [x] Message queue — hold messages until `GAME_READY`, then flush
- [x] Player registry sync — `GAME_INIT`, `PLAYER_CONNECTED`, `PLAYER_DISCONNECTED`
- [x] PRNG — seeded mulberry32 via `ctx.random()`
- [x] `__KILL__` / `__UPDATE_PLAYERS__` / `__UPDATE_SETTINGS__` control messages
- [x] `globalThis` blocked via `Object.defineProperty`

### Suggested Tests

- **Happy path** — send `GAME_INIT`, expect `GAME_READY`; send `PLAYER_ACTION`, expect `UPDATE_BOARD`
- **Message queuing** — send `PLAYER_ACTION` before `GAME_READY`, assert it is delivered only after
- **RESTORE_STATE passthrough** — send `GAME_INIT` then `RESTORE_STATE`; assert both reach the game script
- **PRNG determinism** — run same seed twice, assert identical output sequence
- **Shuffle** — assert returned array has same elements in different order across N runs
- **`ctx.timer` fires** — register a 50ms timer, assert callback event is emitted within 200ms
- **`ctx.clearTimer` cancels** — set then clear a timer, assert callback never fires
- **`ctx.getPlayers` reflects state** — connect then disconnect a player, assert registry updates
- **Security — blocked APIs** — `require`, `process`, `setTimeout`, `fetch`, `globalThis`, `Buffer` all throw inside game script
- **Sync timeout** — game script with infinite sync loop (`while(true){}`) must error within 5s
- **Fatal error propagation** — script that throws on top level must emit `ERROR` with `fatal: true`
- **`__KILL__` exits cleanly** — worker must terminate, pending timers must not fire after kill

---

## Phase 2 — Host Core ✅

- [x] `host/src/packLoader.js` — ZIP extraction + manifest validation
  - Path traversal guard (reject entries escaping temp dir)
  - Symlink rejection
  - Executable file warning
  - ZIP bomb detection (2GB hard limit)
  - Manifest field validation (id, version, name, players, entry files)
  - Temp dir cleanup on quit / new pack load
- [x] `host/src/socketServer.js` — Socket.io hub
  - Connection registry (`board: socket | null`, `players: Map`)
  - Lobby state machine (`JOIN_REQUEST` → `PLAYER_JOIN` → `LOBBY_STATE` → `READY` → Start)
  - `routeFromGame(msg)` — route to `board`, `all_players`, or specific `player:pN`
  - Reconnection via `REQUEST_REJOIN`
  - Wire `pushPlayersUpdate()` into `main.js` for live menu panel
- [x] `host/src/httpServer.js` — Express server
  - `GET /` → player shell `index.html`
  - `GET /shell.js`, `GET /shell.css` → player shell assets
  - `GET /game/*` → static pack assets (dotfiles denied, no directory listing)
  - `GET /platform-sdk.js` → platform SDK (stub until Phase 3)
  - Dynamic port selection (3000–3100 via `get-port`)
- [x] `host/src/gameRunner.js` — `GameRunner extends EventEmitter`
  - Spawns `game-sandbox/src/sandbox.js` as Worker
  - Relays messages HOST ↔ sandbox
  - `GAME_READY` timeout guard (5s)
  - `SAVE_STATE_RESPONSE` timeout guard (3s)
  - Watchdog: warn if sandbox silent for 30s
  - `stop()` / `kill()` lifecycle
- [x] `host/src/networkDiscovery.js` — mDNS + QR code
  - Advertise via `bonjour`
  - Detect local LAN IP
  - Generate QR code data URL via `qrcode`
  - Send join info to renderer via IPC
- [x] `host/src/stateStore.js` — save / load state blobs
  - Storage path: `{userData}/saves/{packId}/{majorVersion}/latest.json`
  - Load on game start if `persistState: true`
  - Autosave on `SAVE_STATE_RESPONSE` from game / quit
- [x] Wired all modules into `host/src/main.js`
  - Server starts on app launch (HTTP + WS + mDNS)
  - `menu:load-game` validates + extracts pack, mounts assets, enters lobby
  - `menu:start-game` spawns sandbox, sends `GAME_INIT`, restores state
  - `menu:stop-game` saves state + stops sandbox
  - Cleanup on `before-quit` and `uncaughtException`

### Suggested Tests

- **`packLoader` — valid pack** — ZIP with correct manifest + entry files loads without error
- **`packLoader` — missing manifest** — assert hard failure
- **`packLoader` — invalid semver** — assert hard failure
- **`packLoader` — path traversal** — assert error, no files extracted
- **`packLoader` — entry file missing** — assert hard failure for each required entry
- **`packLoader` — optional icon missing** — assert warning, not failure
- **`socketServer` — JOIN_REQUEST** — connect a socket, send `JOIN_REQUEST`, assert `PLAYER_JOIN` + `LOBBY_STATE` response
- **`socketServer` — maxPlayers enforced** — fill to max, assert next `JOIN_REQUEST` gets `JOIN_REJECTED`
- **`socketServer` — READY tracking** — N players ready triggers `canStart: true` in `LOBBY_STATE`
- **`socketServer` — PLAYER_ACTION routing** — assert forwarded to game with `from: "player:pN"` injected
- **`socketServer` — reconnect** — disconnect then reconnect with stored `playerId`, assert registry updated
- **`socketServer` — routeFromGame board** — emit `UPDATE_BOARD` from game, assert board socket receives it
- **`socketServer` — routeFromGame player** — emit `UPDATE_PLAYER` with `to: "player:p1"`, assert only p1 receives it
- **`gameRunner` — GAME_READY timeout** — stall game script, assert error emitted within 5s
- **`gameRunner` — sandbox crash** — game script throws fatal, assert `error` event emitted
- **`stateStore` — round-trip** — save blob, load it back, assert deep equality
- **`stateStore` — version namespace** — same id different major version uses different save path

---

## Phase 3 — Shells ⬜

- [ ] `board-shell/src/index.html` + `shell.js` + `overlay.css`
  - Connect to host Socket.io
  - Lobby screen: QR code display, player list, Start button (enabled when `canStart: true`)
  - Mount pack `board.html` in `<iframe sandbox="allow-scripts">`
  - Proxy `postMessage` ↔ WebSocket (`UPDATE_BOARD`, `BOARD_ACTION`, `BOARD_READY`, etc.)
  - Inject `window.platform` into board iframe (via postMessage handshake)
  - Game-over screen with Play Again / Quit
  - Connection status overlay
- [ ] `player-shell/src/index.html` + `shell.js` + `overlay.css`
  - Join screen: name input, submit
  - Lobby screen: player list, Ready button, waiting status
  - Mount pack `player/hand.html` in iframe
  - Proxy `postMessage` ↔ WebSocket (`UPDATE_PLAYER`, `PLAYER_ACTION`, etc.)
  - Inject `window.platform` with `playerId`, `playerName`, `playerIndex`
  - Game-over screen
  - Disconnect overlay with auto-reconnect
- [ ] `/platform-sdk.js` — served by `httpServer`, injected into game iframes
  - `window.platform.on(type, handler)` / `window.platform.once(type, handler)`
  - `window.platform.sendAction(action, data)` (player only)
  - `window.platform.playAudio(clip, volume)`
  - `window.platform.t(key, vars)` locale helper
  - `window.platform.playerId` / `playerName` / `playerIndex`
  - `PLATFORM_INIT` bootstrap handshake

### Suggested Tests

- **Board shell connects** — shell opens WS, receives `BOARD_INIT`, assert lobby screen shown
- **QR code rendered** — send `platform:show-qr` IPC, assert QR element appears in DOM
- **Start button state** — assert disabled until `canStart: true` in `LOBBY_STATE`
- **iframe mount** — after `GAME_STARTED`, assert `board.html` iframe is in DOM with correct `src`
- **postMessage → WS proxy** — iframe posts `BOARD_READY`, assert `BOARD_READY` emitted on socket
- **WS → postMessage proxy** — socket receives `UPDATE_BOARD`, assert iframe receives it via `postMessage`
- **Player shell join flow** — submit name, assert `JOIN_REQUEST` sent; receive `PLAYER_JOIN`, assert lobby shown
- **Player shell reconnect** — disconnect and reconnect, assert `REQUEST_REJOIN` sent with stored playerId
- **platform-sdk `on`/`once`** — register handlers, assert `once` fires only once
- **platform-sdk `sendAction`** — call it, assert `PLAYER_ACTION` postMessage sent to parent shell

---

## Phase 4 — Example Game Pack ⬜

- [ ] `example-games/example-tictactoe/manifest.json`
- [ ] `example-games/example-tictactoe/server/game.js`
- [ ] `example-games/example-tictactoe/board/board.html`
- [ ] `example-games/example-tictactoe/player/hand.html`
- [ ] Bundle script — zip the above into `example-tictactoe.boardgame`

### Suggested Tests

- **Pack validation** — load via `packLoader`, assert no errors
- **Sandbox execution** — run `server/game.js` in sandbox, send `GAME_INIT` with 2 players, assert `GAME_READY`
- **Win detection** — simulate moves filling a winning row, assert `GAME_OVER` emitted
- **Draw detection** — fill all 9 cells with no winner, assert `GAME_OVER` with `winner: null`
- **Invalid move — wrong turn** — send action from non-current player, assert `TOAST` error, no state change
- **Invalid move — occupied cell** — send action for already-filled cell, assert `TOAST` error
- **`ctx.shuffle` assignment** — run `GAME_INIT` N times, assert X/O assignment varies
- **Reconnect state restore** — simulate disconnect mid-game, reconnect, assert `UPDATE_PLAYER` restores correct hand state
- **End-to-end (manual)** — launch platform, load pack, two phones join, play to completion
