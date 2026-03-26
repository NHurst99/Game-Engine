# Sandboxing & Security Model

This document describes how the platform isolates game pack code from the host system and from other participants.

---

## Threat Model

### Scope

This platform runs on a **local home network** among trusted people. The threat model is NOT "adversarial users trying to attack the host machine." The threat model is:

1. **Buggy game scripts** that accidentally crash or hang the host
2. **Well-meaning but careless game scripts** that use `require('fs')` or `fetch()` unintentionally
3. **Community-distributed packs** from unknown authors that could contain malicious code
4. **CSS/JS bleed** between game pack UI and platform shell

This guides the security decisions below: we prioritize isolation and crash-safety over defense against sophisticated attacks.

---

## Layer 1: Game Script Sandbox (server/game.js)

### What It Is

`server/game.js` runs in a Node.js **Worker thread** inside a **`vm.runInContext`** execution context. The context is a plain object with no access to Node.js APIs.

### What's Blocked

| API | Blocked? | Why |
| --- | --- | --- |
| `require()` | ✅ Yes | Not exposed in vm context |
| `import()` | ✅ Yes | Not a module context |
| `process` | ✅ Yes | Not in context |
| `fs`, `net`, `http` | ✅ Yes | Require is blocked |
| `fetch`, `XMLHttpRequest` | ✅ Yes | Not available in Node vm context |
| `setTimeout`, `setInterval` | ✅ Yes | Not exposed; use `ctx.timer()` |
| `globalThis` | ✅ Yes | Not exposed |
| `Buffer` | ✅ Yes | Not exposed |
| `__dirname`, `__filename` | ✅ Yes | Not exposed |

### What's Available

| API | Available? | Notes |
| --- | --- | --- |
| `ctx` | ✅ Yes | Full GameContext API |
| `console.log/warn/error` | ✅ Yes | Routes to host log only |
| `Math`, `JSON` | ✅ Yes | Safe standard globals |
| `Map`, `Set`, `Array`, etc. | ✅ Yes | Standard JS |
| `Promise`, `async/await` | ✅ Yes | Safe |
| `Error`, `TypeError` | ✅ Yes | Safe |

### Known Limitations

**vm.runInContext is not a true sandbox.** A sophisticated attacker can escape it using prototype pollution techniques (e.g., `{}.constructor.constructor('return process')()`). For personal/family use, this is acceptable. For public pack distribution, see "Subprocess Hardening" below.

### Synchronous Execution Timeout

`vm.runInContext` is called with `timeout: 5000`. This prevents infinite loops at the top level of the script (i.e., code that runs synchronously on load). Event handler callbacks do NOT have a timeout — a blocking handler will hang the Worker.

**Mitigation:** The host watchdog (in `gameRunner.js`) monitors time-since-last-message. If the game stops communicating for > 30 seconds during play, it is considered hung and the host can offer to kill/restart it.

---

## Layer 2: Board and Player HTML Isolation

### iframe Sandboxing

Both `board/board.html` and `player/hand.html` load inside `<iframe>` elements.

The recommended sandbox attribute:

```html
<iframe sandbox="allow-scripts allow-same-origin">
```

| Flag | Effect |
| --- | --- |
| `allow-scripts` | Game JS can run |
| `allow-same-origin` | Allows reading/writing to the same origin — needed for some canvas APIs |
| `allow-forms` | **Not included** — prevents form submission navigation |
| `allow-top-navigation` | **Not included** — prevents redirecting the parent page |
| `allow-popups` | **Not included** — prevents opening new windows |

**Note on `allow-same-origin`:** In Electron, `board.html` is loaded as a local file. Without `allow-same-origin`, certain Canvas and Web Audio operations may fail. This is a practical tradeoff; the pack is already trusted enough to run `server/game.js` as a Worker, so allowing same-origin in the iframe is consistent.

On the player's phone, `player/hand.html` is served via HTTP from the host. Same-origin here means the iframe and the shell share the same HTTP origin (e.g. `http://192.168.1.5:3000`). Pack JS in the iframe cannot access the shell's DOM because of the iframe boundary, but it can make `fetch()` requests to `http://192.168.1.5:3000`.

**To prevent pack player HTML from making arbitrary requests:**

- Option A: Serve the pack's player HTML from a different port (e.g. `:3001`) than the WebSocket/shell (`:3000`). Then the player iframe is a different origin, and you can use a strict sandbox.
- Option B: Accept this for a local home game and document it.

### CSS Isolation

CSS inside an iframe is fully isolated from the parent page. No special action needed. The game's CSS cannot affect the shell, and vice versa.

### JavaScript Isolation

JS inside an iframe cannot access `window.parent.*` properties (blocked by same-origin policy when origins differ). The only communication channel is `postMessage`, which the shell validates:

```js
window.addEventListener('message', (event) => {
  // Validate origin if using different origins
  // For local file iframes, origin is 'null'
  if (event.source !== knownIframeRef.contentWindow) return;
  // Process message
});
```

---

## Layer 3: Pack Extraction Security

When extracting a `.boardgame` (ZIP) file, the pack loader performs:

1. **Path traversal check**: Every ZIP entry path is resolved against the extraction directory. If the resolved path escapes the temp dir, extraction is aborted and the temp dir is deleted.

2. **Symlink rejection**: ZIP entries marked as symlinks are skipped.

3. **File type logging**: `.exe`, `.sh`, `.bat`, `.command`, `.ps1` files are logged as warnings. They are extracted but never executed by the platform.

4. **ZIP bomb detection**: If the total uncompressed size of all entries exceeds the pack size limit (2GB), extraction is aborted before it completes.

```js
let totalUncompressedBytes = 0;
const HARD_LIMIT = 2 * 1024 * 1024 * 1024; // 2GB

for (const entry of zip.getEntries()) {
  totalUncompressedBytes += entry.header.size;
  if (totalUncompressedBytes > HARD_LIMIT) {
    throw new Error('Pack extraction would exceed size limit (possible ZIP bomb)');
  }
}
```

---

## Layer 4: Network Exposure

The platform opens a port on the local machine. Consider:

- The HTTP/WebSocket server binds to `0.0.0.0` (all interfaces) by default. Anyone on the local network can connect.
- For home use this is fine — only people on your WiFi can join.
- The platform does NOT implement authentication beyond player IDs.
- Player IDs are simple strings (`p1`, `p2`, etc.) assigned by the host. If a device on the network guesses a player ID, it could impersonate them. This is an acceptable risk for a local game among friends.
- If you want basic protection: generate random UUIDs for player session tokens and require them on reconnect.

---

## Subprocess Hardening (Advanced)

If you want defense against `vm` sandbox escapes, run the game script in a subprocess instead of a Worker thread:

```text
host process
    │
    │ child_process.fork()
    ▼
game-sandbox/src/sandbox-process.js
    │ vm.runInContext
    ▼
server/game.js
```

Benefits:

- Subprocess can be given `--max-old-space-size=128` to cap memory
- Subprocess crash doesn't affect the host process
- OS-level process isolation

Drawbacks:

- Higher message latency (IPC over pipe vs. shared memory)
- More complex lifecycle management
- Subprocess stdout/stderr must be captured separately

For a version 1.0 local game platform, Worker threads are the right call. Add subprocess isolation in v2 if you're distributing to untrusted users.

---

## Summary Table

| Layer | Mechanism | Protects Against |
| --- | --- | --- |
| Game script | Worker thread + vm.runInContext | Accidental Node API use, crashes isolated |
| Game script | Restricted context (no require) | Filesystem, network access |
| Game script | Synchronous timeout | Top-level infinite loops |
| Game script | Host watchdog | Async hangs |
| Pack extraction | Path traversal check | Malicious ZIP entries |
| Pack extraction | Size limit | ZIP bombs |
| Board/player HTML | iframe sandbox | Parent DOM access, navigation |
| Board/player HTML | postMessage validation | Spoofed messages |
| Network | Local binding | Internet exposure (LAN only) |
