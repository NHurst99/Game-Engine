/* global platform */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let gameInfo = null;    // { name, id, version, players, joinUrl, qrDataUrl, port }
let playerMap = {};     // playerId → { name, connected }
let packLocales = {};   // { en: {...}, es: {...} } — from BOARD_INIT

// ─── Screen Management ───────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Get game + server info from main process
  gameInfo = await platform.invoke('board:get-info');

  if (gameInfo) {
    // Lobby header
    document.getElementById('lobby-game-name').textContent = gameInfo.name || 'Game Lobby';
    document.getElementById('lobby-meta').textContent =
      `${gameInfo.players?.min || '?'}–${gameInfo.players?.max || '?'} players  ·  v${gameInfo.version || '?'}`;

    // QR code
    if (gameInfo.qrDataUrl) {
      document.getElementById('lobby-qr').src = gameInfo.qrDataUrl;
    }
    if (gameInfo.joinUrl) {
      document.getElementById('lobby-join-url').textContent = gameInfo.joinUrl;
    }
  }

  wireListeners();

  // Subscribe to platform messages from host
  platform.on('board:message', handlePlatformMessage);
  platform.on('menu:players-update', handlePlayersUpdate);
}

// ─── Platform Message Handlers ────────────────────────────────────────────────

function handlePlatformMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'LOBBY_STATE':
      renderLobbyState(msg.payload);
      break;
    case 'GAME_STARTED':
      onGameStarted(msg.payload);
      break;
    case 'UPDATE_BOARD':
    case 'BOARD_INIT':
      if (msg.type === 'BOARD_INIT' && msg.payload?.packLocales) {
        packLocales = msg.payload.packLocales;
      }
      forwardToFrame(msg);
      break;
    case 'PLAYER_CONNECTED':
    case 'PLAYER_DISCONNECTED':
    case 'PLAY_AUDIO':
      forwardToFrame(msg);
      // Also update status bar for connect/disconnect
      if (msg.type === 'PLAYER_CONNECTED') {
        if (msg.payload?.playerId) playerMap[msg.payload.playerId] = { connected: true };
        updatePlayerStatusBar();
      }
      if (msg.type === 'PLAYER_DISCONNECTED') {
        if (msg.payload?.playerId && playerMap[msg.payload.playerId]) {
          playerMap[msg.payload.playerId].connected = false;
        }
        updatePlayerStatusBar();
      }
      break;
    case 'TOAST':
      showToast(msg.payload?.message, msg.payload?.style, msg.payload?.duration);
      forwardToFrame(msg);
      break;
    case 'GAME_OVER':
      onGameOver(msg.payload);
      forwardToFrame(msg);
      break;
    case 'ERROR':
      if (msg.payload?.fatal) {
        showToast(msg.payload?.message || 'A fatal error occurred', 'error', 8000);
      }
      break;
  }
}

function handlePlayersUpdate(players) {
  if (!players) return;
  playerMap = {};
  for (const p of players) {
    playerMap[p.id] = { name: p.name, connected: p.connected };
  }
  updatePlayerStatusBar();
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

function renderLobbyState(payload) {
  const { players, canStart, minPlayers } = payload;
  const list = document.getElementById('lobby-players');
  const empty = document.getElementById('lobby-empty');

  if (players.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    let html = players.map(p => `
      <div class="lobby-player-slot ${p.ready ? 'ready' : ''}">
        <span>${escapeHtml(p.name)}</span>
        <span class="player-status">${p.ready ? '✓ Ready' : 'Waiting...'}</span>
      </div>
    `).join('');

    // Fill empty slots up to minPlayers
    for (let i = players.length; i < minPlayers; i++) {
      html += '<div class="lobby-player-slot empty">Waiting for player...</div>';
    }

    list.innerHTML = html;
  }

  document.getElementById('lobby-start-btn').disabled = !canStart;
}

// ─── Game ─────────────────────────────────────────────────────────────────────

function onGameStarted(payload) {
  // Mount board iframe
  const frame = document.getElementById('board-frame');
  const boardPath = payload?.boardHtmlPath || '/game/board/board.html';
  frame.src = boardPath;

  frame.onload = () => {
    // Notify host that the board frame is ready
    platform.send('board:send', { type: 'BOARD_READY', payload: {} });
  };

  showScreen('game-screen');
}

// Forward host messages to the board iframe
function forwardToFrame(msg) {
  const frame = document.getElementById('board-frame');
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(msg, '*');
  }
}

// Listen for messages from the board iframe
window.addEventListener('message', (event) => {
  const frame = document.getElementById('board-frame');
  if (event.source !== frame?.contentWindow) return;
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'BOARD_READY') {
    platform.send('board:send', { type: 'BOARD_READY', payload: {} });
    return;
  }
  if (msg.type === 'BOARD_ACTION') {
    platform.send('board:send', { type: 'BOARD_ACTION', payload: msg.payload });
    return;
  }
});

// ─── Player Status Bar ───────────────────────────────────────────────────────

function updatePlayerStatusBar() {
  const bar = document.getElementById('player-status-bar');
  const ids = Object.keys(playerMap);
  if (ids.length === 0) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML = ids.map(id => {
    const p = playerMap[id];
    return `<div class="player-dot ${p.connected ? '' : 'disconnected'}" title="${escapeHtml(p.name || id)}"></div>`;
  }).join('');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, style, duration) {
  if (!message) return;
  style = style || 'info';
  duration = duration || 3000;

  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${style}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ─── Game Over ────────────────────────────────────────────────────────────────

function onGameOver(payload) {
  const { winner, scores } = payload || {};

  const winnerName = winner ? (playerMap[winner]?.name || winner) : null;
  document.getElementById('gameover-winner').textContent =
    winnerName ? `${winnerName} wins!` : 'Draw!';

  // Render scores
  const scoresEl = document.getElementById('gameover-scores');
  if (scores && typeof scores === 'object') {
    scoresEl.innerHTML = Object.entries(scores).map(([id, score]) => {
      const name = playerMap[id]?.name || id;
      return `<div>${escapeHtml(name)}: ${score}</div>`;
    }).join('');
  } else {
    scoresEl.innerHTML = '';
  }

  showScreen('gameover-screen');
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function wireListeners() {
  // Start game
  document.getElementById('lobby-start-btn').addEventListener('click', async () => {
    document.getElementById('lobby-start-btn').disabled = true;
    const result = await platform.invoke('menu:start-game');
    if (!result?.ok) {
      showToast(result?.error || 'Failed to start game', 'error');
      document.getElementById('lobby-start-btn').disabled = false;
    }
  });

  // Back to menu
  document.getElementById('lobby-back-btn').addEventListener('click', async () => {
    await platform.invoke('board:back-to-menu');
  });

  // Play again
  document.getElementById('play-again-btn').addEventListener('click', async () => {
    const result = await platform.invoke('menu:start-game');
    if (result?.ok) {
      // Will receive GAME_STARTED message
    } else {
      showScreen('lobby');
    }
  });

  // Quit to menu
  document.getElementById('quit-btn').addEventListener('click', async () => {
    await platform.invoke('menu:stop-game');
    await platform.invoke('board:back-to-menu');
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
