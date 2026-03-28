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
const libraryManager = require('./libraryManager');
const settingsManager = require('./settingsManager');

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
let serverInfo = null;    // { port, joinUrl, qrDataUrl, allIPs }

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow(isFullscreen) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: isFullscreen,
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

  // Windows Firewall — add inbound rule for the chosen port
  const fwResult = await networkDiscovery.ensureFirewallRule(serverPort);
  if (!fwResult.ok) {
    console.warn('[HOST] Firewall rule not added — showing guidance dialog');
    // Show dialog after window is ready (don't block server startup)
    setImmediate(() => {
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Allow Players to Connect',
          message: `Windows Firewall may block phones from joining on port ${serverPort}.`,
          detail:
            'To fix: open Windows Defender Firewall → Advanced Settings → Inbound Rules → ' +
            `New Rule → Port → TCP ${serverPort} → Allow the Connection.\n\n` +
            'Or run this app as Administrator to set the rule automatically.',
          buttons: ['OK'],
        });
      }
    });
  }

  // mDNS + QR
  networkDiscovery.advertise(serverPort);
  const joinInfo = await networkDiscovery.generateJoinInfo(serverPort);
  console.log(`[HOST] Join URL: ${joinInfo.joinUrl}`);
  if (joinInfo.allIPs.length > 1) {
    console.log(`[HOST] All LAN IPs: ${joinInfo.allIPs.map(i => `${i.address} (${i.iface})`).join(', ')}`);
  }

  // Store server info for board shell and menu
  serverInfo = {
    port: serverPort,
    joinUrl: joinInfo.joinUrl,
    qrDataUrl: joinInfo.qrDataUrl,
    allIPs: joinInfo.allIPs,
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

  // Tell socket server about the new game (pass locale data so it reaches players)
  socketServer.loadGame(result.manifest, result.packLocales);

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
      packLocales: currentPack.packLocales || {},
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
  return { ...settingsManager.loadSettings(), debug: DEBUG };
});

ipcMain.handle('menu:settings-save', (_event, newSettings) => {
  settingsManager.saveSettings(newSettings);
  if (mainWindow) {
    mainWindow.setFullScreen(!!newSettings.fullscreen);eeeeeeeeeeeee
ipcMain.handle('menu:get-server-info', () => {
  return serverInfo;
});

ipcMain.handle('menu:get-network-info', () => {
  if (!serverInfo) return null;
  return {
    primaryUrl: serverInfo.joinUrl,
    port: serverInfo.port,
    allUrls: (serverInfo.allIPs || []).map(({ iface, address }) => ({
      iface,
      url: `http://${address}:${serverInfo.port}`,
    })),
  };
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
            packLocales: currentPack.packLocales || {},
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
  createWindow(settingsManager.getSetting('fullscreen'));

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
    createWindow(settingsManager.getSetting('fullscreen')); // pass current fullscreen setting to new window
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
