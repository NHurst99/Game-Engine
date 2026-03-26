const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SANDBOX_SCRIPT = path.resolve(__dirname, '../../game-sandbox/src/sandbox.js');

const GAME_READY_TIMEOUT = 5000;
const SAVE_STATE_TIMEOUT = 3000;
const WATCHDOG_INTERVAL = 10000;
const WATCHDOG_THRESHOLD = 30000;

/**
 * GameRunner — manages the game sandbox Worker lifecycle.
 *
 * Emits:
 *   'message'  — GAME → HOST message (for routing by socketServer)
 *   'error'    — sandbox error or timeout
 *   'exit'     — worker exited
 *   'ready'    — GAME_READY received from sandbox
 */
class GameRunner extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this._gameReadyTimeout = null;
    this._saveStateTimeout = null;
    this._watchdogInterval = null;
    this._lastActivity = 0;
    this._running = false;
  }

  /**
   * Start the game sandbox with a loaded pack.
   * @param {string} packDir — absolute path to the extracted pack
   * @param {object} manifest — validated manifest object
   */
  async start(packDir, manifest) {
    const scriptPath = path.join(packDir, manifest.entry.server);
    const scriptSource = fs.readFileSync(scriptPath, 'utf8');

    this.worker = new Worker(SANDBOX_SCRIPT, {
      workerData: { scriptSource, scriptPath },
    });
    this._running = true;
    this._lastActivity = Date.now();

    // ── Message relay ──────────────────────────────────────────────────────
    this.worker.on('message', (msg) => {
      this._lastActivity = Date.now();

      if (msg.type === '__LOG__') {
        console.log(`[GAME] ${msg.payload.message}`);
        return;
      }

      if (msg.type === 'GAME_READY') {
        this._clearGameReadyTimeout();
        this.emit('ready');
      }

      if (msg.type === 'SAVE_STATE_RESPONSE') {
        this._clearSaveStateTimeout();
      }

      this.emit('message', msg);
    });

    // ── Error / exit ───────────────────────────────────────────────────────
    this.worker.on('error', (err) => {
      console.error('[GAME] Worker error:', err.message);
      this.emit('error', err);
    });

    this.worker.on('exit', (code) => {
      this._running = false;
      this._stopWatchdog();
      this._clearGameReadyTimeout();
      this._clearSaveStateTimeout();
      this.emit('exit', code);
    });

    // ── GAME_READY timeout ─────────────────────────────────────────────────
    this._gameReadyTimeout = setTimeout(() => {
      const err = new Error(
        'GAME_READY timeout: game script did not initialize within 5s'
      );
      this.emit('error', err);
      this.kill();
    }, GAME_READY_TIMEOUT);

    // ── Watchdog ───────────────────────────────────────────────────────────
    this._startWatchdog();
  }

  /**
   * Send a message from HOST → GAME sandbox.
   */
  send(message) {
    this.worker?.postMessage(message);
  }

  /**
   * Request a state save. Enforces the 3s timeout.
   */
  requestStateSave(reason = 'autosave') {
    if (!this._running) return;
    this.send({
      type: 'SAVE_STATE_REQUEST',
      payload: { reason },
    });

    this._saveStateTimeout = setTimeout(() => {
      console.warn('[GAME] SAVE_STATE_RESPONSE timeout — proceeding without save');
      this._saveStateTimeout = null;
    }, SAVE_STATE_TIMEOUT);
  }

  /**
   * Graceful shutdown: send __KILL__, then force-terminate after 1s.
   */
  stop() {
    if (!this._running) return;
    this.send({ type: '__KILL__' });
    setTimeout(() => this.kill(), 1000);
  }

  /**
   * Force kill the worker immediately.
   */
  kill() {
    this._stopWatchdog();
    this._clearGameReadyTimeout();
    this._clearSaveStateTimeout();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this._running = false;
  }

  get isRunning() {
    return this._running;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _clearGameReadyTimeout() {
    if (this._gameReadyTimeout) {
      clearTimeout(this._gameReadyTimeout);
      this._gameReadyTimeout = null;
    }
  }

  _clearSaveStateTimeout() {
    if (this._saveStateTimeout) {
      clearTimeout(this._saveStateTimeout);
      this._saveStateTimeout = null;
    }
  }

  _startWatchdog() {
    this._watchdogInterval = setInterval(() => {
      if (!this._running) return;
      if (Date.now() - this._lastActivity > WATCHDOG_THRESHOLD) {
        console.warn('[GAME] Sandbox appears unresponsive (no messages for 30s)');
        this.emit('error', new Error('Game sandbox appears unresponsive'));
      }
    }, WATCHDOG_INTERVAL);
  }

  _stopWatchdog() {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
    }
  }
}

module.exports = GameRunner;
