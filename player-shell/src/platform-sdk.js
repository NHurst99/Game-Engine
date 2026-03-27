/**
 * platform-sdk.js — Platform SDK injected into game iframes.
 *
 * Provides `window.platform` with:
 *   - on(type, handler)   — subscribe to messages from the platform
 *   - once(type, handler) — subscribe once
 *   - off(type, handler)  — unsubscribe
 *   - sendAction(action, data) — send a player action to the game server
 *   - sendBoardAction(action, data) — send a board action (board iframes only)
 *   - ready() — signal that the frame is ready
 *   - whenReady() — Promise that resolves with PLATFORM_INIT payload
 *   - t(key, vars) — translate a string key
 *   - setLanguage(lang) — change the active language
 *   - playerId, playerName, playerIndex, gameName, gameId, locale
 *
 * Communication: postMessage with parent shell (board-shell or player-shell).
 */
(function() {
  'use strict';

  // ── String resolution ──────────────────────────────────────────────────────
  // Self-contained; mirrors the logic in host/src/stringManager.js.
  // Key format: "namespace:dot.key"  (namespace defaults to the pack id, or "core")

  var _currentLang = 'en';
  var _defaultLang = 'en';
  var _coreLocales = {};  // { en: { 'error.foo': 'Foo' } }
  var _packLocales = {};  // { packId: { en: {...} } }
  var _gameId = null;     // set from PLATFORM_INIT so bare keys default to the pack

  function _strResolve(obj, key) {
    if (!obj || obj[key] === undefined) return null;
    return String(obj[key]);
  }

  function _t(key, vars) {
    var ns = _gameId || 'core';
    var dotKey = key;
    var colon = key.indexOf(':');
    if (colon !== -1) {
      ns = key.slice(0, colon);
      dotKey = key.slice(colon + 1);
    }

    var str = null;
    if (ns === 'core') {
      str = _strResolve(_coreLocales[_currentLang], dotKey);
      if (str === null) str = _strResolve(_coreLocales[_defaultLang], dotKey);
    } else {
      var pack = _packLocales[ns] || {};
      str = _strResolve(pack[_currentLang], dotKey);
      if (str === null) str = _strResolve(pack[_defaultLang], dotKey);
      if (str === null) str = _strResolve(_coreLocales[_currentLang], dotKey);
      if (str === null) str = _strResolve(_coreLocales[_defaultLang], dotKey);
    }

    if (str === null) return key;

    if (vars) {
      str = str.replace(/\{(\w+)\}/g, function(match, k) {
        return vars[k] !== undefined ? String(vars[k]) : match;
      });
    }
    return str;
  }

  function _registerPackLocales(packId, locales) {
    if (!packId || !locales) return;
    _packLocales[packId] = locales;
  }

  // Fetch and register core locale JSON from the platform server
  function _loadCoreLocales(lang) {
    fetch('/locales/' + lang + '.json')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data) {
          _coreLocales[lang] = data;
        }
      })
      .catch(function() { /* non-fatal — fallback to key-as-string */ });
  }

  // ── Event listeners ────────────────────────────────────────────────────────

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
    },

    /**
     * Translate a key, with optional variable interpolation.
     *
     * Keys without a namespace prefix default to the current pack's id.
     * Fallback chain: pack[currentLang] → pack[defaultLang] → core[currentLang] → core[defaultLang] → key
     *
     * @param {string} key — "namespace:dot.key" or "dot.key"
     * @param {Object} [vars] — interpolation variables, e.g. { name: 'Alice' }
     * @returns {string}
     */
    t: function(key, vars) {
      return _t(key, vars);
    },

    /**
     * Change the active language. Strings will resolve against this language first.
     * @param {string} lang — BCP 47-ish tag, e.g. 'en', 'es'
     */
    setLanguage: function(lang) {
      if (!lang) return;
      _currentLang = lang;
      platform.locale = lang;
      _loadCoreLocales(lang);
    }
  };

  // Listen for messages from the parent shell
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    // Handle PLATFORM_INIT — player iframes: set identity + register locale data
    if (msg.type === 'PLATFORM_INIT') {
      var p = msg.payload || {};
      platform.playerId = p.playerId || null;
      platform.playerName = p.playerName || null;
      platform.playerIndex = p.playerIndex != null ? p.playerIndex : null;
      platform.gameName = p.gameName || null;
      platform.gameId = p.gameId || null;
      platform.locale = p.locale || 'en';

      // Set language and load core locale strings
      _currentLang = platform.locale;
      _defaultLang = 'en';
      _gameId = p.gameId || null;
      _loadCoreLocales(_currentLang);
      if (_currentLang !== _defaultLang) _loadCoreLocales(_defaultLang);

      // Register pack locale data delivered via this payload
      if (p.gameId && p.packLocales && typeof p.packLocales === 'object') {
        _registerPackLocales(p.gameId, p.packLocales);
      }

      initPayload = p;
      if (initResolve) {
        initResolve(p);
        initResolve = null;
      }
    }

    // Handle BOARD_INIT — board iframes: extract locale + pack data.
    // (Board iframes receive BOARD_INIT instead of PLATFORM_INIT.)
    if (msg.type === 'BOARD_INIT') {
      var b = msg.payload || {};
      var boardLocale = b.locale || 'en';
      _currentLang = boardLocale;
      _defaultLang = 'en';
      platform.locale = boardLocale;
      _loadCoreLocales(boardLocale);
      if (boardLocale !== 'en') _loadCoreLocales('en');
      // Register pack locale data if provided alongside BOARD_INIT
      if (b.gameId && b.packLocales && typeof b.packLocales === 'object') {
        _gameId = b.gameId;
        _registerPackLocales(b.gameId, b.packLocales);
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
