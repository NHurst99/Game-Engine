# Game Sandbox — Implementation Guide

**Location:** `game-sandbox/`
**Responsibility:** Execute `server/game.js` from a pack in a restricted environment that provides the `GameContext` API while preventing malicious or accidental access to the host system.

---

## Why a Sandbox?

`server/game.js` is third-party code. Even for personal use, a sandbox prevents:
- Accidental `require('fs')` calls that wipe files
- Accidental infinite loops that freeze the host process
- Network calls from game scripts
- Memory leaks escaping into the host process

---

## Sandbox Architecture: Worker Thread + Restricted Context

The recommended approach uses Node.js **Worker Threads** as the isolation layer, combined with a restricted module system inside the worker.

```
Host Process (main.js)
    │
    │ worker_threads.Worker
    ▼
game-sandbox/src/sandbox.js (Worker)
    │
    │ vm.runInNewContext(gameScript, contextObject)
    ▼
server/game.js (game script — no require, no globals)
```

### Why Not `vm2`?

`vm2` was widely used but has had multiple sandbox escape CVEs. For a local-only entertainment platform, a Worker thread + `vm.runInNewContext` is sufficient and has a smaller attack surface. If you want defense-in-depth, wrap the Worker itself in a subprocess and communicate via `process.send`.

### Why Not a Child Process?

A child process (`child_process.fork`) would work but requires serializing all messages through stdin/stdout or IPC, which adds latency. Worker threads share the same V8 instance, giving near-zero message overhead. For a local multiplayer game, this matters for responsiveness.

---

## `sandbox.js` — Worker Entry Point

This file runs inside a Worker thread. It:
1. Receives the game script source code from the parent
2. Builds the `GameContext` object
3. Executes the script in a `vm.runInNewContext` context
4. Relays messages between the context and the parent thread

```js
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const { EventEmitter } = require('events');

// workerData contains:
// { scriptSource: string, scriptPath: string, initPayload: object }

const scriptSource = workerData.scriptSource;

// Message queue: holds HOST→GAME messages before GAME_READY
let pendingMessages = [];
let gameReady = false;

// Internal event bus for ctx.on / ctx.emit
const internalBus = new EventEmitter();

// Timers: maps timerId → setTimeout handle
const timers = new Map();
let timerIdCounter = 0;

// ─── PRNG (seeded) ───────────────────────────────────────────────────────────
// Use a seeded PRNG so games are reproducible/auditable if needed.
// Simple mulberry32 implementation:
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(Date.now() ^ Math.random() * 0xFFFFFFFF);

// ─── GameContext object ───────────────────────────────────────────────────────
const ctx = {
  on(eventType, handler) {
    internalBus.on(eventType, handler);
  },

  emit(eventType, payload, to) {
    // Send message to parent (HOST) for routing
    parentPort.postMessage({ type: eventType, payload, to });
    // Special handling: track GAME_READY
    if (eventType === 'GAME_READY') {
      gameReady = true;
      // Flush pending messages
      for (const msg of pendingMessages) {
        internalBus.emit(msg.type, msg.payload, { from: msg.from, seq: msg.seq });
      }
      pendingMessages = [];
    }
  },

  log(message) {
    parentPort.postMessage({ type: '__LOG__', payload: { message } });
  },

  random() { return rng(); },

  randomInt(min, max) {
    return Math.floor(ctx.random() * (max - min + 1)) + min;
  },

  shuffle(array) {
    const a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  getPlayers() {
    // Players list is kept in sync via __UPDATE_PLAYERS__ internal messages
    return [...playersRegistry];
  },

  getSettings() {
    return { ...settingsCache };
  },

  timer(ms, callbackEventType, callbackPayload) {
    const id = ++timerIdCounter;
    const handle = setTimeout(() => {
      timers.delete(id);
      internalBus.emit(callbackEventType, callbackPayload || {}, { from: 'timer', seq: null });
    }, ms);
    timers.set(id, handle);
    return id;
  },

  clearTimer(timerId) {
    const handle = timers.get(timerId);
    if (handle) {
      clearTimeout(handle);
      timers.delete(timerId);
    }
  }
};

// ─── Internal state kept in sync ─────────────────────────────────────────────
let playersRegistry = [];
let settingsCache = {};

// ─── Message handler (HOST → sandbox) ────────────────────────────────────────
parentPort.on('message', (msg) => {
  // Internal control messages (not from game API)
  if (msg.type === '__UPDATE_PLAYERS__') {
    playersRegistry = msg.payload.players;
    return;
  }
  if (msg.type === '__UPDATE_SETTINGS__') {
    settingsCache = msg.payload.settings;
    return;
  }
  if (msg.type === '__KILL__') {
    cleanup();
    process.exit(0);
  }

  // Sync players/settings from GAME_INIT before forwarding
  if (msg.type === 'GAME_INIT') {
    playersRegistry = msg.payload.players.map(p => ({ ...p, connected: false }));
    settingsCache = msg.payload.settings || {};
  }
  if (msg.type === 'PLAYER_CONNECTED') {
    const p = playersRegistry.find(p => p.id === msg.payload.playerId);
    if (p) p.connected = true;
  }
  if (msg.type === 'PLAYER_DISCONNECTED') {
    const p = playersRegistry.find(p => p.id === msg.payload.playerId);
    if (p) p.connected = false;
  }

  // Queue messages until GAME_READY, then flush
  if (!gameReady && msg.type !== 'GAME_INIT' && msg.type !== 'RESTORE_STATE') {
    pendingMessages.push(msg);
    return;
  }

  internalBus.emit(msg.type, msg.payload, { from: msg.from, seq: msg.seq });
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────
function cleanup() {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

// ─── Execute the game script ──────────────────────────────────────────────────
// Build a minimal context. ONLY ctx is available. No require, no process,
// no global, no Buffer, no setTimeout (use ctx.timer instead).
const sandboxContext = vm.createContext({
  ctx,
  console: {
    log: (...args) => ctx.log(args.join(' ')),
    warn: (...args) => ctx.log('[WARN] ' + args.join(' ')),
    error: (...args) => ctx.log('[ERROR] ' + args.join(' ')),
  },
  // Math and JSON are safe and useful
  Math,
  JSON,
  // Allow Map, Set, Array, Object — standard JS globals
  Map, Set, Array, Object, String, Number, Boolean, Symbol,
  Error, TypeError, RangeError,
  Promise,
  // Intentionally ABSENT: require, process, Buffer, fetch, XMLHttpRequest,
  // globalThis, __dirname, __filename, setTimeout, setInterval, clearTimeout
});

try {
  vm.runInContext(scriptSource, sandboxContext, {
    filename: workerData.scriptPath,
    timeout: 5000,   // Max 5s for synchronous top-level execution
    // Note: this timeout does NOT apply to async code / event handlers
  });
} catch (err) {
  parentPort.postMessage({
    type: 'ERROR',
    payload: {
      code: 'SCRIPT_EXECUTION_ERROR',
      message: err.message,
      stack: err.stack,
      fatal: true
    }
  });
}
```

---

## `gameRunner.js` Integration (in host/)

The `GameRunner` class in the host creates and manages the Worker:

```js
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class GameRunner extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this._gameReadyTimeout = null;
  }

  async start(packDir, manifest) {
    const scriptPath = path.join(packDir, manifest.entry.server);
    const scriptSource = fs.readFileSync(scriptPath, 'utf8');
    const sandboxScript = path.join(__dirname, '../game-sandbox/src/sandbox.js');

    this.worker = new Worker(sandboxScript, {
      workerData: { scriptSource, scriptPath }
    });

    this.worker.on('message', (msg) => {
      if (msg.type === '__LOG__') {
        console.log(`[GAME LOG] ${msg.payload.message}`);
        return;
      }
      this.emit('message', msg);
    });

    this.worker.on('error', (err) => {
      this.emit('error', err);
    });

    this.worker.on('exit', (code) => {
      this.emit('exit', code);
    });

    // Set GAME_READY timeout
    this._gameReadyTimeout = setTimeout(() => {
      this.emit('error', new Error('GAME_READY timeout: game script did not initialize within 5s'));
      this.kill();
    }, 5000);

    this.once('game_ready_received', () => {
      clearTimeout(this._gameReadyTimeout);
    });

    // Watch for GAME_READY from game
    this.on('message', (msg) => {
      if (msg.type === 'GAME_READY') this.emit('game_ready_received');
    });
  }

  send(message) {
    this.worker?.postMessage(message);
  }

  stop() {
    this.send({ type: '__KILL__' });
    setTimeout(() => this.kill(), 1000); // Force kill after 1s
  }

  kill() {
    this.worker?.terminate();
    this.worker = null;
  }
}

module.exports = GameRunner;
```

---

## CPU/Memory Protection

Worker threads do not natively have CPU/memory limits. Implement these guards:

### CPU Guard (Infinite Loop Detection)

The `vm.runInContext` `timeout` option covers synchronous top-level execution. For async handlers, use a watchdog:

```js
// In GameRunner: track last message timestamp
let lastActivity = Date.now();
this.on('message', () => { lastActivity = Date.now(); });

// Watchdog: if no messages from game for 30s and game is in progress, warn
setInterval(() => {
  if (Date.now() - lastActivity > 30000) {
    this.emit('error', new Error('Game sandbox appears unresponsive'));
  }
}, 10000);
```

### Memory Guard

Worker threads run in the same process. To hard-cap memory, run the sandbox in a subprocess instead:

```js
// Option B (defense-in-depth): spawn as subprocess
const child = child_process.fork(sandboxScript, [], {
  execArgv: ['--max-old-space-size=128'] // 128MB cap
});
```

For a local entertainment platform, the Worker thread approach is fine. Use subprocess if distributing to untrusted users.

---

## What Game Scripts Can and Cannot Do

### ✅ Available

- Standard JS globals: `Math`, `JSON`, `Map`, `Set`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Promise`, `Error`
- `ctx.*` — full GameContext API
- `console.log/warn/error` (routes to host log)

### ❌ Blocked

- `require()` / `import()` — no module loading
- `process` — no process access
- `fs`, `net`, `http`, `child_process` — no system access
- `fetch`, `XMLHttpRequest` — no network access
- `setTimeout`, `setInterval` — use `ctx.timer()` instead
- `globalThis` — not exposed
- `Buffer` — not exposed
- `__dirname`, `__filename` — not exposed

### ⚠️ Notes

- Game scripts must use CommonJS-style code flow (no top-level `import`/`export`).
- All event handlers registered with `ctx.on` are async-safe — they run in the Worker's event loop.
- The game script may use `Promise` and `async/await` freely.
- The `ctx.timer()` mechanism uses the host's `setTimeout` but surfaces it as a safe API — the game cannot clear timers it doesn't own.
