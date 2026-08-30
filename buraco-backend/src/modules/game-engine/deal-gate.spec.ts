import { BadRequestException } from '@nestjs/common';
import { GameHost, GameMode, GameStatus, GameVariant, MoveType } from '@prisma/client';
import { GameEngineService, GameState, DEALING_IN_PROGRESS_MESSAGE } from './game-engine.service';
import { Card } from './buraco/deck';

// The turn clock used to start the moment the server dealt — in startGame and in
// dealNewRound — so the first player's countdown, and their AFK strike with it, ran while
// every phone was still animating cards onto the table.
//
// The clock now starts when the DEAL finishes: each client sends `game:deal_complete`, and
// only once every seat has reported in does the countdown begin. Until then nothing moves —
// no countdown, no AFK auto-play, and any move is refused with a fixed message. A backstop
// opens the gate on its own so a seat that never connects cannot freeze a hosted match.
const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';

function card(suit: Card['suit'], rank: Card['rank'], id: string): Card {
  return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' };
}

function gameState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: GAME_ID,
    hostedBy: GameHost.SERVER,
    mode: 'CLASSIC',
    variant: 'ONE_VS_ONE',
    endMode: 'INDIRECT',
    makart: false,
    status: GameStatus.IN_PROGRESS,
    // Deep enough that a draw is just a draw — Classic finalises the round at <= 2 left.
    stockPile: Array.from({ length: 10 }, (_, i) => card('CLUBS', '8', `stock-${i}`)),
    discardPile: [card('DIAMONDS', 'Q', 'disc-1')],
    potPiles: [[], []],
    hands: { [P1]: [card('HEARTS', 'K', 'k1'), card('CLUBS', '9', 'n1')], [P2]: [] },
    melds: { [P1]: [], [P2]: [] },
    teamMelds: { 1: [], 2: [] },
    players: [
      { userId: P1, teamId: 1, isConnected: true },
      { userId: P2, teamId: 2, isConnected: true },
    ],
    turnOrder: [P1, P2],
    currentTurnIndex: 0,
    turnPhase: 'MUST_DRAW',
    gameStartedAt: Date.now(),
    // Deliberately long expired: without the gate this table would auto-play immediately.
    turnStartedAt: Date.now() - 120_000,
    turnDuration: 30,
    round: 1,
    scores: { 1: 0, 2: 0 },
    moveCount: 0,
    potCollectedByTeam: [],
    seatMap: { [P1]: 0, [P2]: 1 },
    usernames: { [P1]: 'player one', [P2]: 'player two' },
    toss: null,
    setupComplete: true,
    tossComplete: true,
    // Freshly dealt: the gate is shut and nobody has acked.
    dealPending: true,
    dealAckBy: [],
    dealStartedAt: Date.now(),
    targetScore: 3000,
    matchScores: { 1: 0, 2: 0 },
    consecutiveMissedTurns: {},
    forfeitMissedTurns: {},
    ...overrides,
  } as GameState;
}

function buildService(state: GameState | null = gameState()) {
  const prisma: any = {
    gameSession: {
      create: jest.fn().mockResolvedValue({
        id: GAME_ID,
        players: [{ userId: P1, teamId: 1 }, { userId: P2, teamId: 2 }],
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: P1, username: 'player one' }, { id: P2, username: 'player two' },
      ]),
    },
    matchRecord: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    matchResultReport: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    gameMove: { create: jest.fn().mockResolvedValue({}) },
    room: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
  };
  const redis: any = {
    getJson: jest.fn().mockResolvedValue(state),
    setJson: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    setNx: jest.fn().mockResolvedValue('OK'),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([GAME_ID]),
    keys: jest.fn().mockResolvedValue([]),
  };
  const economy: any = { distributeMatchReward: jest.fn().mockResolvedValue(undefined) };
  const stats: any = { updateAfterMatch: jest.fn().mockResolvedValue(undefined) };
  const socket: any = { emitToRoom: jest.fn(), emitPerPlayer: jest.fn().mockResolvedValue(undefined) };
  const service = new GameEngineService(prisma, redis, economy, stats, socket);
  return { service, prisma, redis, socket, state };
}

/** Names of the events emitted per-player, in order. */
function perPlayerEvents(socket: any): string[] {
  return socket.emitPerPlayer.mock.calls.map((c: any[]) => c[1]);
}

describe('deal gate — the turn timer starts after dealing, not at the deal', () => {
  describe('at game start', () => {
    it('startGame leaves the clock stopped with the gate shut', async () => {
      const { service, redis } = buildService(null);

      const state = await service.startGame(
        'room-1', GameMode.CLASSIC, GameVariant.ONE_VS_ONE, [P1, P2], 'INDIRECT', false, 30, 3000,
      );

      expect(state.dealPending).toBe(true);
      expect(state.dealAckBy).toEqual([]);
      expect(state.dealStartedAt).toBeGreaterThan(0);
      // The match is still handed to the cron — the gate stops the clock, not the hosting.
      expect(redis.sadd).toHaveBeenCalledWith('games:active:server', GAME_ID);
    });
  });

  describe('while dealing', () => {
    it('refuses every move with the fixed message', async () => {
      const { service } = buildService();

      await expect(service.processMove(GAME_ID, P1, { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .rejects.toThrow(DEALING_IN_PROGRESS_MESSAGE);
      expect(DEALING_IN_PROGRESS_MESSAGE).toBe('Please wait until all players are done dealing');

      // Refused for the player NOT to act as well, and before the turn check —
      // "wait for the deal" is the truthful reason, not "not your turn".
      await expect(service.processMove(GAME_ID, P2, { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .rejects.toThrow(DEALING_IN_PROGRESS_MESSAGE);
      await expect(service.processMove(GAME_ID, P1, { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('runs no countdown — the client view reports a full, unticking turn', async () => {
      const state = gameState();
      const { service } = buildService(state);

      const view: any = await service.getGameState(GAME_ID, P1);

      expect(view.dealingComplete).toBe(false);
      // turnStartedAt is 2 minutes stale on the state, yet the view shows a full turn:
      // no time has been taken off anyone for watching the deal.
      expect(view.turnTimeRemaining).toBe(30);
      expect(view.turnEndsAt).toBeGreaterThan(Date.now());
    });

    it('does not auto-play, however long the turn has been "expired"', async () => {
      const state = gameState();
      const { service, socket } = buildService(state);

      await service.checkTurnTimeouts();

      expect(socket.emitToRoom).not.toHaveBeenCalled();      // no TIMEOUT_* move
      expect(state.consecutiveMissedTurns).toEqual({});      // no AFK strike
      expect(state.forfeitMissedTurns).toEqual({});
      expect(state.hands[P1]).toHaveLength(2);               // untouched
      expect(state.currentTurnIndex).toBe(0);
    });

    it('one ack out of two is not enough', async () => {
      const state = gameState();
      const { service, socket } = buildService(state);

      const started = await service.markDealAnimationComplete(GAME_ID, P1);

      expect(started).toBe(false);
      expect(state.dealPending).toBe(true);
      expect(state.dealAckBy).toEqual([P1]);
      expect(perPlayerEvents(socket)).not.toContain('game:dealing_complete');
      await expect(service.processMove(GAME_ID, P1, { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .rejects.toThrow(DEALING_IN_PROGRESS_MESSAGE);
    });
  });

  describe('when dealing finishes', () => {
    it('the last ack starts the clock from that moment and tells the table', async () => {
      const state = gameState();
      const { service, socket } = buildService(state);

      await service.markDealAnimationComplete(GAME_ID, P1);
      const started = await service.markDealAnimationComplete(GAME_ID, P2);

      expect(started).toBe(true);
      expect(state.dealPending).toBe(false);
      // Reset to NOW — the player gets a whole turn, not what was left after the animation.
      expect(state.turnStartedAt).toBeGreaterThan(Date.now() - 1_000);
      expect(perPlayerEvents(socket)).toContain('game:dealing_complete');
    });

    it('moves are accepted again', async () => {
      const state = gameState();
      const { service } = buildService(state);

      await service.markDealAnimationComplete(GAME_ID, P1);
      await service.markDealAnimationComplete(GAME_ID, P2);

      await expect(service.processMove(GAME_ID, P1, { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .resolves.toBeDefined();
      expect(state.hands[P1]).toHaveLength(3);
      expect(state.turnPhase).toBe('CAN_MELD_OR_DISCARD');
    });

    it('the countdown runs again and the client view says so', async () => {
      const state = gameState();
      const { service } = buildService(state);

      await service.markDealAnimationComplete(GAME_ID, P1);
      await service.markDealAnimationComplete(GAME_ID, P2);
      state.turnStartedAt = Date.now() - 10_000;

      const view: any = await service.getGameState(GAME_ID, P1);
      expect(view.dealingComplete).toBe(true);
      expect(view.turnTimeRemaining).toBe(20);
    });

    it('a repeat ack from the same client is harmless', async () => {
      const state = gameState();
      const { service } = buildService(state);

      await service.markDealAnimationComplete(GAME_ID, P1);
      await service.markDealAnimationComplete(GAME_ID, P1);
      expect(state.dealAckBy).toEqual([P1]);
      expect(state.dealPending).toBe(true);

      expect(await service.markDealAnimationComplete(GAME_ID, P2)).toBe(true);
      // The clock is already running; acking again must not restart it.
      const startedAt = state.turnStartedAt;
      expect(await service.markDealAnimationComplete(GAME_ID, P2)).toBe(false);
      expect(state.turnStartedAt).toBe(startedAt);
    });
  });

  describe('backstop', () => {
    it('opens on its own so a seat that never acks cannot freeze the match', async () => {
      // Deal sent 20s ago, only one client ever reported in.
      const state = gameState({ dealStartedAt: Date.now() - 20_000, dealAckBy: [P1] });
      const { service, socket } = buildService(state);

      await service.checkTurnTimeouts();

      expect(state.dealPending).toBe(false);
      expect(perPlayerEvents(socket)).toContain('game:dealing_complete');
      // And the clock restarted here rather than back at the deal, so the first turn is whole.
      expect(state.turnStartedAt).toBeGreaterThan(Date.now() - 1_000);
    });

    it('is a backstop, not the normal path — 5s in, the gate is still shut', async () => {
      const state = gameState({ dealStartedAt: Date.now() - 5_000 });
      const { service } = buildService(state);

      await service.checkTurnTimeouts();

      expect(state.dealPending).toBe(true);
    });
  });

  describe('every new round', () => {
    it('a round transition re-shuts the gate and stops the clock again', async () => {
      // Target far away, so finalizeGame deals a new round instead of ending the match.
      const state = gameState({
        dealPending: false,
        targetScore: 100_000,
        turnPhase: 'CAN_MELD_OR_DISCARD',
      });
      const { service, socket } = buildService(state);

      const result: any = await service.finalizeGame(GAME_ID, state, 1);

      expect(result.roundTransition).toBe(true);
      expect(state.dealPending).toBe(true);
      expect(state.dealAckBy).toEqual([]);
      expect(perPlayerEvents(socket)).toContain('game:new_round');

      // Same three properties as at match start, for the new deal.
      await expect(service.processMove(GAME_ID, state.turnOrder[0], { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .rejects.toThrow(DEALING_IN_PROGRESS_MESSAGE);
      socket.emitToRoom.mockClear();
      await service.checkTurnTimeouts();
      expect(socket.emitToRoom).not.toHaveBeenCalled();

      await service.markDealAnimationComplete(GAME_ID, P1);
      await service.markDealAnimationComplete(GAME_ID, P2);
      expect(state.dealPending).toBe(false);
      await expect(service.processMove(GAME_ID, state.turnOrder[0], { type: MoveType.DRAW_STOCK, source: 'STOCK' }))
        .resolves.toBeDefined();
    });
  });

  describe('states written before the gate existed', () => {
    it('read as "dealing finished" rather than stalling forever', async () => {
      const state = gameState();
      delete (state as any).dealPending;
      delete (state as any).dealAckBy;
      delete (state as any).dealStartedAt;
      const { service, socket } = buildService(state);

      const view: any = await service.getGameState(GAME_ID, P1);
      expect(view.dealingComplete).toBe(true);

      // And the cron drives it exactly as it did before.
      await service.checkTurnTimeouts();
      expect(socket.emitToRoom).toHaveBeenCalled();
    });
  });
});
