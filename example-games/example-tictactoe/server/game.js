// ─── Constants ───────────────────────────────────────────────────────────────

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],  // rows
  [0,3,6],[1,4,7],[2,5,8],  // cols
  [0,4,8],[2,4,6],          // diagonals
];

const AI_ID = 'ai';
const AI_NAME = 'CPU';

// ─── State ───────────────────────────────────────────────────────────────────

let state = {
  board: Array(9).fill(null),  // null | 'X' | 'O'
  players: [],                  // human players from GAME_INIT
  symbols: {},                  // playerId → 'X' | 'O'
  currentTurn: null,            // playerId or AI_ID
  phase: 'waiting',             // 'waiting' | 'playing' | 'over'
  winner: null,                 // playerId | AI_ID | 'draw' | null
  connectedCount: 0,
  aiEnabled: false,
  aiSymbol: null,
};

// ─── Init ─────────────────────────────────────────────────────────────────────

ctx.on('GAME_INIT', (payload) => {
  state.players = payload.players;
  state.aiEnabled = payload.players.length === 1;

  if (state.aiEnabled) {
    const humanId = payload.players[0].id;
    // Randomly assign X/O between human and AI
    const humanGetsX = ctx.random() < 0.5;
    state.symbols[humanId] = humanGetsX ? 'X' : 'O';
    state.aiSymbol = humanGetsX ? 'O' : 'X';
    // X always goes first
    state.currentTurn = humanGetsX ? humanId : AI_ID;
    ctx.log('AI mode. Human=' + state.symbols[humanId] + ', AI=' + state.aiSymbol);
  } else {
    const shuffled = ctx.shuffle(payload.players.slice());
    state.symbols[shuffled[0].id] = 'X';
    state.symbols[shuffled[1].id] = 'O';
    state.currentTurn = shuffled[0].id; // X goes first
    ctx.log('2-player mode. X=' + shuffled[0].name + ', O=' + shuffled[1].name);
  }

  ctx.emit('GAME_READY', {});
});

// ─── Connection Events ────────────────────────────────────────────────────────

ctx.on('PLAYER_CONNECTED', (payload) => {
  state.connectedCount++;
  const needed = state.aiEnabled ? 1 : 2;
  if (state.connectedCount >= needed && state.phase === 'waiting') {
    state.phase = 'playing';
    broadcastState();
    // If AI has first turn, schedule its move now
    if (state.aiEnabled && state.currentTurn === AI_ID) {
      scheduleAiMove();
    }
  }
});

ctx.on('PLAYER_DISCONNECTED', (payload) => {
  state.connectedCount--;
  if (state.phase === 'playing') {
    ctx.emit('TOAST', {
      message: getPlayerName(payload.playerId) + ' disconnected.',
      style: 'warning',
      duration: 4000,
    }, 'board');
  }
});

// ─── Player Action ────────────────────────────────────────────────────────────

ctx.on('PLAYER_ACTION', (payload, meta) => {
  if (payload.action !== 'PLACE_MARK') return;
  const playerId = meta.from.replace('player:', '');
  handleMove(playerId, payload.data.cellIndex);
});

// ─── AI Move ──────────────────────────────────────────────────────────────────

ctx.on('AI_MOVE', () => {
  if (state.phase !== 'playing' || state.currentTurn !== AI_ID) return;
  const cell = pickEasyMove();
  if (cell !== -1) handleMove(AI_ID, cell);
});

/**
 * Easy AI: always takes an immediate winning move if one exists,
 * otherwise picks a random empty cell. Never blocks the human player.
 */
function pickEasyMove() {
  const empty = [];
  for (let i = 0; i < 9; i++) {
    if (state.board[i] === null) empty.push(i);
  }
  if (empty.length === 0) return -1;

  // Take winning move if available
  for (const cell of empty) {
    const test = state.board.slice();
    test[cell] = state.aiSymbol;
    if (getWinSymbol(test) === state.aiSymbol) return cell;
  }

  // Otherwise pick at random
  return empty[Math.floor(ctx.random() * empty.length)];
}

function scheduleAiMove() {
  // 700–1300 ms delay so it feels like the AI is thinking
  const delay = 700 + Math.floor(ctx.random() * 600);
  ctx.timer(delay, 'AI_MOVE', {});
}

// ─── Move Logic ───────────────────────────────────────────────────────────────

function handleMove(playerId, cellIndex) {
  if (state.phase !== 'playing') return;

  // Validate turn
  if (playerId !== state.currentTurn) {
    if (playerId !== AI_ID) {
      ctx.emit('TOAST', { message: 'Not your turn.', style: 'warning' }, `player:${playerId}`);
    }
    return;
  }

  // Validate cell
  if (cellIndex < 0 || cellIndex > 8 || state.board[cellIndex] !== null) {
    if (playerId !== AI_ID) {
      ctx.emit('TOAST', { message: 'Invalid move.', style: 'error' }, `player:${playerId}`);
    }
    return;
  }

  // Apply
  const symbol = playerId === AI_ID ? state.aiSymbol : state.symbols[playerId];
  state.board[cellIndex] = symbol;

  // Check outcome
  const winSymbol = getWinSymbol(state.board);
  if (winSymbol) {
    state.phase = 'over';
    const winLine = getWinLine(state.board);

    if (winSymbol === 'draw') {
      state.winner = 'draw';
      broadcastState(winLine);
      ctx.emit('GAME_OVER', { winner: null, reason: 'draw' });
    } else if (state.aiEnabled && winSymbol === state.aiSymbol) {
      state.winner = AI_ID;
      broadcastState(winLine);
      ctx.emit('GAME_OVER', { winner: null, reason: 'ai_wins' });
    } else {
      const winnerId = state.players.find(p => state.symbols[p.id] === winSymbol).id;
      state.winner = winnerId;
      broadcastState(winLine);
      ctx.emit('GAME_OVER', { winner: winnerId, winners: [winnerId], reason: 'three_in_a_row' });
    }
    return;
  }

  // Advance turn
  if (state.aiEnabled) {
    const humanId = state.players[0].id;
    state.currentTurn = (playerId === humanId) ? AI_ID : humanId;
  } else {
    state.currentTurn = state.players.find(p => p.id !== playerId).id;
  }

  broadcastState(null);

  if (state.aiEnabled && state.currentTurn === AI_ID) {
    scheduleAiMove();
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcastState(winLine) {
  // Build the display player list (includes AI as a named entry)
  const displayPlayers = state.players.map(p => ({
    id: p.id,
    name: p.name,
    symbol: state.symbols[p.id],
    isAi: false,
  }));
  if (state.aiEnabled) {
    displayPlayers.push({ id: AI_ID, name: AI_NAME, symbol: state.aiSymbol, isAi: true });
    displayPlayers.sort((a, b) => (a.symbol === 'X' ? -1 : 1));
  }

  ctx.emit('UPDATE_BOARD', {
    board: state.board,
    currentTurn: state.currentTurn,
    currentTurnName: getPlayerName(state.currentTurn),
    phase: state.phase,
    winner: state.winner,
    winLine: winLine || null,
    players: displayPlayers,
    aiEnabled: state.aiEnabled,
  }, 'board');

  state.players.forEach(p => {
    ctx.emit('UPDATE_PLAYER', {
      mySymbol: state.symbols[p.id],
      isMyTurn: state.currentTurn === p.id && state.phase === 'playing',
      isAiTurn: state.aiEnabled && state.currentTurn === AI_ID && state.phase === 'playing',
      board: state.board,
      phase: state.phase,
      winner: state.winner,
      winLine: winLine || null,
      aiMode: state.aiEnabled,
      aiName: state.aiEnabled ? AI_NAME : null,
    }, `player:${p.id}`);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWinSymbol(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(cell => cell !== null)) return 'draw';
  return null;
}

function getWinLine(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return [a, b, c];
  }
  return null;
}

function getPlayerName(playerId) {
  if (playerId === AI_ID) return AI_NAME;
  return state.players.find(p => p.id === playerId)?.name || playerId;
}
