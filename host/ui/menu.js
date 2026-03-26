/* global platform */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let games = [];
let selectedGame = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  settings = await platform.invoke('menu:settings-get');
  await refreshGames();
  wireListeners();

  // Subscribe to player connection updates from main process
  platform.on('menu:players-update', renderPlayers);
}

// ─── Game Library ─────────────────────────────────────────────────────────────

async function refreshGames() {
  games = await platform.invoke('menu:get-games', settings.libraryPath);
  renderGames();
}

function renderGames() {
  const grid = document.getElementById('games-grid');

  if (games.length === 0) {
    grid.innerHTML = `
      <div class="empty-library">
        <div class="empty-icon">🎲</div>
        <p>No games found in<br><strong>${escapeHtml(settings.libraryPath)}</strong><br><br>
        Add <code>.boardgame</code> files there, or change the library folder in Settings.</p>
      </div>`;
    return;
  }

  grid.innerHTML = games.map((game, i) => `
    <div class="game-card" data-index="${i}">
      <div class="game-icon">
        ${game.iconDataUrl
          ? `<img src="${game.iconDataUrl}" alt="">`
          : '🎲'}
      </div>
      <div class="game-info">
        <div class="game-name">${escapeHtml(game.name)}</div>
        <div class="game-meta">
          <span>v${escapeHtml(game.version)}</span>
          <span>·</span>
          <span>${game.players.min}–${game.players.max} players</span>
          ${game.author ? `<span>·</span><span>${escapeHtml(game.author)}</span>` : ''}
        </div>
      </div>
      ${game.description
        ? `<div class="game-description">${escapeHtml(game.description)}</div>`
        : ''}
    </div>
  `).join('');

  grid.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => selectGame(parseInt(card.dataset.index, 10)));
  });
}

function selectGame(index) {
  selectedGame = games[index];

  // Update card selection state
  document.querySelectorAll('.game-card').forEach((card, i) => {
    card.classList.toggle('selected', i === index);
  });

  // Show launch bar
  document.getElementById('launch-name').textContent = selectedGame.name;
  document.getElementById('launch-meta').textContent =
    `${selectedGame.players.min}–${selectedGame.players.max} players  ·  v${selectedGame.version}`;
  document.getElementById('launch-bar').classList.add('visible');
}

// ─── Players Panel ────────────────────────────────────────────────────────────

function renderPlayers(players) {
  const list = document.getElementById('players-list');
  const empty = document.getElementById('no-players');

  if (!players || players.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = players.map(p => `
    <div class="player-row">
      <div class="player-dot"></div>
      <span>${escapeHtml(p.name)}</span>
    </div>
  `).join('');
}

// ─── Settings Overlay ─────────────────────────────────────────────────────────

function openSettings() {
  document.getElementById('setting-library').value = settings.libraryPath || '';
  document.getElementById('setting-fullscreen').checked = !!settings.fullscreen;
  document.getElementById('setting-audio').checked = settings.audioEnabled !== false;
  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

async function saveSettings() {
  const newSettings = {
    ...settings,
    libraryPath: document.getElementById('setting-library').value.trim(),
    fullscreen: document.getElementById('setting-fullscreen').checked,
    audioEnabled: document.getElementById('setting-audio').checked,
  };

  await platform.invoke('menu:settings-save', newSettings);
  settings = newSettings;
  closeSettings();
  await refreshGames();
}

// ─── Wire Event Listeners ─────────────────────────────────────────────────────

function wireListeners() {
  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-save').addEventListener('click', saveSettings);

  document.getElementById('btn-browse').addEventListener('click', async () => {
    const chosen = await platform.invoke('menu:browse-library');
    if (chosen) document.getElementById('setting-library').value = chosen;
  });

  // Close overlay on backdrop click
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Launch
  document.getElementById('btn-launch').addEventListener('click', async () => {
    if (!selectedGame) return;
    await platform.invoke('menu:load-game', selectedGame.filePath);
  });

  // Exit
  document.getElementById('btn-exit').addEventListener('click', () => {
    platform.send('menu:exit');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
