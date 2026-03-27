'use strict';

/**
 * StringManager — universal localization module.
 *
 * Works in Node.js (require) and in browsers (<script> tag).
 * Key format: "namespace:dot.separated.key"
 *   - "core:error.invalid_zip"
 *   - "mygame:ui.player_turn"
 *   Keys without a namespace prefix default to "core".
 */

var _currentLang = 'en';
var _defaultLang = 'en';
var _coreLocales = {};   // { en: { 'error.foo': 'Foo', ... } }
var _packLocales = {};   // { packId: { en: { ... }, es: { ... } } }

var _debug = (typeof process !== 'undefined' && (process.env.DEBUG === '1' || process.env.DEBUG === 'true'))
          || (typeof window !== 'undefined' && !!window.__DEBUG__);

/**
 * Resolve a flat-key lookup against a locale object.
 * Returns null when the key is absent so callers can chain fallbacks.
 */
function _resolve(obj, key) {
  if (!obj || obj[key] === undefined) return null;
  return String(obj[key]);
}

/**
 * Translate a key, optionally interpolating variables.
 *
 * Resolution order for pack keys:
 *   1. pack[currentLang]
 *   2. pack[defaultLang]
 *   3. core[currentLang]
 *   4. core[defaultLang]
 *
 * Resolution order for core keys:
 *   1. core[currentLang]
 *   2. core[defaultLang]
 *
 * Falls back to returning the key itself (never throws).
 *
 * @param {string} key - "namespace:dot.key" or "dot.key"
 * @param {Object} [vars] - interpolation variables, e.g. { name: 'Alice' }
 * @returns {string}
 */
function t(key, vars) {
  var ns = 'core';
  var dotKey = key;
  var colon = key.indexOf(':');
  if (colon !== -1) {
    ns = key.slice(0, colon);
    dotKey = key.slice(colon + 1);
  }

  var str = null;
  if (ns === 'core') {
    str = _resolve(_coreLocales[_currentLang], dotKey);
    if (str === null) str = _resolve(_coreLocales[_defaultLang], dotKey);
  } else {
    var pack = _packLocales[ns] || {};
    str = _resolve(pack[_currentLang], dotKey);
    if (str === null) str = _resolve(pack[_defaultLang], dotKey);
    if (str === null) str = _resolve(_coreLocales[_currentLang], dotKey);
    if (str === null) str = _resolve(_coreLocales[_defaultLang], dotKey);
  }

  if (str === null) {
    if (_debug) {
      console.warn('[StringManager] Missing key: ' + key);
    }
    return key;
  }

  // Variable interpolation: "Deals {damage} damage" → "Deals 5 damage"
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, function(match, k) {
      return vars[k] !== undefined ? String(vars[k]) : match;
    });
  }

  return str;
}

/**
 * Register (or replace) core locale data.
 * @param {{ [lang: string]: Object }} locales - e.g. { en: { 'error.foo': 'Foo' } }
 */
function registerCore(locales) {
  if (!locales || typeof locales !== 'object') return;
  var langs = Object.keys(locales);
  for (var i = 0; i < langs.length; i++) {
    var lang = langs[i];
    _coreLocales[lang] = Object.assign({}, _coreLocales[lang] || {}, locales[lang]);
  }
}

/**
 * Register (or replace) a game pack's locale data.
 * @param {string} packId
 * @param {{ [lang: string]: Object }} locales - e.g. { en: { 'ui.start': 'Start' }, es: { 'ui.start': 'Iniciar' } }
 */
function registerPack(packId, locales) {
  if (!packId || !locales || typeof locales !== 'object') return;
  if (!_packLocales[packId]) _packLocales[packId] = {};
  var langs = Object.keys(locales);
  for (var i = 0; i < langs.length; i++) {
    var lang = langs[i];
    _packLocales[packId][lang] = Object.assign({}, (_packLocales[packId][lang] || {}), locales[lang]);
  }
}

/**
 * Unregister all locale data for a pack (call when a pack is unloaded).
 * @param {string} packId
 */
function unregisterPack(packId) {
  delete _packLocales[packId];
}

/**
 * Set the active language. Strings will resolve against this language first.
 * @param {string} lang - BCP 47-ish tag, e.g. 'en', 'es', 'fr'
 */
function setLanguage(lang) {
  if (lang && typeof lang === 'string') _currentLang = lang;
}

/**
 * Set the default (fallback) language.
 * @param {string} lang
 */
function setDefaultLanguage(lang) {
  if (lang && typeof lang === 'string') _defaultLang = lang;
}

/** Return the currently active language tag. */
function getLanguage() {
  return _currentLang;
}

var StringManager = {
  t: t,
  registerCore: registerCore,
  registerPack: registerPack,
  unregisterPack: unregisterPack,
  setLanguage: setLanguage,
  setDefaultLanguage: setDefaultLanguage,
  getLanguage: getLanguage,
};

// CommonJS export (Node.js / Electron main + renderer via require)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StringManager;
}

// Browser global (plain <script> tag in shells / game iframes)
if (typeof window !== 'undefined') {
  window.StringManager = StringManager;
}
