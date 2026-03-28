/**
 * build.js — packages the Tic-Tac-Toe example into a .boardgame file.
 *
 * Usage (from repo root or this directory):
 *   node example-games/example-tictactoe/build.js
 *
 * Output: example-games/example-tictactoe/com.example.tictactoe.boardgame
 *
 * Requires adm-zip (already a project dependency):
 *   npm install  (from repo root)
 */

'use strict';

const AdmZip = require('adm-zip');
const path   = require('path');
const fs     = require('fs');

const SRC_DIR = __dirname;
const OUT     = path.join(SRC_DIR, 'com.example.tictactoe.boardgame');

// Files to include in the ZIP, relative to SRC_DIR
const ENTRIES = [
  'manifest.json',
  'server/game.js',
  'board/board.html',
  'player/hand.html',
];

const zip = new AdmZip();

for (const entry of ENTRIES) {
  const abs = path.join(SRC_DIR, entry);
  if (!fs.existsSync(abs)) {
    console.error('Missing file:', abs);
    process.exit(1);
  }
  // addFile(zipPath, buffer, comment, attrs)
  zip.addFile(entry, fs.readFileSync(abs));
  console.log('  +', entry);
}

zip.writeZip(OUT);
console.log('\nBuilt:', path.relative(process.cwd(), OUT));
