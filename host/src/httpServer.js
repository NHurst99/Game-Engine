const express = require('express');
const http = require('http');
const path = require('path');

/**
 * Create and configure the Express + HTTP server.
 *
 * Serves:
 *   GET /                → player shell index.html
 *   GET /shell.js        → player shell JS
 *   GET /shell.css       → player shell CSS
 *   GET /platform-sdk.js → platform SDK injected into game iframes
 *   GET /join            → join landing page (alias for /)
 *   GET /game/*          → static files from the loaded pack directory
 *
 * @returns {{ app, httpServer }}
 */
function createHttpServer() {
  const app = express();

  // Security headers on all responses
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // ── Player Shell routes ──────────────────────────────────────────────────

  const playerShellDir = path.resolve(__dirname, '../../player-shell/src');

  app.get('/', (_req, res) => {
    res.sendFile(path.join(playerShellDir, 'index.html'), (err) => {
      if (err) {
        res.status(404).send('Player shell not found. Phase 3 not yet implemented.');
      }
    });
  });

  app.get('/join', (_req, res) => {
    res.redirect('/');
  });

  app.get('/shell.js', (_req, res) => {
    res.sendFile(path.join(playerShellDir, 'shell.js'), (err) => {
      if (err) res.status(404).send('');
    });
  });

  app.get('/shell.css', (_req, res) => {
    res.sendFile(path.join(playerShellDir, 'overlay.css'), (err) => {
      if (err) res.status(404).send('');
    });
  });

  // ── Platform SDK ─────────────────────────────────────────────────────────
  // Served to game iframes. Phase 3 will create the actual file.

  const platformSdkPath = path.resolve(__dirname, '../../player-shell/src/platform-sdk.js');

  app.get('/platform-sdk.js', (_req, res) => {
    res.sendFile(platformSdkPath, (err) => {
      if (err) {
        // Serve a minimal stub so game HTML doesn't 404 before Phase 3
        res.type('application/javascript').send(
          '// platform-sdk.js stub — full implementation in Phase 3\n' +
          'window.platform = window.platform || {};\n'
        );
      }
    });
  });

  // ── Pack assets — mounted dynamically ────────────────────────────────────

  // Placeholder; mountPackAssets() replaces this when a pack loads
  let packRouter = null;

  app.use('/game', (req, res, next) => {
    if (packRouter) return packRouter(req, res, next);
    res.status(404).send('No game pack loaded');
  });

  const httpServer = http.createServer(app);

  return {
    app,
    httpServer,

    /**
     * Mount a pack's extracted directory as static assets under /game/*.
     * @param {string} packDir — absolute path to the extracted pack
     */
    mountPackAssets(packDir) {
      packRouter = express.static(packDir, {
        dotfiles: 'deny',
        index: false,
      });
    },

    /**
     * Unmount pack assets.
     */
    unmountPackAssets() {
      packRouter = null;
    },
  };
}

module.exports = { createHttpServer };
