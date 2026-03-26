const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const semver = require('semver');

const PLATFORM_VERSION = '1.0.0';

// Tracked temp dirs for cleanup
const extractedDirs = [];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load, validate, and extract a .boardgame pack.
 * @param {string} filePath — absolute path to the .boardgame file
 * @returns {{ manifest: object, packDir: string, warnings: string[] }}
 * @throws on hard validation failure
 */
function load(filePath) {
  const warnings = [];

  // 1. File exists and is readable
  if (!fs.existsSync(filePath)) {
    throw new PackError(`Pack file does not exist: ${filePath}`);
  }

  // 2. Valid ZIP
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (err) {
    throw new PackError(`Pack is not a valid ZIP file: ${err.message}`);
  }

  // 3. manifest.json exists in ZIP root
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new PackError('Pack is missing manifest.json at root');
  }

  // 4. Parse manifest as JSON
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (err) {
    throw new PackError(`manifest.json is not valid JSON: ${err.message}`);
  }

  // 5. Validate required fields
  validateManifest(manifest, zip, warnings);

  // 6. Security checks on ZIP entries
  const tmpDir = path.join(os.tmpdir(), `boardgame-${manifest.id}-${Date.now()}`);
  const extractBase = path.resolve(tmpDir);

  checkZipSecurity(zip, extractBase, warnings);

  // 7. Extract
  zip.extractAllTo(tmpDir, true);
  extractedDirs.push(tmpDir);

  return { manifest, packDir: tmpDir, warnings };
}

/**
 * Clean up a specific extracted pack directory.
 */
function cleanup(packDir) {
  try {
    fs.rmSync(packDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
  const idx = extractedDirs.indexOf(packDir);
  if (idx !== -1) extractedDirs.splice(idx, 1);
}

/**
 * Clean up ALL extracted pack directories. Call on app quit.
 */
function cleanupAll() {
  for (const dir of extractedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
  extractedDirs.length = 0;
}

// ─── Manifest Validation ─────────────────────────────────────────────────────

function validateManifest(manifest, zip, warnings) {
  // id: required, pattern ^[a-z0-9]+(\.[a-z0-9]+)+$
  if (!manifest.id || !/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(manifest.id)) {
    throw new PackError(
      `Invalid or missing "id": must match pattern ^[a-z0-9]+(\\.[a-z0-9]+)+$ (got "${manifest.id}")`
    );
  }

  // name: required, non-empty
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new PackError('Missing or empty "name" in manifest');
  }

  // version: required, semver
  if (!manifest.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new PackError(
      `Invalid or missing "version": must be semver x.y.z (got "${manifest.version}")`
    );
  }

  // players: required, min >= 1, max >= min
  if (!manifest.players || typeof manifest.players !== 'object') {
    throw new PackError('Missing "players" object in manifest');
  }
  const { min, max } = manifest.players;
  if (!Number.isInteger(min) || min < 1) {
    throw new PackError(`"players.min" must be a positive integer (got ${min})`);
  }
  if (!Number.isInteger(max) || max < min) {
    throw new PackError(`"players.max" must be an integer >= min (got max=${max}, min=${min})`);
  }

  // entry: required files must exist in ZIP
  if (!manifest.entry || typeof manifest.entry !== 'object') {
    throw new PackError('Missing "entry" object in manifest');
  }
  for (const key of ['server', 'board', 'player']) {
    const entryPath = manifest.entry[key];
    if (!entryPath) {
      throw new PackError(`Missing required entry point: "entry.${key}"`);
    }
    if (!zip.getEntry(entryPath)) {
      throw new PackError(`Entry file not found in pack: entry.${key} = "${entryPath}"`);
    }
  }
  // Optional entry points — hard fail if specified but missing
  for (const key of ['lobby', 'settings']) {
    const entryPath = manifest.entry[key];
    if (entryPath && !zip.getEntry(entryPath)) {
      throw new PackError(`Optional entry file specified but missing: entry.${key} = "${entryPath}"`);
    }
  }

  // requires.platformVersion — check compatibility
  if (manifest.requires?.platformVersion) {
    if (!semver.satisfies(PLATFORM_VERSION, manifest.requires.platformVersion)) {
      throw new PackError(
        `Pack requires platform version ${manifest.requires.platformVersion}, ` +
        `but current platform is ${PLATFORM_VERSION}`
      );
    }
  }

  // ── Warnings (non-fatal) ──────────────────────────────────────────────────

  // assets.icon
  if (manifest.assets?.icon && !zip.getEntry(manifest.assets.icon)) {
    warnings.push(`Icon file not found in pack: "${manifest.assets.icon}"`);
  }

  // assets.fonts
  if (manifest.assets?.fonts) {
    for (const font of manifest.assets.fonts) {
      if (font.src && !zip.getEntry(font.src)) {
        warnings.push(`Font file not found in pack: "${font.src}"`);
      }
    }
  }

  // assets.audio.preload
  if (manifest.assets?.audio?.preload) {
    for (const audioPath of manifest.assets.audio.preload) {
      if (!zip.getEntry(audioPath)) {
        warnings.push(`Audio file not found in pack: "${audioPath}"`);
      }
    }
  }

  // docs.rules
  if (manifest.docs?.rules && !zip.getEntry(manifest.docs.rules)) {
    warnings.push(`Rules file not found in pack: "${manifest.docs.rules}"`);
  }

  // requires.features
  if (manifest.requires?.features) {
    for (const feat of manifest.requires.features) {
      warnings.push(`Pack requires platform feature "${feat}" — availability not checked`);
    }
  }
}

// ─── ZIP Security ────────────────────────────────────────────────────────────

const EXECUTABLE_EXTS = new Set(['.exe', '.sh', '.bat', '.command', '.ps1']);
const HARD_SIZE_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GB

function checkZipSecurity(zip, extractBase, warnings) {
  let totalSize = 0;

  for (const entry of zip.getEntries()) {
    // Path traversal
    const entryPath = path.resolve(extractBase, entry.entryName);
    if (!entryPath.startsWith(extractBase + path.sep) && entryPath !== extractBase) {
      throw new PackError(`Path traversal detected in pack: ${entry.entryName}`);
    }

    // Symlinks
    if (entry.isDirectory === false && (entry.header.attr & 0o120000) === 0o120000) {
      throw new PackError(`Symlink detected in pack: ${entry.entryName}`);
    }

    // Executables — warn only
    const ext = path.extname(entry.entryName).toLowerCase();
    if (EXECUTABLE_EXTS.has(ext)) {
      warnings.push(`Executable file in pack: ${entry.entryName}`);
    }

    // ZIP bomb check
    totalSize += entry.header.size;
    if (totalSize > HARD_SIZE_LIMIT) {
      throw new PackError('Pack extraction would exceed size limit (possible ZIP bomb)');
    }
  }
}

// ─── Error Class ─────────────────────────────────────────────────────────────

class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
  }
}

module.exports = { load, cleanup, cleanupAll, PackError, PLATFORM_VERSION };
