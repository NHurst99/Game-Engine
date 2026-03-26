const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const { EventEmitter } = require('events');

// workerData: { scriptSource: string, scriptPath: string }
const scriptSource = workerData.scriptSource;

// ─── Message queue: hold HOST→GAME messages until GAME_READY ─────────────────

let pendingMessages = [];
let gameReady = false;

// Internal event bus for ctx.on / ctx.emit
const internalBus = new EventEmitter();

// Timers: timerId → setTimeout handle
const timers = new Map();
let timerIdCounter = 0;

// ─── PRNG (seeded mulberry32) ────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);

// ─── Internal state kept in sync by HOST control messages ────────────────────

let playersRegistry = [];
let settingsCache = {};

// ─── GameContext object ──────────────────────────────────────────────────────

const ctx = {
  on(eventType, handler) {
    internalBus.on(eventType, handler);
  },

  emit(eventType, payload, to) {
    parentPort.postMessage({ type: eventType, payload, to });
    if (eventType === 'GAME_READY') {
      gameReady = true;
      for (const msg of pendingMessages) {
        internalBus.emit(msg.type, msg.payload, {
          from: msg.from,
          seq: msg.seq,
        });
      }
      pendingMessages = [];
    }
  },

  log(message) {
    parentPort.postMessage({ type: '__LOG__', payload: { message } });
  },

  random() {
    return rng();
  },

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
    return [...playersRegistry];
  },

  getSettings() {
    return { ...settingsCache };
  },

  timer(ms, callbackEventType, callbackPayload) {
    const id = ++timerIdCounter;
    const handle = setTimeout(() => {
      timers.delete(id);
      internalBus.emit(callbackEventType, callbackPayload || {}, {
        from: 'timer',
        seq: null,
      });
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
  },
};

// ─── Message handler (HOST → sandbox) ────────────────────────────────────────

parentPort.on('message', (msg) => {
  // Internal control messages
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
    playersRegistry = msg.payload.players.map((p) => ({
      ...p,
      connected: false,
    }));
    settingsCache = msg.payload.settings || {};
  }
  if (msg.type === 'PLAYER_CONNECTED') {
    const p = playersRegistry.find((pl) => pl.id === msg.payload.playerId);
    if (p) p.connected = true;
  }
  if (msg.type === 'PLAYER_DISCONNECTED') {
    const p = playersRegistry.find((pl) => pl.id === msg.payload.playerId);
    if (p) p.connected = false;
  }

  // Queue messages until GAME_READY (except GAME_INIT and RESTORE_STATE)
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

// ─── Execute the game script ─────────────────────────────────────────────────

const sandboxContext = vm.createContext({
  ctx,
  console: {
    log: (...args) => ctx.log(args.join(' ')),
    warn: (...args) => ctx.log('[WARN] ' + args.join(' ')),
    error: (...args) => ctx.log('[ERROR] ' + args.join(' ')),
  },
  Math,
  JSON,
  Map,
  Set,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Symbol,
  Error,
  TypeError,
  RangeError,
  Promise,
  // Intentionally ABSENT: require, process, Buffer, fetch, XMLHttpRequest,
  // globalThis, __dirname, __filename, setTimeout, setInterval, clearTimeout
});

// Override globalThis self-reference that vm.createContext sets by default
Object.defineProperty(sandboxContext, 'globalThis', {
  get() { throw new ReferenceError('globalThis is not defined'); },
  configurable: false,
});

try {
  vm.runInContext(scriptSource, sandboxContext, {
    filename: workerData.scriptPath,
    timeout: 5000, // Max 5s for synchronous top-level execution
  });
} catch (err) {
  parentPort.postMessage({
    type: 'ERROR',
    payload: {
      code: 'SCRIPT_EXECUTION_ERROR',
      message: err.message,
      stack: err.stack,
      fatal: true,
    },
  });
}
