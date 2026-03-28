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

  // Subscribe to server ready event for QR code + join URL
  platform.on('menu:server-ready', onServerReady);

  // If server is already running (e.g. returning from board shell), get info now
  const existingInfo = await platform.invoke('menu:get-server-info');
  if (existingInfo) onServerReady(existingInfo);
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

// ─── Server Ready / QR Code ───────────────────────────────────────────────

function onServerReady(info) {
  // Show QR code and join URL in sidebar
  const section = document.getElementById('join-info-section');
  section.style.display = '';

  if (info.qrDataUrl) {
    document.getElementById('join-qr').src = info.qrDataUrl;
  }
  document.getElementById('join-url').textContent = info.joinUrl;

  // Update header server status
  const status = document.getElementById('server-status');
  status.style.display = '';
  document.getElementById('server-port').textContent = info.port;

  // Update no-players message
  document.getElementById('no-players').innerHTML =
    'No players connected yet.<br>Scan the QR code or visit the URL above.';

  // Populate alternate IPs for the "Can't connect?" section
  populateAlternateIPs(info);
}

async function populateAlternateIPs(primaryInfo) {
  const netInfo = await platform.invoke('menu:get-network-info');
  if (!netInfo || !netInfo.allUrls) return;

  // Show only URLs that differ from the primary one
  const alternates = netInfo.allUrls.filter(({ url }) => url !== primaryInfo.joinUrl);
  const list = document.getElementById('cant-scan-list');
  const details = document.getElementById('cant-scan-details');

  if (alternates.length === 0) {
    details.style.display = 'none';
    return;
  }

  list.innerHTML = alternates.map(({ iface, url }) => `
    <div class="cant-scan-row">
      <a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a>
      <span class="cant-scan-iface">(${escapeHtml(iface)})</span>
    </div>
  `).join('');

  // Also add /health hint
  list.innerHTML += `
    <div class="cant-scan-row" style="margin-top:6px;font-size:11px;color:var(--muted)">
      Test connectivity: open <strong>/health</strong> on any URL above
    </div>
  `;
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
  const paths = Array.isArray(settings.libraryPath) ? settings.libraryPath : (settings.libraryPath ? [settings.libraryPath] : []);
  renderLibraryPaths(paths.length ? paths : ['']);
  document.getElementById('setting-fullscreen').checked = !!settings.fullscreen;
  document.getElementById('setting-audio').checked = settings.audioEnabled !== false;
  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

function renderLibraryPaths(paths) {
  const list = document.getElementById('library-paths-list');
  list.innerHTML = paths.map((p, i) => `
    <div class="library-path-row" data-index="${i}">
      <input type="text" class="setting-input" value="${escapeHtml(p)}" placeholder="/path/to/games">
      <button class="btn btn-ghost" data-browse="${i}">Browse</button>
      <button class="btn-icon" data-remove="${i}" title="Remove folder">×</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-browse]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const chosen = await platform.invoke('menu:browse-library');
      if (chosen) {
        const row = list.querySelector(`[data-index="${btn.dataset.browse}"]`);
        row.querySelector('input').value = chosen;
      }
    });
  });

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const current = getLibraryPaths(true);
      current.splice(parseInt(btn.dataset.remove, 10), 1);
      renderLibraryPaths(current.length ? current : ['']);
    });
  });
}

function getLibraryPaths(includeEmpty = false) {
  return Array.from(document.querySelectorAll('#library-paths-list .library-path-row input'))
    .map(input => input.value.trim())
    .filter(p => includeEmpty || p.length > 0);
}

async function saveSettings() {
  const newSettings = {
    ...settings,
    libraryPath: getLibraryPaths(),
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

  document.getElementById('btn-add-library').addEventListener('click', async () => {
    const chosen = await platform.invoke('menu:browse-library');
    if (chosen) {
      const current = getLibraryPaths(true);
      // Replace the single empty placeholder if that's all there is
      if (current.length === 1 && current[0] === '') current[0] = chosen;
      else current.push(chosen);
      renderLibraryPaths(current);
    }
  });

  // Close overlay on backdrop click
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Launch — load pack then transition to board shell lobby
  document.getElementById('btn-launch').addEventListener('click', async () => {
    if (!selectedGame) return;
    const result = await platform.invoke('menu:load-game', selectedGame.filePath);
    if (result && result.ok) {
      // main.js will navigate the window to board-shell
      await platform.invoke('menu:enter-lobby');
    }
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
