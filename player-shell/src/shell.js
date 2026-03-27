'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

var state = {
  phase: 'join',        // 'join' | 'lobby' | 'game' | 'gameover'
  playerId: null,
  playerName: null,
  playerIndex: null,
  playerHtmlPath: null,
  gameName: null,
  gameId: null,
  locale: 'en',
  socket: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  reconnectDelay: 1000,
};

var isReady = false;

// ─── Screen Management ───────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

// ─── Player ID Persistence ───────────────────────────────────────────────────

function savePlayerId(id, name) {
  try {
    sessionStorage.setItem('boardgame:playerId', id);
    sessionStorage.setItem('boardgame:playerName', name);
  } catch (e) { /* sessionStorage may not be available */ }
}

function getSavedPlayerId() {
  try {
    return sessionStorage.getItem('boardgame:playerId');
  } catch (e) { return null; }
}

function getSavedPlayerName() {
  try {
    return sessionStorage.getItem('boardgame:playerName');
  } catch (e) { return null; }
}

// ─── Socket.io Connection ────────────────────────────────────────────────────

function connect() {
  // Socket.io client is loaded via /socket.io/socket.io.js
  state.socket = io({
    transports: ['websocket'],
    reconnection: false, // We handle reconnection ourselves
  });

  state.socket.on('connect', function() {
    state.reconnectAttempts = 0;
    state.reconnectDelay = 1000;
    hideDisconnectOverlay();
    updateConnectionPill(true);

    // If we have a saved player ID and we're past the join screen, try to rejoin
    var savedId = getSavedPlayerId();
    if (savedId && state.phase !== 'join') {
      send({ type: 'REQUEST_REJOIN', payload: { playerId: savedId } });
    }
  });

  state.socket.on('message', function(msg) {
    if (!msg || !msg.type) return;
    handleMessage(msg);
  });

  state.socket.on('disconnect', function() {
    updateConnectionPill(false);
    if (state.phase === 'game' || state.phase === 'lobby') {
      showDisconnectOverlay();
      scheduleReconnect();
    }
  });

  state.socket.on('connect_error', function() {
    // Will trigger disconnect handling
  });
}

function send(msg) {
  if (state.socket && state.socket.connected) {
    state.socket.emit('message', msg);
  }
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case 'PLAYER_JOIN':        onPlayerJoin(msg.payload); break;
    case 'JOIN_REJECTED':      onJoinRejected(msg.payload); break;
    case 'LOBBY_STATE':        onLobbyState(msg.payload); break;
    case 'GAME_STARTED':       onGameStarted(msg.payload); break;
    case 'UPDATE_PLAYER':      forwardToFrame(msg); break;
    case 'UPDATE_ALL_PLAYERS': forwardToFrame(msg); break;
    case 'GAME_OVER':          onGameOver(msg.payload); break;
    case 'TOAST':              showToast(msg.payload); forwardToFrame(msg); break;
    case 'PLAY_AUDIO':         break; // Audio not implemented yet
    case 'ERROR':
      if (msg.payload && msg.payload.fatal) {
        showToast({ message: msg.payload.message || 'An error occurred', style: 'error' });
      }
      break;
  }
}

// ─── Join Flow ────────────────────────────────────────────────────────────────

function onPlayerJoin(payload) {
  state.playerId = payload.playerId;
  state.playerIndex = payload.playerIndex;
  state.playerName = payload.playerName;
  state.gameName = payload.gameName;
  state.gameId = payload.gameId;
  state.locale = payload.locale || 'en';
  state.playerHtmlPath = payload.playerHtmlPath || null;

  savePlayerId(payload.playerId, payload.playerName);

  // Update lobby info
  document.getElementById('lobby-game-name').textContent = payload.gameName || 'Game Lobby';
  document.getElementById('lobby-your-name').textContent = 'You are: ' + escapeHtml(payload.playerName);

  if (payload.status === 'in_progress') {
    // Rejoin mid-game — skip lobby
    state.phase = 'game';
    mountPlayerFrame();
    showScreen('game-screen');
    return;
  }

  state.phase = 'lobby';
  showScreen('lobby-screen');
}

function onJoinRejected(payload) {
  var reasons = {
    game_full: 'This game is full.',
    already_started: 'The game has already started.',
    invalid_id: 'Could not reconnect. Please rejoin.',
  };
  document.getElementById('join-status').textContent = reasons[payload.reason] || 'Could not join.';
  document.getElementById('join-btn').disabled = false;

  // If invalid_id, clear saved data and go back to join screen
  if (payload.reason === 'invalid_id') {
    try {
      sessionStorage.removeItem('boardgame:playerId');
      sessionStorage.removeItem('boardgame:playerName');
    } catch (e) {}
    state.phase = 'join';
    showScreen('join-screen');
  }
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

function onLobbyState(payload) {
  var list = document.getElementById('lobby-players-list');
  list.innerHTML = payload.players.map(function(p) {
    var isYou = p.id === state.playerId;
    var classes = 'lobby-player';
    if (isYou) classes += ' you';
    if (p.ready) classes += ' ready';
    return '<div class="' + classes + '">' +
      '<span>' + escapeHtml(p.name) + (isYou ? ' (You)' : '') + '</span>' +
      '<span>' + (p.ready ? '✓' : '…') + '</span>' +
      '</div>';
  }).join('');
}

// ─── Game ─────────────────────────────────────────────────────────────────────

function onGameStarted(payload) {
  state.phase = 'game';
  // Get player HTML path from payload or state
  if (payload && payload.playerHtmlPath) {
    state.playerHtmlPath = payload.playerHtmlPath;
  }
  mountPlayerFrame();
  showScreen('game-screen');
}

function mountPlayerFrame() {
  var frame = document.getElementById('player-frame');
  var src = state.playerHtmlPath || '/game/player/hand.html';
  frame.src = src;

  frame.onload = function() {
    // Inject PLATFORM_INIT into frame
    frame.contentWindow.postMessage({
      type: 'PLATFORM_INIT',
      payload: {
        playerId: state.playerId,
        playerName: state.playerName,
        playerIndex: state.playerIndex,
        gameName: state.gameName,
        gameId: state.gameId,
        locale: state.locale,
      }
    }, '*');
  };
}

// Route messages from iframe → WebSocket
window.addEventListener('message', function(event) {
  var frame = document.getElementById('player-frame');
  if (!frame || event.source !== frame.contentWindow) return;
  var msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'PLAYER_ACTION') {
    send({ type: 'PLAYER_ACTION', payload: msg.payload });
  }
});

// Route messages from WebSocket → iframe
function forwardToFrame(msg) {
  var frame = document.getElementById('player-frame');
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(msg, '*');
  }
}

// ─── Game Over ────────────────────────────────────────────────────────────────

function onGameOver(payload) {
  state.phase = 'gameover';
  var message = '';
  if (payload) {
    if (payload.winner === state.playerId) {
      message = 'You win!';
    } else if (payload.winner) {
      message = 'You lost!';
    } else {
      message = 'Draw!';
    }
  }
  document.getElementById('gameover-message').textContent = message;

  // Show personal score if available
  var scoreEl = document.getElementById('gameover-score');
  if (payload && payload.scores && payload.scores[state.playerId] !== undefined) {
    scoreEl.textContent = 'Your score: ' + payload.scores[state.playerId];
  } else {
    scoreEl.textContent = '';
  }

  showScreen('gameover-screen');
  forwardToFrame({ type: 'GAME_OVER', payload: payload });
}

// ─── Reconnection ─────────────────────────────────────────────────────────────

function scheduleReconnect() {
  if (state.reconnectAttempts >= state.maxReconnectAttempts) {
    document.getElementById('reconnect-countdown').textContent =
      'Could not reconnect. Please refresh the page.';
    return;
  }

  state.reconnectAttempts++;
  var delay = Math.min(state.reconnectDelay * state.reconnectAttempts, 15000);

  var remaining = Math.ceil(delay / 1000);
  var countdownEl = document.getElementById('reconnect-countdown');

  var interval = setInterval(function() {
    countdownEl.textContent = 'Retrying in ' + remaining + 's...';
    remaining--;
    if (remaining < 0) clearInterval(interval);
  }, 1000);

  setTimeout(function() {
    clearInterval(interval);
    connect();
  }, delay);
}

function showDisconnectOverlay() {
  document.getElementById('disconnect-overlay').classList.remove('hidden');
}

function hideDisconnectOverlay() {
  document.getElementById('disconnect-overlay').classList.add('hidden');
}

function updateConnectionPill(connected) {
  var pill = document.getElementById('connection-pill');
  pill.className = 'connection-pill ' + (connected ? 'connected' : 'disconnected');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(payload) {
  if (!payload || !payload.message) return;
  var style = payload.style || 'info';
  var duration = payload.duration || 3000;

  var container = document.getElementById('toast-container');
  var el = document.createElement('div');
  el.className = 'toast toast-' + style;
  el.textContent = payload.message;
  container.appendChild(el);
  requestAnimationFrame(function() { el.classList.add('visible'); });
  setTimeout(function() {
    el.classList.remove('visible');
    setTimeout(function() { el.remove(); }, 300);
  }, duration);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

// Join form
document.getElementById('join-form').addEventListener('submit', function(e) {
  e.preventDefault();
  var name = document.getElementById('player-name-input').value.trim();
  if (!name) return;
  state.playerName = name;
  send({
    type: 'JOIN_REQUEST',
    payload: { name: name }
  });
  document.getElementById('join-btn').disabled = true;
  document.getElementById('join-status').textContent = 'Joining...';
});

// Ready button
document.getElementById('ready-btn').addEventListener('click', function() {
  if (isReady) return;
  isReady = true;
  send({ type: 'READY', payload: {} });
  document.getElementById('ready-btn').textContent = '✓ Ready!';
  document.getElementById('ready-btn').disabled = true;
});

// Pre-fill saved name
var savedName = getSavedPlayerName();
if (savedName) {
  document.getElementById('player-name-input').value = savedName;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
