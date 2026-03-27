const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const packLoader = require('./packLoader');
const { createHttpServer } = require('./httpServer');
const SocketServer = require('./socketServer');
const GameRunner = require('./gameRunner');
const StateStore = require('./stateStore');
const networkDiscovery = require('./networkDiscovery');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// ─── Subsystem Instances ──────────────────────────────────────────────────────

let httpCtx = null;      // { app, httpServer, mountPackAssets, unmountPackAssets }
let socketServer = null;  // SocketServer
let gameRunner = null;    // GameRunner (created per game session)
let stateStore = null;    // StateStore
let serverPort = null;    // resolved port

// Current loaded game
let currentPack = null;   // { manifest, packDir, warnings }

// Server info (set after server starts)
let serverInfo = null;    // { port, joinUrl, qrDataUrl }

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  libraryPath: path.join(app.getPath('documents'), 'BoardGames'),
  fullscreen: false,
  audioEnabled: true,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

// ─── Game Library Scanner ─────────────────────────────────────────────────────

function scanLibrary(libraryPath) {
  const games = [];

  if (!fs.existsSync(libraryPath)) {
    fs.mkdirSync(libraryPath, { recursive: true });
  }

  let entries;
  try {
    entries = fs.readdirSync(libraryPath);
  } catch {
    return games;
  }

  for (const file of entries) {
    if (!file.endsWith('.boardgame')) continue;
    const filePath = path.join(libraryPath, file);

    try {
      const zip = new AdmZip(filePath);
      const manifestEntry = zip.getEntry('manifest.json');
      if (!manifestEntry) continue;

      const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
      if (!manifest.id || !manifest.name || !manifest.version) continue;

      let iconDataUrl = null;
      if (manifest.assets?.icon) {
        const iconEntry = zip.getEntry(manifest.assets.icon);
        if (iconEntry) {
          const ext = path.extname(manifest.assets.icon).slice(1).toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'image/png';
          iconDataUrl = `data:${mime};base64,${iconEntry.getData().toString('base64')}`;
        }
      }

      games.push({
        filePath,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || '',
        author: manifest.author || '',
        tags: manifest.tags || [],
        players: manifest.players,
        iconDataUrl,
      });
    } catch {
      // Skip malformed packs silently
    }
  }
  if (DEBUG) {
    for (let x = 1; x <= 5; x++) {
      games.push({
        filePath: `debug-game-${x}.boardgame`,
        id: `com.debug.game${x}`,
        name: `Debug Game ${x}`,
        version: '0.1.0',
        description: 'A game used for testing.',
        author: 'Debug',
        tags: ['debug'],
        players: { min: 2, max: 4 },
        iconDataUrl: null,
      });
    }
  }
  return games;
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow(settings) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: settings.fullscreen,
    frame: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../ui/menu.html'));

  if (DEBUG) {
    console.log('[DEBUG] Debug mode enabled');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function pushPlayersUpdate(players) {
  if (mainWindow) {
    mainWindow.webContents.send('menu:players-update', players);
  }
}

// ─── Server Startup ───────────────────────────────────────────────────────────

async function startServer() {
  // HTTP + Express
  httpCtx = createHttpServer();

  // Socket.io attaches to the HTTP server
  socketServer = new SocketServer();
  socketServer.attach(httpCtx.httpServer);

  // Push player list changes to the menu UI
  socketServer.on('player-list-changed', (players) => {
    pushPlayersUpdate(players);
  });

  // Relay game messages to the board shell (Electron window) via IPC
  socketServer.on('board-message', (msg) => {
    if (mainWindow) {
      mainWindow.webContents.send('board:message', msg);
    }
  });

  // State persistence: listen for save-state events from the game
  stateStore = new StateStore();
  socketServer.on('save-state', (payload) => {
    if (currentPack?.manifest && payload?.state) {
      const players = socketServer.getPlayersForGameInit();
      stateStore.save(currentPack.manifest, players, payload.state);
    }
  });

  // Dynamic port selection
  // get-port v7 is ESM-only, so we use a dynamic import
  const { default: getPort, portNumbers } = await import('get-port');
  serverPort = await getPort({ port: portNumbers(3000, 3100) });

  // Start listening
  await new Promise((resolve) => {
    httpCtx.httpServer.listen(serverPort, '0.0.0.0', resolve);
  });
  console.log(`[HOST] HTTP + WebSocket server listening on port ${serverPort}`);

  // mDNS + QR
  networkDiscovery.advertise(serverPort);
  const joinInfo = await networkDiscovery.generateJoinInfo(serverPort);
  console.log(`[HOST] Join URL: ${joinInfo.joinUrl}`);

  // Store server info for board shell
  serverInfo = {
    port: serverPort,
    joinUrl: joinInfo.joinUrl,
    qrDataUrl: joinInfo.qrDataUrl,
  };

  // Send server info to the menu renderer
  if (mainWindow) {
    mainWindow.webContents.send('menu:server-ready', serverInfo);
  }
}

// ─── Game Session Lifecycle ───────────────────────────────────────────────────

async function loadGamePack(filePath) {
  // Clean up previous pack if any
  if (currentPack) {
    if (gameRunner?.isRunning) {
      gameRunner.stop();
    }
    httpCtx.unmountPackAssets();
    packLoader.cleanup(currentPack.packDir);
    currentPack = null;
  }

  // Load + validate
  const result = packLoader.load(filePath);
  currentPack = result;

  if (result.warnings.length > 0) {
    console.warn('[PACK] Warnings:', result.warnings);
  }

  // Mount pack assets for player HTTP access
  httpCtx.mountPackAssets(result.packDir);

  // Tell socket server about the new game
  socketServer.loadGame(result.manifest);

  console.log(`[HOST] Loaded pack: ${result.manifest.name} v${result.manifest.version}`);

  return {
    ok: true,
    name: result.manifest.name,
    id: result.manifest.id,
    version: result.manifest.version,
    warnings: result.warnings,
    players: result.manifest.players,
  };
}

async function startGame() {
  if (!currentPack) {
    return { ok: false, error: 'No pack loaded' };
  }

  const { manifest, packDir } = currentPack;

  // Create a new GameRunner for this session
  gameRunner = new GameRunner();

  // Wire into socket server
  socketServer.setGameRunner(gameRunner);

  gameRunner.on('error', (err) => {
    console.error('[GAME] Error:', err.message);
    if (mainWindow) {
      mainWindow.webContents.send('menu:game-error', { message: err.message });
      mainWindow.webContents.send('board:message', {
        type: 'ERROR',
        payload: { message: err.message, fatal: true },
      });
    }
  });

  gameRunner.on('exit', (code) => {
    console.log(`[GAME] Sandbox exited with code ${code}`);
    socketServer.endGame();
    gameRunner = null;
  });

  gameRunner.on('ready', () => {
    console.log('[GAME] Game sandbox ready');
    // Notify existing lobby players that they are connected
    socketServer.notifyExistingPlayersConnected();

    // Send GAME_STARTED to board shell with boardHtmlPath
    const boardHtmlPath = `/game/${manifest.entry.board}`;
    const playerHtmlPath = `/game/${manifest.entry.player}`;
    if (mainWindow) {
      mainWindow.webContents.send('board:message', {
        type: 'GAME_STARTED',
        payload: { boardHtmlPath, playerHtmlPath },
      });
    }

    // Restore state if applicable
    if (manifest.capabilities?.persistState) {
      const saved = stateStore.load(manifest);
      if (saved) {
        console.log(`[GAME] Restoring saved state from ${saved.savedAt}`);
        gameRunner.send({
          type: 'RESTORE_STATE',
          payload: saved,
        });
      }
    }
  });

  // Start the sandbox
  await gameRunner.start(packDir, manifest);

  // Send GAME_INIT
  const players = socketServer.getPlayersForGameInit();
  gameRunner.send({
    type: 'GAME_INIT',
    payload: {
      players,
      settings: {},
      locale: manifest.locales?.default || 'en',
      platformVersion: packLoader.PLATFORM_VERSION,
      packVersion: manifest.version,
    },
  });

  return { ok: true };
}

function stopGame() {
  if (gameRunner?.isRunning) {
    // Save state before stopping if applicable
    if (currentPack?.manifest?.capabilities?.persistState) {
      gameRunner.requestStateSave('quit');
      // Give 3s for save, then kill
      setTimeout(() => {
        gameRunner?.stop();
      }, 3000);
    } else {
      gameRunner.stop();
    }
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('menu:settings-get', () => {
  return { ...loadSettings(), debug: DEBUG };
});

ipcMain.handle('menu:settings-save', (_event, newSettings) => {
  saveSettings(newSettings);
  if (mainWindow) {
    mainWindow.setFullScreen(!!newSettings.fullscreen);
  }
  return { ok: true };
});

ipcMain.handle('menu:get-games', (_event, libraryPath) => {
  return scanLibrary(libraryPath);
});

ipcMain.handle('menu:get-server-info', () => {
  return serverInfo;
});

ipcMain.handle('menu:browse-library', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Game Library Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('menu:load-game', async (_event, filePath) => {
  try {
    return await loadGamePack(filePath);
  } catch (err) {
    console.error('[HOST] Failed to load pack:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('menu:start-game', async () => {
  try {
    return await startGame();
  } catch (err) {
    console.error('[HOST] Failed to start game:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('menu:stop-game', () => {
  stopGame();
  return { ok: true };
});

ipcMain.on('menu:exit', () => {
  app.quit();
});

// ─── Board Shell IPC ──────────────────────────────────────────────────────────

ipcMain.handle('menu:enter-lobby', () => {
  if (!mainWindow || !currentPack) return { ok: false };
  mainWindow.loadFile(path.join(__dirname, '../../board-shell/src/index.html'));
  return { ok: true };
});

ipcMain.handle('board:get-info', () => {
  return {
    name: currentPack?.manifest?.name || 'Game',
    id: currentPack?.manifest?.id || '',
    version: currentPack?.manifest?.version || '',
    players: currentPack?.manifest?.players || {},
    joinUrl: serverInfo?.joinUrl || '',
    qrDataUrl: serverInfo?.qrDataUrl || '',
    port: serverInfo?.port || 0,
  };
});

ipcMain.handle('board:back-to-menu', () => {
  if (!mainWindow) return { ok: false };
  // Stop game if running
  stopGame();
  // Unmount pack assets and clear current pack
  if (currentPack) {
    httpCtx?.unmountPackAssets();
    packLoader.cleanup(currentPack.packDir);
    currentPack = null;
  }
  // Reset socket server to idle
  socketServer?.endGame();
  // Navigate back to menu
  mainWindow.loadFile(path.join(__dirname, '../ui/menu.html'));
  return { ok: true };
});

// Forward messages from board shell to host/game
ipcMain.on('board:send', (_event, msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'BOARD_READY') {
    // Board iframe is loaded — send BOARD_INIT back to board shell
    if (currentPack?.manifest && socketServer) {
      const players = socketServer.getPlayersForGameInit();
      if (mainWindow) {
        mainWindow.webContents.send('board:message', {
          type: 'BOARD_INIT',
          payload: {
            players,
            settings: {},
            gameName: currentPack.manifest.name,
            locale: currentPack.manifest.locales?.default || 'en',
          },
        });
      }
      // Re-send last board state if available
      if (socketServer.lastBoardState && mainWindow) {
        mainWindow.webContents.send('board:message', socketServer.lastBoardState);
      }
    }
    return;
  }

  if (msg.type === 'BOARD_ACTION') {
    if (gameRunner?.isRunning) {
      gameRunner.send({ ...msg, from: 'board' });
    }
    return;
  }
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const settings = loadSettings();
  createWindow(settings);

  // Start the HTTP + WS server immediately so players can connect
  try {
    await startServer();
  } catch (err) {
    console.error('[HOST] Failed to start server:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    const settings = loadSettings();
    createWindow(settings);
  }
});

app.on('before-quit', () => {
  stopGame();
  packLoader.cleanupAll();
  networkDiscovery.stopAdvertising();
  socketServer?.close();
});

process.on('uncaughtException', (err) => {
  console.error('[HOST] Uncaught exception:', err);
  packLoader.cleanupAll();
});
