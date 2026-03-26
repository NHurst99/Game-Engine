# Manifest Specification — `manifest.json`

Every `.boardgame` pack must contain a `manifest.json` at its root. This file is the single source of truth for everything the platform needs to know before running the game. The platform validates this file before executing any pack code.

---

## Full Schema

```jsonc
{
  // ─── IDENTITY ───────────────────────────────────────────────────────────────

  "id": "com.yourname.gamename",
  // Required. Reverse-domain unique identifier. Used for save state namespacing
  // and conflict detection when two packs share the same display name.
  // Pattern: ^[a-z0-9]+(\.[a-z0-9]+)+$
  // Examples: "com.nickgames.catan", "io.itch.username.mytrivia"

  "name": "Settlers of Example",
  // Required. Human-readable display name shown in the platform lobby.
  // Max 64 characters.

  "version": "1.0.0",
  // Required. Semantic version string. Used to warn players if their
  // host and a pack file version differ during a resumed session.
  // Pattern: ^\d+\.\d+\.\d+$

  "description": "A resource trading game for 3–5 players.",
  // Optional. Shown in the game picker UI. Max 280 characters.

  "author": "Nick",
  // Optional. Display name of the creator.

  "authorUrl": "https://example.com",
  // Optional. URL to author homepage or pack repository.

  "license": "MIT",
  // Optional. SPDX license identifier or "Proprietary".

  "tags": ["strategy", "trading", "resource-management"],
  // Optional. Array of lowercase strings. Used for filtering in the game picker.
  // Max 10 tags, each max 32 characters.


  // ─── PLAYERS ────────────────────────────────────────────────────────────────

  "players": {
    "min": 3,
    // Required. Minimum number of human players to start the game.
    // Must be >= 1.

    "max": 5,
    // Required. Maximum number of human players.
    // Must be >= min.

    "supportsBot": true,
    // Optional. Default: false.
    // If true, the platform may offer AI/bot fill-in for missing players.
    // The game pack must handle a "bot" player type (see SOCKET_API.md).

    "supportsSpectator": false
    // Optional. Default: false.
    // If true, additional clients may connect in spectator mode.
    // Spectators receive board-level state only, no private player state.
  },


  // ─── ENTRY POINTS ───────────────────────────────────────────────────────────

  "entry": {
    "server": "server/game.js",
    // Required. Path (relative to pack root) of the authoritative game logic
    // script. Runs in a Node.js Worker thread or vm2 sandbox on the host.
    // This script receives a `GameContext` object — see SOCKET_API.md.
    // Must be a .js file. ES modules (import/export) are NOT supported inside
    // the sandbox; use CommonJS (module.exports / require-like context globals).

    "board": "board/board.html",
    // Required. Path to the HTML file rendered in the TV's board view.
    // Loaded inside an <iframe sandbox="allow-scripts"> on the host machine.
    // Communicates with the platform via window.postMessage only.
    // Has access to: window, document, Canvas API, WebGL, Web Audio.
    // Does NOT have access to: fetch (blocked), localStorage, parent window DOM.

    "player": "player/hand.html",
    // Required. Path to the HTML file rendered on each player's phone.
    // Same sandbox restrictions as board.html.
    // The platform injects the player's identity before loading this page
    // (see Shell Injection below).

    "lobby": "lobby/lobby.html",
    // Optional. Path to a custom lobby/waiting room screen shown on the board
    // display before the game starts. If omitted, the platform renders a
    // default lobby showing connected players and a "Start Game" button.

    "settings": "settings/settings.html"
    // Optional. Path to a pre-game settings panel rendered on the board display.
    // Shown after lobby, before game start. Allows host to configure game
    // options. Settings values are passed to server/game.js at game init.
    // If omitted, no settings screen is shown.
  },


  // ─── ASSETS ─────────────────────────────────────────────────────────────────

  "assets": {
    "icon": "assets/icon.png",
    // Optional. 512x512 PNG shown in the game picker and lobby.
    // Recommended, but falls back to a platform default if missing.

    "preview": "assets/preview.png",
    // Optional. 1280x720 PNG screenshot shown in the game picker detail view.

    "fonts": [
      {
        "family": "GameFont",
        "src": "assets/fonts/GameFont-Regular.woff2",
        "weight": "400",
        "style": "normal"
      }
    ],
    // Optional. Fonts declared here are injected into both board.html and
    // player/hand.html as @font-face rules before the page loads.
    // Supported formats: woff2, woff, ttf.
    // Max total font payload: 5MB.

    "audio": {
      "preload": [
        "assets/audio/roll.ogg",
        "assets/audio/win.ogg"
      ]
    }
    // Optional. Audio files listed here are preloaded by the platform shell
    // and made available to the board/player HTML via a platform audio API.
    // See SOCKET_API.md → Platform APIs → Audio.
    // Supported formats: ogg, mp3, wav.
  },


  // ─── CAPABILITIES ───────────────────────────────────────────────────────────

  "capabilities": {
    "touchBoard": true,
    // Optional. Default: false.
    // If true, the platform enables pointer/touch events on the board iframe
    // and routes touch actions to the game server as BOARD_ACTION events.
    // Only meaningful if the TV is a touchscreen.

    "sharedScreen": false,
    // Optional. Default: true.
    // Set to false for games that run entirely on phones with no board display.
    // If false, the "board" entry point is ignored.

    "offlineAssets": true,
    // Optional. Default: true.
    // If true, all assets must be bundled in the pack (no CDN URLs in HTML).
    // The platform will warn if external URLs are detected in board/player HTML.
    // Set to false only if your game requires external API access (e.g. trivia).

    "persistState": true,
    // Optional. Default: false.
    // If true, the platform will snapshot game state periodically and on exit.
    // The game server will receive a RESTORE_STATE event on next launch with
    // the last saved state blob. The game pack is responsible for serializing
    // its own state into a JSON-safe object.

    "maxStateSize": 512
    // Optional. Only used if persistState: true. Default: 512 (kilobytes).
    // Maximum size of the serialized state blob the platform will store.
    // Hard cap: 10240 (10MB).
  },


  // ─── PLATFORM REQUIREMENTS ──────────────────────────────────────────────────

  "requires": {
    "platformVersion": ">=1.0.0",
    // Optional. SemVer range. The platform checks this against its own version
    // and refuses to load the pack if incompatible.

    "features": ["touch", "audio"]
    // Optional. Array of platform feature flags the game requires.
    // If a required feature is unavailable, the platform warns the host before
    // starting. Known feature flags:
    //   "touch"       — touchscreen board display
    //   "audio"       — Web Audio API available
    //   "fullscreen"  — platform is running fullscreen
    //   "highDPI"     — display pixel ratio >= 2
  },


  // ─── LOCALIZATION ───────────────────────────────────────────────────────────

  "locales": {
    "default": "en",
    // Optional. Default: "en". BCP 47 language tag for the pack's default locale.

    "available": ["en", "es", "fr"],
    // Optional. Array of supported locales. If the platform's locale matches
    // one of these, it passes the locale string to the game server at init.

    "strings": "assets/i18n/{locale}.json"
    // Optional. Path template for locale string files. The platform loads the
    // matched locale file and makes it available to board/player HTML via the
    // platform API: platform.t("key").
  },


  // ─── RULES / HELP ───────────────────────────────────────────────────────────

  "docs": {
    "rules": "docs/rules.md",
    // Optional. Path to a Markdown file with game rules.
    // Rendered by the platform in a scrollable overlay accessible from the lobby.

    "quickstart": "docs/quickstart.md"
    // Optional. A shorter rules summary, shown before game start if present.
  }
}
```

---

## Validation Rules

The platform performs the following checks when loading a pack. A **hard failure** aborts loading. A **warning** proceeds but notifies the host.

| Check | Severity |
| --- | --- |
| `manifest.json` is valid JSON | Hard failure |
| `id` matches pattern `^[a-z0-9]+(\.[a-z0-9]+)+$` | Hard failure |
| `version` matches semver pattern | Hard failure |
| `name` present and non-empty | Hard failure |
| `players.min` and `players.max` are positive integers, min ≤ max | Hard failure |
| `entry.server` file exists in pack | Hard failure |
| `entry.board` file exists in pack | Hard failure |
| `entry.player` file exists in pack | Hard failure |
| `entry.lobby` file exists if specified | Hard failure |
| `entry.settings` file exists if specified | Hard failure |
| `assets.icon` file exists if specified | Warning |
| All `assets.fonts[].src` files exist | Warning |
| All `assets.audio.preload` files exist | Warning |
| `requires.platformVersion` satisfied | Hard failure |
| All `requires.features` available on host | Warning (host may override) |
| `docs.rules` file exists if specified | Warning |

---

## Shell Injection

Before loading `player/hand.html` in a player's browser, the platform injects the following into the iframe's `window` object via `postMessage` initialization handshake:

```json
{
  "type": "PLATFORM_INIT",
  "payload": {
    "playerId": "p1",
    "playerName": "Nick",
    "playerIndex": 0,
    "gameId": "com.nickgames.catan",
    "gameName": "Settlers of Example",
    "locale": "en",
    "fonts": [ ... ],
    "audioPreloaded": ["roll", "win"]
  }
}
```

The `player/hand.html` script should wait for this message before rendering anything player-specific. See `DOCS/SOCKET_API.md → Initialization Flow`.

---

## Minimal Valid Manifest

The smallest valid `manifest.json`:

```json
{
  "id": "com.example.mygame",
  "name": "My Game",
  "version": "1.0.0",
  "players": { "min": 2, "max": 4 },
  "entry": {
    "server": "server/game.js",
    "board": "board/board.html",
    "player": "player/hand.html"
  }
}
```

---

## Versioning and Pack Updates

When the platform detects a pack with the same `id` but a different `version` already loaded:

- If major version changed: warn host, do not auto-replace
- If minor/patch version changed: silently replace, keep saved state if `persistState: true`

Saved state is namespaced as `{id}@{major}.x` so minor updates don't break saves.

---

## File Size Limits

| Category | Limit |
| --- | --- |
| Total pack size | 500 MB |
| Single asset file | 100 MB |
| `server/game.js` (and all required files) | 10 MB |
| `manifest.json` | 64 KB |
| Each locale string file | 1 MB |

These are soft limits enforced with warnings. Hard cap at 2x each value.
