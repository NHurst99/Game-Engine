const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

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

      // Extract icon to a temp data URL if present
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

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('menu:settings-get', () => {
  return { ...loadSettings(), debug: DEBUG };
});

ipcMain.handle('menu:settings-save', (_event, newSettings) => {
  saveSettings(newSettings);
  // Apply fullscreen change immediately
  if (mainWindow) {
    mainWindow.setFullScreen(!!newSettings.fullscreen);
  }
  return { ok: true };
});

ipcMain.handle('menu:get-games', (_event, libraryPath) => {
  return scanLibrary(libraryPath);
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

ipcMain.handle('menu:load-game', (_event, filePath) => {
  // TODO (Phase 2): validate pack and transition to lobby
  // For now, just acknowledge
  return { ok: true, filePath };
});

ipcMain.on('menu:exit', () => {
  app.quit();
});

// ─── Connected Players (stubbed — wired to socketServer in Phase 2) ───────────

// Phase 2 will call pushPlayersUpdate() whenever a player connects/disconnects.
function pushPlayersUpdate(players) {
  if (mainWindow) {
    mainWindow.webContents.send('menu:players-update', players);
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const settings = loadSettings();
  createWindow(settings);
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

module.exports = { pushPlayersUpdate };
