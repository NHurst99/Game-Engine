/**
 * platform-sdk.js — Platform SDK injected into game iframes.
 *
 * Provides `window.platform` with:
 *   - on(type, handler)   — subscribe to messages from the platform
 *   - once(type, handler) — subscribe once
 *   - off(type, handler)  — unsubscribe
 *   - sendAction(action, data) — send a player action to the game server
 *   - playerId, playerName, playerIndex, gameName, locale
 *
 * Communication: postMessage with parent shell (board-shell or player-shell).
 */
(function() {
  'use strict';

  var listeners = {};
  var initPayload = null;
  var initResolve = null;

  var platform = {
    // Player identity (set after PLATFORM_INIT)
    playerId: null,
    playerName: null,
    playerIndex: null,
    gameName: null,
    gameId: null,
    locale: 'en',

    /**
     * Subscribe to a message type from the platform.
     * @param {string} type — message type (e.g. 'UPDATE_PLAYER', 'GAME_OVER')
     * @param {function} handler — callback receiving the message payload
     */
    on: function(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push({ handler: handler, once: false });
    },

    /**
     * Subscribe once to a message type.
     */
    once: function(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push({ handler: handler, once: true });
    },

    /**
     * Unsubscribe from a message type.
     */
    off: function(type, handler) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(function(l) { return l.handler !== handler; });
    },

    /**
     * Send a player action to the game server (player iframes only).
     * @param {string} action — action name
     * @param {*} data — action data
     */
    sendAction: function(action, data) {
      window.parent.postMessage({
        type: 'PLAYER_ACTION',
        payload: { action: action, data: data }
      }, '*');
    },

    /**
     * Send a board action to the game server (board iframe only).
     * @param {string} action — action name
     * @param {*} data — action data
     */
    sendBoardAction: function(action, data) {
      window.parent.postMessage({
        type: 'BOARD_ACTION',
        payload: { action: action, data: data }
      }, '*');
    },

    /**
     * Signal that the board/player frame is ready.
     */
    ready: function() {
      window.parent.postMessage({ type: 'BOARD_READY', payload: {} }, '*');
    },

    /**
     * Returns a promise that resolves when PLATFORM_INIT is received.
     */
    whenReady: function() {
      if (initPayload) return Promise.resolve(initPayload);
      return new Promise(function(resolve) {
        initResolve = resolve;
      });
    }
  };

  // Listen for messages from the parent shell
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    // Handle PLATFORM_INIT — set identity fields
    if (msg.type === 'PLATFORM_INIT') {
      var p = msg.payload || {};
      platform.playerId = p.playerId || null;
      platform.playerName = p.playerName || null;
      platform.playerIndex = p.playerIndex != null ? p.playerIndex : null;
      platform.gameName = p.gameName || null;
      platform.gameId = p.gameId || null;
      platform.locale = p.locale || 'en';
      initPayload = p;
      if (initResolve) {
        initResolve(p);
        initResolve = null;
      }
    }

    // Dispatch to registered listeners
    var typeListeners = listeners[msg.type];
    if (typeListeners) {
      var remaining = [];
      for (var i = 0; i < typeListeners.length; i++) {
        var entry = typeListeners[i];
        try {
          entry.handler(msg.payload, msg);
        } catch (e) {
          console.error('[platform-sdk] Handler error:', e);
        }
        if (!entry.once) remaining.push(entry);
      }
      listeners[msg.type] = remaining;
    }
  });

  window.platform = platform;
})();
