const { Server } = require('socket.io');
const { EventEmitter } = require('events');

/**
 * SocketServer — WebSocket hub and message router.
 *
 * Manages all incoming connections (board + players), the pre-game lobby,
 * and message routing between participants and the game sandbox.
 *
 * Emits:
 *   'player-list-changed' — whenever the connected player list changes
 *                           (for pushing to the main menu UI)
 */
class SocketServer extends EventEmitter {
  constructor() {
    super();
    this.io = null;

    // Connection registry
    this.board = null; // socket | null
    this.players = new Map(); // playerId → { socket, name, index, ready, connected }

    // Game state
    this.gameRunner = null;     // set by host when game starts
    this.manifest = null;       // set when pack is loaded
    this.gamePhase = 'idle';    // 'idle' | 'lobby' | 'in_progress'
    this.playerCounter = 0;
    this.lastBoardState = null; // cache for board reconnection
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Attach Socket.io to an existing HTTP server.
   */
  attach(httpServer) {
    this.io = new Server(httpServer, {
      cors: { origin: '*' },
      transports: ['websocket'],
      pingTimeout: 10000,
      pingInterval: 5000,
    });

    this.io.on('connection', (socket) => this._onConnection(socket));
  }

  /**
   * Prepare for a new game session. Call after pack is loaded.
   */
  loadGame(manifest) {
    this.manifest = manifest;
    this.gamePhase = 'lobby';
    this.players.clear();
    this.playerCounter = 0;
    this.lastBoardState = null;
    this._broadcastLobbyState();
  }

  /**
   * Attach the game runner for message routing during gameplay.
   */
  setGameRunner(gameRunner) {
    this.gameRunner = gameRunner;
    this.gamePhase = 'in_progress';

    gameRunner.on('message', (msg) => this._routeFromGame(msg));
  }

  /**
   * End the current game session. Keeps player connections alive.
   */
  endGame() {
    this.gameRunner = null;
    this.gamePhase = 'lobby';
    // Reset readiness
    for (const p of this.players.values()) {
      p.ready = false;
    }
    this._broadcastLobbyState();
  }

  /**
   * Shut down Socket.io.
   */
  close() {
    this.io?.close();
    this.io = null;
  }

  // ─── Connection Handling ─────────────────────────────────────────────────

  _onConnection(socket) {
    // Every client sends an 'identify' message first, or we classify by
    // listening for specific message types.
    socket.on('message', (msg) => {
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'IDENTIFY_BOARD':
          this._handleIdentifyBoard(socket);
          break;
        case 'JOIN_REQUEST':
          this._handleJoinRequest(socket, msg);
          break;
        case 'REQUEST_REJOIN':
          this._handleRejoin(socket, msg);
          break;
        case 'READY':
          this._handleReady(socket);
          break;
        case 'PLAYER_ACTION':
          this._handlePlayerAction(socket, msg);
          break;
        case 'BOARD_READY':
          this._handleBoardReady(socket);
          break;
        case 'BOARD_ACTION':
          this._handleBoardAction(socket, msg);
          break;
        default:
          break;
      }
    });

    socket.on('disconnect', () => this._onDisconnect(socket));
  }

  // ─── Board ──────────────────────────────────────────────────────────────

  _handleIdentifyBoard(socket) {
    this.board = socket;
    socket._role = 'board';
    // If we're in lobby, send current state
    if (this.gamePhase === 'lobby') {
      this._broadcastLobbyState();
    }
  }

  _handleBoardReady(_socket) {
    // Board HTML loaded — send BOARD_INIT if game is in progress
    if (this.gamePhase === 'in_progress' && this.manifest) {
      const players = [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        index: p.index,
      }));
      this.board?.emit('message', {
        type: 'BOARD_INIT',
        payload: {
          players,
          settings: {},
          gameName: this.manifest.name,
          locale: this.manifest.locales?.default || 'en',
        },
      });
      // Re-send last board state if available
      if (this.lastBoardState) {
        this.board?.emit('message', this.lastBoardState);
      }
    }
  }

  _handleBoardAction(_socket, msg) {
    if (this.gamePhase !== 'in_progress') return;
    if (!this.manifest?.capabilities?.touchBoard) return;
    this.gameRunner?.send({ ...msg, from: 'board' });
  }

  // ─── Player Join / Rejoin ────────────────────────────────────────────────

  _handleJoinRequest(socket, msg) {
    const name = msg.payload?.name || 'Player';

    // Check if game is full
    const maxPlayers = this.manifest?.players?.max ?? Infinity;
    if (this.players.size >= maxPlayers) {
      socket.emit('message', {
        type: 'JOIN_REJECTED',
        payload: { reason: 'game_full' },
      });
      return;
    }

    // Check if game already started and no rejoin
    if (this.gamePhase === 'in_progress') {
      socket.emit('message', {
        type: 'JOIN_REJECTED',
        payload: { reason: 'already_started' },
      });
      return;
    }

    // Assign player ID
    this.playerCounter++;
    const playerId = `p${this.playerCounter}`;
    const playerIndex = this.playerCounter - 1;

    const playerEntry = {
      id: playerId,
      socket,
      name,
      index: playerIndex,
      ready: false,
      connected: true,
    };
    this.players.set(playerId, playerEntry);
    socket._role = 'player';
    socket._playerId = playerId;

    // Send PLAYER_JOIN to the joining player
    socket.emit('message', {
      type: 'PLAYER_JOIN',
      payload: {
        playerId,
        playerIndex,
        playerName: name,
        gameName: this.manifest?.name || 'BoardGame Platform',
        gameId: this.manifest?.id || '',
        playerCount: this.players.size,
        locale: this.manifest?.locales?.default || 'en',
        status: 'lobby',
      },
    });

    this._broadcastLobbyState();
    this._emitPlayerListChanged();
  }

  _handleRejoin(socket, msg) {
    const playerId = msg.payload?.playerId;
    const player = this.players.get(playerId);

    if (!player) {
      socket.emit('message', {
        type: 'JOIN_REJECTED',
        payload: { reason: 'invalid_id' },
      });
      return;
    }

    // Reassign socket
    player.socket = socket;
    player.connected = true;
    socket._role = 'player';
    socket._playerId = playerId;

    // Notify game sandbox if game is in progress
    if (this.gamePhase === 'in_progress' && this.gameRunner) {
      this.gameRunner.send({
        type: 'PLAYER_CONNECTED',
        payload: { playerId, isReconnect: true },
      });
    }

    // Send current state to reconnected player
    if (this.gamePhase === 'lobby') {
      socket.emit('message', {
        type: 'PLAYER_JOIN',
        payload: {
          playerId,
          playerIndex: player.index,
          playerName: player.name,
          gameName: this.manifest?.name || 'BoardGame Platform',
          gameId: this.manifest?.id || '',
          playerCount: this.players.size,
          locale: this.manifest?.locales?.default || 'en',
          status: 'lobby',
        },
      });
      this._broadcastLobbyState();
    } else {
      socket.emit('message', {
        type: 'PLAYER_JOIN',
        payload: {
          playerId,
          playerIndex: player.index,
          playerName: player.name,
          gameName: this.manifest?.name || 'BoardGame Platform',
          gameId: this.manifest?.id || '',
          playerCount: this.players.size,
          locale: this.manifest?.locales?.default || 'en',
          status: 'in_progress',
        },
      });
    }

    this._emitPlayerListChanged();
  }

  // ─── Player Ready ────────────────────────────────────────────────────────

  _handleReady(socket) {
    const playerId = socket._playerId;
    if (!playerId) return;
    const player = this.players.get(playerId);
    if (!player) return;

    player.ready = true;
    this._broadcastLobbyState();
  }

  // ─── Player Action ───────────────────────────────────────────────────────

  _handlePlayerAction(socket, msg) {
    if (this.gamePhase !== 'in_progress') return;
    const playerId = socket._playerId;
    if (!playerId) return;

    this.gameRunner?.send({
      ...msg,
      from: `player:${playerId}`,
    });
  }

  // ─── Disconnect ──────────────────────────────────────────────────────────

  _onDisconnect(socket) {
    if (socket._role === 'board') {
      this.board = null;
      return;
    }

    if (socket._role === 'player') {
      const playerId = socket._playerId;
      const player = this.players.get(playerId);
      if (!player) return;

      player.connected = false;
      player.socket = null;

      // Notify game sandbox
      if (this.gamePhase === 'in_progress' && this.gameRunner) {
        this.gameRunner.send({
          type: 'PLAYER_DISCONNECTED',
          payload: { playerId, reason: 'timeout' },
        });
        // Also notify board
        this.board?.emit('message', {
          type: 'PLAYER_DISCONNECTED',
          payload: { playerId, reason: 'timeout' },
        });
      }

      this._emitPlayerListChanged();
      if (this.gamePhase === 'lobby') {
        this._broadcastLobbyState();
      }
    }
  }

  // ─── Game → Clients Routing ──────────────────────────────────────────────

  _routeFromGame(msg) {
    // Cache board state for reconnection
    if (msg.type === 'UPDATE_BOARD') {
      this.lastBoardState = msg;
    }

    switch (msg.to) {
      case 'board':
        this.board?.emit('message', msg);
        break;

      case 'all_players':
        for (const p of this.players.values()) {
          p.socket?.emit('message', msg);
        }
        break;

      default:
        if (msg.to?.startsWith('player:')) {
          const id = msg.to.replace('player:', '');
          this.players.get(id)?.socket?.emit('message', msg);
        }
        // Broadcast events: GAME_STARTED, GAME_OVER → board + all players
        if (msg.type === 'GAME_STARTED' || msg.type === 'GAME_OVER') {
          this.board?.emit('message', msg);
          for (const p of this.players.values()) {
            p.socket?.emit('message', msg);
          }
        }
        // UPDATE_ALL_PLAYERS → all players
        if (msg.type === 'UPDATE_ALL_PLAYERS') {
          for (const p of this.players.values()) {
            p.socket?.emit('message', msg);
          }
        }
        // PLAYER_CONNECTED → board + game (game already has it)
        if (msg.type === 'PLAYER_CONNECTED' || msg.type === 'PLAYER_DISCONNECTED') {
          this.board?.emit('message', msg);
        }
        // Host-internal events: ERROR, SAVE_STATE_RESPONSE, __LOG__
        this._handleHostEvent(msg);
        break;
    }
  }

  _handleHostEvent(msg) {
    if (msg.type === 'ERROR' && msg.payload?.fatal) {
      this.board?.emit('message', msg);
      for (const p of this.players.values()) {
        p.socket?.emit('message', msg);
      }
    }
    if (msg.type === 'SAVE_STATE_RESPONSE') {
      this.emit('save-state', msg.payload);
    }
  }

  // ─── Lobby ───────────────────────────────────────────────────────────────

  _broadcastLobbyState() {
    const minPlayers = this.manifest?.players?.min ?? 1;
    const maxPlayers = this.manifest?.players?.max ?? 99;

    const playerList = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
    }));

    const allReady = playerList.length > 0 && playerList.every((p) => p.ready);
    const canStart = allReady && playerList.length >= minPlayers;

    const lobbyMsg = {
      type: 'LOBBY_STATE',
      payload: {
        players: playerList,
        minPlayers,
        maxPlayers,
        canStart,
      },
    };

    // Send to board
    this.board?.emit('message', lobbyMsg);

    // Send to all players
    for (const p of this.players.values()) {
      p.socket?.emit('message', lobbyMsg);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Get the current player list for display in the host menu UI.
   */
  getPlayerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      ready: p.ready,
    }));
  }

  /**
   * Get players in the format expected by GAME_INIT.
   */
  getPlayersForGameInit() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      index: p.index,
    }));
  }

  /**
   * Notify game sandbox that a player has connected (initial connection).
   * Called by host after game is started and player was already in lobby.
   */
  notifyExistingPlayersConnected() {
    for (const p of this.players.values()) {
      if (p.connected && this.gameRunner) {
        this.gameRunner.send({
          type: 'PLAYER_CONNECTED',
          payload: { playerId: p.id, isReconnect: false },
        });
      }
    }
  }

  _emitPlayerListChanged() {
    this.emit('player-list-changed', this.getPlayerList());
  }
}

module.exports = SocketServer;
