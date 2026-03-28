const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const settingsManager = require('./settingsManager');


const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function scanLibrary() {
  const games = [];

  let entries = [];
  try {
    for (const libraryPath of settingsManager.getSetting('libraryPaths')) {
        if (!fs.existsSync(libraryPath)) {
            fs.mkdirSync(libraryPath, { recursive: true });
        }
        fs.readdirSync(libraryPath).forEach(f => {
            const fullPath = path.join(libraryPath, f);
            if (fs.statSync(fullPath).isFile() && f.endsWith('.boardgame')) {
                entries.push(fullPath);
            } 
        //entries = entries.concat(fs.readdirSync(libraryPath).map(f => path.join(libraryPath, f)));
       // if 
        });
    }
  } catch {
    return games;
  }

  for (const filePath of entries) {
    // if (!file.endsWith('.boardgame')) continue;
    // const filePath = path.join(libraryPath, file);

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

module.exports = { scanLibrary };