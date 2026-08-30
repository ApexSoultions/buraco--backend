import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { GameEngineService, GameState } from '../modules/game-engine/game-engine.service';
import { MessagingService } from '../modules/messaging/messaging.service';
import { RedisService } from '../common/redis/redis.service';
import { ReconnectionService } from '../modules/reconnection/reconnection.service';
import { RoomsService } from '../modules/rooms/rooms.service';
import { SocketService } from '../common/socket/socket.service';
import { GameStatus, MoveType, RoomStatus } from '@prisma/client';
import { Logger } from '@nestjs/common';

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/' })
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(AppGateway.name);

  // Map userId → socketId for presence
  private userSockets = new Map<string, string>();

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private gameEngine: GameEngineService,
    private messaging: MessagingService,
    private redis: RedisService,
    private reconnection: ReconnectionService,
    private roomsService: RoomsService,
    private socketService: SocketService,
  ) {}

  afterInit(server: Server) {
    this.socketService.setServer(server);
    this.logger.log('WebSocket gateway initialized');
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) { socket.disconnect(); return; }

    try {
      const payload = this.jwt.verify(token, { secret: this.config.get('jwt.secret') });

      const sessionStart = await this.redis.get(`user:session:${payload.sub}`);
      if (sessionStart && payload.iat < parseInt(sessionStart, 10)) {
        socket.emit('error', { code: 'SESSION_SUPERSEDED', message: 'Logged in on another device' });
        socket.disconnect();
        return;
      }

      // Kick any existing socket for this user
      const existingSocketId = this.userSockets.get(payload.sub);
      if (existingSocketId && existingSocketId !== socket.id) {
        const existingSockets = await this.server.fetchSockets();
        const old = existingSockets.find((s) => s.id === existingSocketId);
        if (old) {
          old.emit('session:kicked', { reason: 'Logged in on another device' });
          old.disconnect();
        }
      }

      socket.data.userId = payload.sub;
      this.userSockets.set(payload.sub, socket.id);
      await this.redis.set(`online:${payload.sub}`, '1', 30);
      this.logger.log(`User ${payload.sub} connected: ${socket.id}`);
      socket.emit('connect_ack', { userId: payload.sub, socketId: socket.id });

      // Auto-rejoin the active game room so broadcasts from ongoing moves reach
      // this socket immediately, without waiting for the client to emit game:reconnect.
      const activeGameId = await this.redis.get(`user:${payload.sub}:activeGame`);
      if (activeGameId) {
        socket.join(`game:${activeGameId}`);
      }
    } catch {
      socket.emit('error', { code: 'AUTH_FAILED', message: 'Invalid or expired token' });
      socket.disconnect();
    }
  }

  async handleDisconnect(socket: Socket) {
    const userId = socket.data.userId;
    if (!userId) return;
    this.userSockets.delete(userId);
    await this.redis.del(`online:${userId}`);
    this.logger.log(`User ${userId} disconnected`);

    // In-game disconnect: flag the player as away and tell the table.
    //
    // The match is NOT ended, paused, or torn down — the backend hosts it, so the
    // turn-timeout cron keeps playing this player's turns whether or not any socket is
    // open. The match ends only at 12 consecutive auto-played turns (a win for a present
    // opponent, or a draw if everyone is away). The Redis state stays live either way, so
    // whoever comes back resumes from exactly where the server got to.
    const activeGame = await this.redis.get(`user:${userId}:activeGame`);
    if (activeGame) {
      await this.gameEngine.markPlayerDisconnected(activeGame, userId);
      await this.reconnection.markDisconnected(userId, activeGame);
      this.emitPresence(activeGame, userId, false);
    }

    // Grace period: remove player from lobby room if still offline after 15 s
    const seatRoomId = await this.redis.get(`user:${userId}:seatRoom`);
    if (seatRoomId) {
      setTimeout(async () => {
        const stillOnline = await this.redis.get(`online:${userId}`);
        if (!stillOnline) {
          this.logger.log(`Removing disconnected user ${userId} from lobby room ${seatRoomId}`);
          await this.roomsService.handleDisconnectSeat(userId);
        }
      }, 15_000);
    }
  }

  // ─── Presence ─────────────────────────────────────────────────────────────

  /**
   * Tell everyone at the table that a player left or came back.
   *
   * Emits BOTH naming schemes on purpose: the Unity client subscribes to
   * `game:player_disconnected` / `game:player_reconnected` (see GameSocketClient) and had
   * no handler for `player:connection`, so presence never actually reached the phones.
   * `player:connection` is kept for any other consumer already listening to it.
   */
  private emitPresence(gameId: string, playerId: string, connected: boolean) {
    const payload = { gameId, playerId, userId: playerId, connected };
    this.server.to(`game:${gameId}`).emit(
      connected ? 'game:player_reconnected' : 'game:player_disconnected',
      payload,
    );
    this.server.to(`game:${gameId}`).emit('player:connection', payload);
  }

  @SubscribeMessage('ping')
  async handlePing(@ConnectedSocket() socket: Socket) {
    const userId = socket.data.userId;
    if (userId) await this.redis.set(`online:${userId}`, '1', 30);
    socket.emit('pong', { timestamp: Date.now() });
  }

  // ─── Rooms ────────────────────────────────────────────────────────────────

  @SubscribeMessage('room:subscribe')
  handleRoomSubscribe(@ConnectedSocket() socket: Socket) {
    socket.join('room_lobby');
  }

  @SubscribeMessage('room:unsubscribe')
  handleRoomUnsubscribe(@ConnectedSocket() socket: Socket) {
    socket.leave('room_lobby');
  }

  @SubscribeMessage('room:join')
  async handleRoomJoin(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomId: string } | string) {
    // Unity sends roomId as a plain string; web clients may send { roomId }
    const roomId = typeof data === 'string' ? data : data?.roomId;

    if (!roomId) {
      socket.emit('error', { code: 'INVALID_PAYLOAD', message: 'roomId is required' });
      return;
    }

    socket.join(`room:${roomId}`);
    socket.emit('room:joined_ack', { roomId });

    try {
      const room = await this.roomsService.getRoom(roomId);
      if (room.status !== RoomStatus.FULL) return;

      // Delegate to RoomsService rather than re-implementing the start here. It is the
      // single place a match is created — which is what guarantees every match this
      // backend deals is stamped hostedBy=SERVER and handed to the auto-play cron. It
      // takes its own Redis lock, so the HTTP join path and this one cannot double-deal,
      // and it emits room:update itself.
      try {
        const gameId = await this.roomsService.maybeStartGame(room);
        if (gameId) this.logger.log(`Game ${gameId} started for room ${roomId}`);
      } catch (err) {
        this.logger.error(`Failed to start game for room ${roomId}`, err);
        socket.emit('error', { code: 'GAME_START_FAILED', message: (err as Error).message });
      }
    } catch (err) {
      this.logger.error(`room:join failed for room ${roomId}`, err);
      socket.emit('error', { code: 'ROOM_JOIN_FAILED', message: (err as Error).message });
    }
  }

  @SubscribeMessage('room:leave')
  handleRoomLeave(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomId: string }) {
    socket.leave(`room:${data.roomId}`);
  }

  broadcastRoomUpdate(action: string, room: any) {
    this.server.to('room_lobby').emit('room:list_update', { action, room });
  }

  broadcastPlayerJoined(roomId: string, player: any, currentPlayers: number, maxPlayers: number) {
    this.server.to(`room:${roomId}`).emit('room:player_joined', { roomId, player, currentPlayers, maxPlayers });
  }

  broadcastPlayerLeft(roomId: string, userId: string, username: string, currentPlayers: number) {
    this.server.to(`room:${roomId}`).emit('room:player_left', { roomId, userId, username, currentPlayers });
  }

  // ─── Game ─────────────────────────────────────────────────────────────────

  // Reads the authoritative state ONCE and derives each player's filtered view from it,
  // rather than issuing a fresh Redis read per connected socket.
  private async broadcastGameState(gameId: string, lastMove: Record<string, unknown>, skipUserId?: string) {
    const state = await this.redis.getJson<GameState>(this.gameEngine.stateKey(gameId));
    if (!state) return;

    const sockets = await this.server.in(`game:${gameId}`).fetchSockets();
    await Promise.all(
      sockets.map(async (s) => {
        const userId = s.data.userId as string;
        if (!userId || userId === skipUserId) return;
        try {
          s.emit('game:state_updated', { lastMove, ...this.gameEngine.buildClientView(state, userId) });
        } catch {
          // Socket disconnected between move and broadcast — reconnect will sync
        }
      }),
    );
  }

  /**
   * Sends one move out to the whole table: the actor gets the view processMove already
   * built, everyone else gets their own view derived from a single fresh Redis read.
   *
   * Every seat receives the IDENTICAL `lastMove` object — the actor's copy used to be
   * assembled separately from the broadcast one, which is how a rollback could be described
   * to the actor and not to the opponent. `seq` is the post-move `moveCount`: a client that
   * has already applied this move can drop a duplicate/echoed payload instead of tearing
   * down and rebuilding the board again.
   */
  private async publishMove(
    socket: Socket,
    gameId: string,
    lastMove: Record<string, unknown>,
    actorView: any,
  ) {
    const stamped = { ...lastMove, seq: actorView?.moveCount ?? null };
    socket.emit('game:state_updated', { lastMove: stamped, ...actorView });
    await this.broadcastGameState(gameId, stamped, socket.data.userId);
  }

  @SubscribeMessage('game:join')
  async handleGameJoin(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string }) {
    const userId = socket.data.userId;
    socket.join(`game:${data.gameId}`);
    await this.reconnection.setActiveGame(userId, data.gameId);
    await this.reconnection.markReconnected(userId, data.gameId);
    // Mark player back — flips isConnected so the AI stops taking their NEXT turn. Does
    // NOT reset their missed/away-turn counters; those only clear on an actual move.
    await this.gameEngine.markPlayerReconnected(data.gameId, userId);

    try {
      const view = await this.gameEngine.getGameState(data.gameId, userId);

      // Reconnect into an already-ended game (#9 / #4): if the match completed while this
      // client was away (finished / forfeited / resigned), do NOT replay the snapshot or
      // deal — send an authoritative game:end so the client shows the final scoreboard
      // instead of staying stuck in a dead game, and so a player who was disconnected at
      // match end still receives the game:end they missed. Same breakdown every other
      // client already got in game:end (built from the persisted lastRoundScores).
      if (view.status === GameStatus.COMPLETED) {
        socket.emit('game:end', {
          gameId:     data.gameId,
          reason:     'already_ended',
          winnerTeam: view.winnerTeam ?? null,
          scores:     view.matchScores,
          players:    this.gameEngine.buildGameEndPlayersFromState(view),
        });
        await this.reconnection.clearActiveGame(userId);
        return;
      }

      // 1 — stable seat map (same for every player, fresh join or reconnect)
      const seatMap = view.players
        .map((p) => ({
          playerId: p.userId,
          userId: p.userId,
          username: p.username,
          seatIndex: p.seatIndex,
          teamId: p.teamId,
        }))
        .sort((a, b) => a.seatIndex - b.seatIndex);

      socket.emit('game:start_snapshot', {
        gameId: data.gameId,
        seatMap,
        players: seatMap.map((s) => ({ id: s.userId, ...s })),
        turnOrder: view.turnOrder,
        currentTurnIndex: view.currentTurnIndex,
      });

      // Deal ONCE per player, ever. claimInitialDeal returns true only on this player's
      // first join and records them, so every later join — a reconnect, a cold relaunch,
      // a second socket — resumes from the server's board instead of re-running the toss
      // and re-dealing. `moveCount > 0` alone was not enough: a player who dropped before
      // the first move had the whole deal replayed at them.
      const isFirstDeal = await this.gameEngine.claimInitialDeal(data.gameId, userId);

      if (!isFirstDeal || view.moveCount > 0) {
        // Resuming: snap the client to the current state, no deal animation.
        socket.emit('game:state_sync', view);
        this.emitPresence(data.gameId, userId, true);
      } else {
        // Fresh game start: animate toss rounds then deal.
        // Emit each toss round individually — client ignores isTie:true and waits
        // for the decisive isTie:false result (per connection spec §B.1).
        if (view.toss) {
          for (const round of (view.toss as any).rounds ?? []) {
            socket.emit('game:toss_result', {
              gameId:           data.gameId,
              players:          round.players,
              winnerPlayerId:   round.winnerPlayerId  ?? null,
              winnerSeatIndex:  round.winnerSeatIndex ?? null,
              isTie:            round.isTie,
              round:            round.round,
            });
          }
        }
        // 3 — authoritative deal state (Unity animates real hand, not placeholder cards)
        socket.emit('game:deal_start', view);
      }
    } catch (err) {
      this.logger.error(`game:join setup failed for ${userId} in game ${data.gameId}`, err);
    }
  }

  /**
   * `game:deal_complete` — this client has finished animating the cards onto the table.
   *
   * The turn clock does not start until EVERY seat has sent this (or the server's
   * backstop expires), so nobody burns part of their first turn — or an AFK strike —
   * watching the deal. The server broadcasts `game:dealing_complete` to the whole table
   * once the clock actually starts; until then every move is refused with
   * "Please wait until all players are done dealing".
   *
   * Safe to send more than once and safe to omit: a client that never sends it simply
   * waits out the server's backstop instead of freezing the match.
   */
  @SubscribeMessage('game:deal_complete')
  async handleDealComplete(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string }) {
    const userId = socket.data.userId;
    try {
      await this.gameEngine.markDealAnimationComplete(data.gameId, userId);
    } catch (err) {
      this.logger.error(`game:deal_complete failed for ${userId} in game ${data.gameId}`, err);
    }
  }

  @SubscribeMessage('game:reconnect')
  async handleGameReconnect(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string }) {
    const userId = socket.data.userId;
    socket.join(`game:${data.gameId}`);
    await this.reconnection.setActiveGame(userId, data.gameId);
    await this.reconnection.markReconnected(userId, data.gameId);

    await this.gameEngine.markPlayerReconnected(data.gameId, userId);

    // A reconnect NEVER restarts the match or re-deals: the server's Redis state is the
    // match, and the client is simply handed a snapshot of it — board, hand, melds,
    // scores, whose turn it is, and each player's away-from-phone counters — then carries
    // on from exactly where the server got to while they were gone.
    const state = await this.gameEngine.getGameState(data.gameId, userId);

    // Reconnect into an already-ended game (#9 / #4): deliver an authoritative game:end
    // (final scoreboard) rather than a state_sync the client would have to infer as
    // terminal — mirrors handleGameJoin and handleMoveError.
    if (state.status === GameStatus.COMPLETED) {
      socket.emit('game:end', {
        gameId:     data.gameId,
        reason:     'already_ended',
        winnerTeam: state.winnerTeam ?? null,
        scores:     state.matchScores,
        players:    this.gameEngine.buildGameEndPlayersFromState(state),
      });
      await this.reconnection.clearActiveGame(userId);
      return;
    }

    socket.emit('game:state_sync', state);

    // Notify everyone at the table that this player is back.
    this.emitPresence(data.gameId, userId, true);
  }

  // Shared error handler for all game:move:* handlers. If the game already ended
  // server-side (e.g. the opponent resigned) before this move was processed, resync
  // the client with the terminal state via a clean game:end instead of a generic
  // move_invalid — which otherwise looked like the game crashing on the player's next
  // action rather than a normal "opponent left" ending.
  private async handleMoveError(socket: Socket, gameId: string, err: unknown) {
    const reason = (err as Error).message;
    if (reason === 'GAME_NOT_IN_PROGRESS') {
      try {
        const state = await this.gameEngine.getGameState(gameId, socket.data.userId);
        socket.emit('game:end', {
          gameId,
          reason: 'already_ended',
          winnerTeam: state.winnerTeam ?? null,
          scores: state.matchScores,
          // Same authoritative breakdown every other client already got in game:end —
          // without it this resync path fell back to the client's own (diverging) local
          // roundScore computation.
          players: this.gameEngine.buildGameEndPlayersFromState(state),
        });
        await this.reconnection.clearActiveGame(socket.data.userId);
        return;
      } catch { /* state missing entirely — fall through to generic error */ }
    }
    socket.emit('game:move_invalid', { gameId, reason });
  }

  @SubscribeMessage('game:move:draw')
  async handleDraw(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string; source: 'STOCK' | 'DISCARD' }) {
    const userId = socket.data.userId;
    const type = data.source === 'DISCARD' ? MoveType.DRAW_DISCARD : MoveType.DRAW_STOCK;
    try {
      const result = await this.gameEngine.processMove(data.gameId, userId, { type, source: data.source });
      if ('winnerTeam' in result) {
        // game:end already broadcast by finalizeGame — clear active games only
        const sockets = await this.server.in(`game:${data.gameId}`).fetchSockets();
        await Promise.all(sockets.map((s) => this.reconnection.clearActiveGame(s.data.userId)));
      } else if ('roundTransition' in result) {
        // game:new_round already broadcast by finalizeGame — nothing to do
      } else {
        const lastMove: Record<string, unknown> = data.source === 'STOCK'
          ? { type: 'DRAW', playerId: userId, teamId: result.teamId, source: 'STOCK', cardIds: result.result?.card ? [result.result.card.id] : [] }
          : { type: 'PICKUP_DISCARD', playerId: userId, teamId: result.teamId, source: 'DISCARD', cardIds: result.result?.takenCardIds ?? [] };
        await this.publishMove(socket, data.gameId, lastMove, result.state);
      }
    } catch (err) {
      await this.handleMoveError(socket, data.gameId, err);
    }
  }

  @SubscribeMessage('game:move:discard')
  async handleDiscard(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string; cardId: string }) {
    const userId = socket.data.userId;
    try {
      const result = await this.gameEngine.processMove(data.gameId, userId, { type: MoveType.DISCARD, cardIds: [data.cardId] });
      if (result && 'winnerTeam' in result) {
        const sockets = await this.server.in(`game:${data.gameId}`).fetchSockets();
        await Promise.all(sockets.map((s) => this.reconnection.clearActiveGame(s.data.userId)));
      } else if (result && 'roundTransition' in result) {
        // handled by finalizeGame
      } else {
        const lastMove: Record<string, unknown> = {
          type: 'DISCARD',
          playerId: userId,
          teamId: result.teamId,
          cardId: data.cardId,
          // Named per the handoff spec; `cardId` kept for existing clients.
          discardedCardId: data.cardId,
          // A discard that also rolled back a short 75-rule attempt reports the returned
          // cards and the requirement escalation inline, so the client animates the return
          // and re-labels the seat from one payload instead of inferring either.
          autoCancelled75: !!result.rollback,
          ...(result.rollback ?? {}),
        };
        if (result.result?.potAwarded) lastMove['potAwarded'] = result.result.potAwarded;
        await this.publishMove(socket, data.gameId, lastMove, result.state);
      }
    } catch (err) {
      await this.handleMoveError(socket, data.gameId, err);
    }
  }

  @SubscribeMessage('game:move:meld')
  async handleMeld(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string; cardIds: string[] }) {
    const userId = socket.data.userId;
    try {
      const result = await this.gameEngine.processMove(data.gameId, userId, { type: MoveType.PLAY_MELD, cardIds: data.cardIds });
      if ('winnerTeam' in result) {
        const sockets = await this.server.in(`game:${data.gameId}`).fetchSockets();
        await Promise.all(sockets.map((s) => this.reconnection.clearActiveGame(s.data.userId)));
      } else if ('roundTransition' in result) {
        // handled by finalizeGame
      } else {
        const r = result as any;
        const lastMove: Record<string, unknown> = { type: 'MELD', playerId: userId, teamId: r.teamId, meldId: r.result?.meld?.id, cardIds: data.cardIds };
        if (r.result?.potAwarded) lastMove['potAwarded'] = r.result.potAwarded;
        await this.publishMove(socket, data.gameId, lastMove, r.state);
      }
    } catch (err) {
      await this.handleMoveError(socket, data.gameId, err);
    }
  }

  @SubscribeMessage('game:move:add-to-meld')
  async handleAddToMeld(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string; meldId: string; cardIds: string[] }) {
    const userId = socket.data.userId;
    try {
      const result = await this.gameEngine.processMove(data.gameId, userId, { type: MoveType.ADD_TO_MELD, meldId: data.meldId, cardIds: data.cardIds });
      if ('winnerTeam' in result) {
        const sockets = await this.server.in(`game:${data.gameId}`).fetchSockets();
        await Promise.all(sockets.map((s) => this.reconnection.clearActiveGame(s.data.userId)));
      } else if ('roundTransition' in result) {
        // handled by finalizeGame
      } else {
        const r = result as any;
        const lastMove: Record<string, unknown> = { type: 'ADD_TO_MELD', playerId: userId, teamId: r.teamId, meldId: data.meldId, cardIds: data.cardIds };
        if (r.result?.potAwarded) lastMove['potAwarded'] = r.result.potAwarded;
        await this.publishMove(socket, data.gameId, lastMove, r.state);
      }
    } catch (err) {
      await this.handleMoveError(socket, data.gameId, err);
    }
  }

  @SubscribeMessage('game:move:pickup_pot')
  async handlePickupPot(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string }) {
    const userId = socket.data.userId;
    try {
      const result = await this.gameEngine.processMove(data.gameId, userId, { type: MoveType.PICKUP_POT });
      if (!('winnerTeam' in result) && !('roundTransition' in result)) {
        const r = result as any;
        const lastMove = { type: 'PICKUP_POT', playerId: userId, teamId: r.teamId };
        await this.publishMove(socket, data.gameId, lastMove, r.state);
      }
    } catch (err) {
      await this.handleMoveError(socket, data.gameId, err);
    }
  }

  @SubscribeMessage('game:move:cancel_melds')
  async handleCancelMelds(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId: string }) {
    const userId = socket.data.userId;
    try {
      const result = await this.gameEngine.cancelMelds(data.gameId, userId);
      const r = result as any;
      const lastMove: Record<string, unknown> = {
        type: 'CANCEL_MELDS',
        playerId: userId,
        teamId: r.teamId,
        // Legacy name for the same list — clients keyed on `cardIds` keep working.
        cardIds: r.rollback.returnedCardIds,
        // returnedCardIds + the requirement/turn-points before-and-after. Sent to EVERY
        // viewer, not just the actor: the opponent's phone animates these exact cards from
        // that seat's meld area back to its hand, which it could not do while the ids were
        // actor-only and the melds were already gone from its state.
        ...r.rollback,
      };
      await this.publishMove(socket, data.gameId, lastMove, r.state);
    } catch (err) {
      await this.handleMoveError(socket, data.gameId, err);
    }
  }

  @SubscribeMessage('game:leave')
  async handleGameLeave(@ConnectedSocket() socket: Socket, @MessageBody() data: { gameId?: string }) {
    const userId = socket.data.userId;
    const gameId = data?.gameId ?? await this.redis.get(`user:${userId}:activeGame`);
    if (!gameId) return;

    const result = await this.gameEngine.resignGame(gameId, userId);
    if (!result) return;

    this.server.to(`game:${gameId}`).emit('game:end', {
      gameId,
      reason: 'resigned',
      ...result,
    });

    const sockets = await this.server.in(`game:${gameId}`).fetchSockets();
    await Promise.all(sockets.map((s) => this.reconnection.clearActiveGame(s.data.userId)));
  }

  // ─── Debug / QA (temporary) ───────────────────────────────────────────────

  /**
   * `game:debug:force_round` — jump this match to a later round with the 75-rule armed.
   *
   * Body: `{ gameId }`. A bare gameId string is also accepted (Unity sends that shape on
   * some events — see room:join). Optional overrides: `{ round, teamScore }`; teamScore
   * below 1000 forces the scenario where the rule must stay OFF.
   *
   * Replies to the caller with `game:debug:force_round_ack`
   * (`{ gameId, round, matchScores, seventyFiveRule, currentPlayerId }`) or
   * `game:debug:error` on failure. Everyone at the table gets the normal `game:new_round`,
   * so no new client handling is needed beyond firing this event.
   *
   * Turn it off on a server with `DEBUG_GAME_EVENTS=false`. Remove this handler and
   * GameEngineService.forceRoundForTesting once the 75-rule is signed off.
   */
  @SubscribeMessage('game:debug:force_round')
  async handleDebugForceRound(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { gameId?: string; round?: number; teamScore?: number } | string,
  ) {
    if (!this.config.get<boolean>('game.debugEventsEnabled')) {
      socket.emit('game:debug:error', { code: 'DEBUG_DISABLED', message: 'Debug events are disabled on this server' });
      return;
    }

    const userId  = socket.data.userId;
    const payload = typeof data === 'string' ? { gameId: data } : (data ?? {});
    // Fall back to the caller's active game so the test button works even if the client
    // has not threaded a gameId through to it.
    const gameId  = payload.gameId ?? await this.redis.get(`user:${userId}:activeGame`);

    if (!gameId) {
      socket.emit('game:debug:error', { code: 'INVALID_PAYLOAD', message: 'gameId is required' });
      return;
    }

    try {
      const result = await this.gameEngine.forceRoundForTesting(gameId, userId, {
        round: payload.round,
        teamScore: payload.teamScore,
      });
      socket.emit('game:debug:force_round_ack', result);
    } catch (err) {
      this.logger.error(`game:debug:force_round failed for ${userId} in game ${gameId}`, err);
      socket.emit('game:debug:error', { code: 'FORCE_ROUND_FAILED', message: (err as Error).message });
    }
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────

  @SubscribeMessage('chat:send')
  async handleChatSend(@ConnectedSocket() socket: Socket, @MessageBody() data: { conversationId: string; content: string }) {
    const userId = socket.data.userId;
    try {
      const message = await this.messaging.sendMessage(data.conversationId, userId, data.content);
      this.server.to(`conv:${data.conversationId}`).emit('chat:message', message);
    } catch (err) {
      socket.emit('error', { code: 'CHAT_ERROR', message: (err as Error).message });
    }
  }

  @SubscribeMessage('chat:typing')
  handleTyping(@ConnectedSocket() socket: Socket, @MessageBody() data: { conversationId: string; isTyping: boolean }) {
    socket.to(`conv:${data.conversationId}`).emit('chat:typing', { conversationId: data.conversationId, userId: socket.data.userId, isTyping: data.isTyping });
  }

  @SubscribeMessage('chat:read')
  async handleChatRead(@ConnectedSocket() socket: Socket, @MessageBody() data: { conversationId: string }) {
    await this.messaging.markAsRead(data.conversationId, socket.data.userId);
    socket.to(`conv:${data.conversationId}`).emit('chat:read_receipt', { conversationId: data.conversationId, readByUserId: socket.data.userId, readAt: new Date().toISOString() });
  }

  // ─── Notification helpers ─────────────────────────────────────────────────

  async sendNotificationToUser(userId: string, notification: any) {
    const socketId = this.userSockets.get(userId);
    if (socketId) {
      this.server.to(socketId).emit('notification:new', notification);
    }
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }
}
