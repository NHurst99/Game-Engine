const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const semver = require('semver');

/**
 * StateStore — persist and restore game state blobs to disk.
 *
 * Storage layout:
 *   {userData}/saves/{packId}/{majorVersion}/latest.json
 */
class StateStore {
  constructor() {
    this.basePath = path.join(app.getPath('userData'), 'saves');
  }

  /**
   * Save a game state blob to disk.
   * @param {object} manifest — the pack manifest (needs id, version)
   * @param {object[]} players — player list [{ id, name }]
   * @param {object} state — opaque game state blob from SAVE_STATE_RESPONSE
   */
  save(manifest, players, state) {
    const savePath = this._getSavePath(manifest);
    const saveDir = path.dirname(savePath);

    fs.mkdirSync(saveDir, { recursive: true });

    const saveData = {
      packId: manifest.id,
      packVersion: manifest.version,
      savedAt: new Date().toISOString(),
      players: players.map((p) => ({ id: p.id, name: p.name })),
      state,
    };

    fs.writeFileSync(savePath, JSON.stringify(saveData, null, 2), 'utf8');
    console.log(`[STATE] Saved state for ${manifest.id} v${manifest.version}`);
  }

  /**
   * Load a saved state blob from disk, if one exists.
   * @param {object} manifest — the pack manifest
   * @returns {{ state, savedAt, packVersion } | null}
   */
  load(manifest) {
    const savePath = this._getSavePath(manifest);

    if (!fs.existsSync(savePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(savePath, 'utf8');
      const saveData = JSON.parse(raw);
      return {
        state: saveData.state,
        savedAt: saveData.savedAt,
        packVersion: saveData.packVersion,
      };
    } catch (err) {
      console.warn(`[STATE] Failed to load saved state: ${err.message}`);
      return null;
    }
  }

  /**
   * Delete saved state for a pack.
   */
  clear(manifest) {
    const savePath = this._getSavePath(manifest);
    try {
      fs.unlinkSync(savePath);
    } catch { /* file may not exist */ }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _getSavePath(manifest) {
    const major = semver.major(manifest.version);
    return path.join(this.basePath, manifest.id, `${major}.x`, 'latest.json');
  }
}

module.exports = StateStore;
