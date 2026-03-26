# Example Game: Tic-Tac-Toe — Implementation Walkthrough

This is a complete, minimal game pack that demonstrates every platform concept. Use it as a reference or a starting template.

Pack ID: `com.example.tictactoe`
Players: 2
Files: manifest.json, server/game.js, board/board.html, player/hand.html

---

## `manifest.json`

```json
{
  "id": "com.example.tictactoe",
  "name": "Tic-Tac-Toe",
  "version": "1.0.0",
  "description": "Classic 3x3 grid game for 2 players.",
  "author": "Platform Example",
  "tags": ["classic", "2-player", "quick"],

  "players": {
    "min": 2,
    "max": 2
  },

  "entry": {
    "server": "server/game.js",
    "board": "board/board.html",
    "player": "player/hand.html"
  },

  "assets": {
    "icon": "assets/icon.png"
  },

  "capabilities": {
    "persistState": false
  }
}
```

---

## `server/game.js`

```js
// ─── State ───────────────────────────────────────────────────────────────────

let state = {
  board: Array(9).fill(null),   // null | 'X' | 'O'
  players: [],
  symbols: {},                  // playerId → 'X' | 'O'
  currentTurn: null,            // playerId whose turn it is
  phase: 'waiting',             // 'waiting' | 'playing' | 'over'
  winner: null,                 // playerId | 'draw' | null
  connectedCount: 0
};

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],  // rows
  [0,3,6],[1,4,7],[2,5,8],  // cols
  [0,4,8],[2,4,6]           // diagonals
];

// ─── Init ────────────────────────────────────────────────────────────────────

ctx.on('GAME_INIT', (payload) => {
  state.players = payload.players;
  // Randomly assign X and O
  const shuffled = ctx.shuffle(payload.players);
  state.symbols[shuffled[0].id] = 'X';
  state.symbols[shuffled[1].id] = 'O';
  state.currentTurn = shuffled[0].id;  // X goes first

  ctx.emit('GAME_READY', { waitingFor: 'players' });
  ctx.log('Tic-Tac-Toe initialized. X=' + shuffled[0].name + ', O=' + shuffled[1].name);
});

// ─── Player Connection ───────────────────────────────────────────────────────

ctx.on('PLAYER_CONNECTED', (payload) => {
  state.connectedCount++;
  if (state.connectedCount >= 2 && state.phase === 'waiting') {
    state.phase = 'playing';
    ctx.emit('GAME_STARTED', {
      firstPlayer: state.currentTurn,
      symbols: state.symbols
    });
    broadcastState();
  }
});

ctx.on('PLAYER_DISCONNECTED', (payload) => {
  state.connectedCount--;
  if (state.phase === 'playing') {
    ctx.emit('TOAST', {
      message: getPlayerName(payload.playerId) + ' disconnected.',
      style: 'warning',
      duration: 4000
    }, 'board');
  }
});

// ─── Actions ─────────────────────────────────────────────────────────────────

ctx.on('PLAYER_ACTION', (payload, meta) => {
  const playerId = meta.from.replace('player:', '');

  if (state.phase !== 'playing') return;

  if (payload.action === 'PLACE_MARK') {
    const { cellIndex } = payload.data;

    // Validate
    if (playerId !== state.currentTurn) {
      ctx.emit('TOAST', {
        message: 'Not your turn.',
        style: 'warning'
      }, `player:${playerId}`);
      return;
    }
    if (cellIndex < 0 || cellIndex > 8 || state.board[cellIndex] !== null) {
      ctx.emit('TOAST', {
        message: 'Invalid move.',
        style: 'error'
      }, `player:${playerId}`);
      return;
    }

    // Apply move
    state.board[cellIndex] = state.symbols[playerId];

    // Check win
    const winner = checkWinner();
    if (winner) {
      state.phase = 'over';
      state.winner = winner === 'draw' ? 'draw' : playerId;
      broadcastState();

      if (winner === 'draw') {
        ctx.emit('GAME_OVER', { winner: null, reason: 'draw' });
      } else {
        ctx.emit('GAME_OVER', {
          winner: playerId,
          winners: [playerId],
          reason: 'three_in_a_row'
        });
      }
      return;
    }

    // Next turn
    state.currentTurn = state.players.find(p => p.id !== playerId).id;
    broadcastState();
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function checkWinner() {
  for (const [a, b, c] of WIN_LINES) {
    if (state.board[a] && state.board[a] === state.board[b] && state.board[a] === state.board[c]) {
      return state.board[a]; // 'X' or 'O'
    }
  }
  if (state.board.every(cell => cell !== null)) return 'draw';
  return null;
}

function getPlayerName(playerId) {
  return state.players.find(p => p.id === playerId)?.name || playerId;
}

function getPlayerBySymbol(symbol) {
  return state.players.find(p => state.symbols[p.id] === symbol);
}

function broadcastState() {
  // Board display
  ctx.emit('UPDATE_BOARD', {
    board: state.board,
    currentTurn: state.currentTurn,
    currentTurnName: state.currentTurn ? getPlayerName(state.currentTurn) : null,
    symbols: state.symbols,
    phase: state.phase,
    winner: state.winner,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      symbol: state.symbols[p.id]
    }))
  }, 'board');

  // Each player's phone
  state.players.forEach(p => {
    ctx.emit('UPDATE_PLAYER', {
      mySymbol: state.symbols[p.id],
      isMyTurn: state.currentTurn === p.id && state.phase === 'playing',
      board: state.board,
      phase: state.phase,
      winner: state.winner
    }, `player:${p.id}`);
  });
}
```

---

## `board/board.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Tic-Tac-Toe</title>
  <script src="/platform-sdk.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f172a;
      color: #f1f5f9;
      font-family: 'Segoe UI', system-ui, sans-serif;
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 40px;
    }
    h1 { font-size: 3vw; letter-spacing: 0.2em; color: #94a3b8; }
    #status {
      font-size: 2.5vw;
      color: #e2e8f0;
      min-height: 3vw;
      text-align: center;
    }
    #grid {
      display: grid;
      grid-template-columns: repeat(3, 18vw);
      grid-template-rows: repeat(3, 18vw);
      gap: 1vw;
    }
    .cell {
      background: #1e293b;
      border-radius: 1vw;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10vw;
      font-weight: bold;
      transition: background 0.2s;
    }
    .cell.X { color: #3b82f6; }
    .cell.O { color: #f97316; }
    #players {
      display: flex;
      gap: 6vw;
      font-size: 1.8vw;
    }
    .player-badge {
      display: flex;
      align-items: center;
      gap: 0.8vw;
      padding: 0.8vw 2vw;
      border-radius: 100vw;
      background: #1e293b;
      transition: background 0.3s;
    }
    .player-badge.active {
      background: #1d4ed8;
    }
    .player-badge .symbol { font-size: 2vw; font-weight: bold; }
    .player-badge.X .symbol { color: #3b82f6; }
    .player-badge.O .symbol { color: #f97316; }
  </style>
</head>
<body>
  <h1>TIC-TAC-TOE</h1>
  <div id="players"></div>
  <div id="status">Waiting for players...</div>
  <div id="grid"></div>

  <script>
    let boardState = Array(9).fill(null);
    let playerData = [];

    // Build grid
    const grid = document.getElementById('grid');
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.id = `cell-${i}`;
      grid.appendChild(cell);
    }

    window.platform.on('UPDATE_BOARD', (payload) => {
      const { board, currentTurnName, symbols, phase, winner, players } = payload;
      boardState = board;

      // Render grid
      board.forEach((mark, i) => {
        const cell = document.getElementById(`cell-${i}`);
        cell.textContent = mark || '';
        cell.className = `cell ${mark || ''}`;
      });

      // Render players
      playerData = players;
      document.getElementById('players').innerHTML = players.map(p => `
        <div class="player-badge ${p.symbol} ${payload.currentTurn === p.id && phase === 'playing' ? 'active' : ''}">
          <span class="symbol">${p.symbol}</span>
          <span>${p.name}</span>
        </div>
      `).join('');

      // Status text
      let statusText = '';
      if (phase === 'waiting') {
        statusText = 'Waiting for players to connect...';
      } else if (phase === 'playing') {
        statusText = `${currentTurnName}'s turn`;
      } else if (phase === 'over') {
        if (winner === 'draw') {
          statusText = "It's a draw!";
        } else {
          const winnerPlayer = players.find(p => p.id === payload.winner);
          statusText = winnerPlayer ? `${winnerPlayer.name} wins! 🎉` : 'Game over!';
        }
      }
      document.getElementById('status').textContent = statusText;
    });

    // Signal ready
    window.parent.postMessage({ type: 'BOARD_READY', payload: {} }, '*');
  </script>
</body>
</html>
```

---

## `player/hand.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Tic-Tac-Toe</title>
  <script src="/platform-sdk.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f172a;
      color: #f1f5f9;
      font-family: system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      gap: 24px;
    }
    #symbol-badge {
      font-size: 64px;
      font-weight: bold;
      line-height: 1;
    }
    #symbol-badge.X { color: #3b82f6; }
    #symbol-badge.O { color: #f97316; }
    #turn-status {
      font-size: 20px;
      text-align: center;
      color: #94a3b8;
      min-height: 28px;
    }
    #turn-status.my-turn { color: #22c55e; font-weight: bold; }
    #grid {
      display: grid;
      grid-template-columns: repeat(3, 88px);
      grid-template-rows: repeat(3, 88px);
      gap: 8px;
    }
    .cell {
      background: #1e293b;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      font-weight: bold;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }
    .cell:active { transform: scale(0.94); }
    .cell.empty.my-turn-active:hover { background: #334155; }
    .cell.X { color: #3b82f6; cursor: default; }
    .cell.O { color: #f97316; cursor: default; }
    .cell.empty { background: #1e293b; }
    #result {
      font-size: 22px;
      font-weight: bold;
      text-align: center;
      min-height: 30px;
    }
    #hint {
      font-size: 14px;
      color: #475569;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="symbol-badge">?</div>
  <div id="turn-status">Waiting...</div>
  <div id="grid"></div>
  <div id="result"></div>
  <div id="hint">Tap an empty cell to place your mark</div>

  <script>
    let mySymbol = null;
    let isMyTurn = false;
    let currentBoard = Array(9).fill(null);
    let gamePhase = 'waiting';

    // Build grid
    const grid = document.getElementById('grid');
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell empty';
      cell.dataset.index = i;
      cell.addEventListener('click', () => handleCellTap(i));
      grid.appendChild(cell);
    }

    function handleCellTap(index) {
      if (!isMyTurn || gamePhase !== 'playing') return;
      if (currentBoard[index] !== null) return;
      window.platform.sendAction('PLACE_MARK', { cellIndex: index });
    }

    window.platform.on('PLATFORM_INIT', (payload) => {
      // Name is known here but symbol isn't yet — wait for first UPDATE_PLAYER
    });

    window.platform.on('UPDATE_PLAYER', (payload) => {
      mySymbol = payload.mySymbol;
      isMyTurn = payload.isMyTurn;
      currentBoard = payload.board;
      gamePhase = payload.phase;

      // Symbol badge
      const badge = document.getElementById('symbol-badge');
      badge.textContent = mySymbol || '?';
      badge.className = mySymbol || '';

      // Turn status
      const turnEl = document.getElementById('turn-status');
      if (gamePhase === 'playing') {
        if (isMyTurn) {
          turnEl.textContent = 'Your turn!';
          turnEl.className = 'my-turn';
        } else {
          turnEl.textContent = "Opponent's turn";
          turnEl.className = '';
        }
      } else if (gamePhase === 'over') {
        turnEl.textContent = '';
      } else {
        turnEl.textContent = 'Waiting...';
        turnEl.className = '';
      }

      // Render board
      currentBoard.forEach((mark, i) => {
        const cell = grid.children[i];
        if (mark) {
          cell.textContent = mark;
          cell.className = `cell ${mark}`;
        } else {
          cell.textContent = '';
          cell.className = `cell empty ${isMyTurn && gamePhase === 'playing' ? 'my-turn-active' : ''}`;
        }
      });

      // Result
      const resultEl = document.getElementById('result');
      const hintEl = document.getElementById('hint');
      if (gamePhase === 'over') {
        if (payload.winner === 'draw') {
          resultEl.textContent = "It's a draw!";
        } else if (payload.winner === window.platform.playerId) {
          resultEl.textContent = '🎉 You win!';
        } else {
          resultEl.textContent = 'You lose.';
        }
        hintEl.style.display = 'none';
      } else {
        resultEl.textContent = '';
        hintEl.style.display = isMyTurn ? 'block' : 'none';
      }
    });
  </script>
</body>
</html>
```

---

## What This Example Demonstrates

- `GAME_INIT` → initializing state with randomized symbol assignment using `ctx.shuffle()`
- `GAME_READY` with `waitingFor: 'players'` — game waits for connections before starting
- `PLAYER_CONNECTED` tracking and automatic game start
- `PLAYER_ACTION` validation with error toasts sent back to the offending player
- `broadcastState()` pattern: one board update + one per-player update per state change
- `GAME_OVER` emission at game end
- Board HTML using `window.platform.on('UPDATE_BOARD')` for reactive rendering
- Player HTML using `window.platform.sendAction()` for input
- Both HTML files using `/platform-sdk.js`
- `BOARD_READY` signaling from board.html

---

## Things Not Shown (for follow-up examples)

- Asset loading (images, audio)
- Settings screen
- Custom lobby
- Save/restore state
- Touch board events
- Timer-based mechanics (`ctx.timer`)
- Locale strings
