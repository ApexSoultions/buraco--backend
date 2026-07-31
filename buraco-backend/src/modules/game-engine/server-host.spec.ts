import { ForbiddenException } from '@nestjs/common';
import { GameHost, GameStatus } from '@prisma/client';
import { GameEngineService, GameState } from './game-engine.service';

// Covers the behaviour that makes this backend — not a player's phone — the match host:
//  • only hostedBy=SERVER games are driven by the auto-play cron
//  • 12 auto-played turns end the match: a win if an opponent is present, a DRAW if not
//  • rewards and match records are written exactly once, however many endings race
const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';

/** Minimal 1v1 IN_PROGRESS state — enough for the ending paths to score and settle. */
function gameState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: GAME_ID,
    hostedBy: GameHost.SERVER,
    mode: 'CLASSIC',
    variant: 'ONE_VS_ONE',
    endMode: 'INDIRECT',
    makart: false,
    status: GameStatus.IN_PROGRESS,
    stockPile: [],
    discardPile: [],
    potPiles: [[], []],
    hands: { [P1]: [], [P2]: [] },
    melds: { [P1]: [], [P2]: [] },
    teamMelds: { 1: [], 2: [] },
    players: [
      { userId: P1, teamId: 1, isConnected: true },
      { userId: P2, teamId: 2, isConnected: true },
    ],
    turnOrder: [P1, P2],
    currentTurnIndex: 0,
    turnPhase: 'MUST_DRAW',
    gameStartedAt: Date.now() - 300_000,
    turnStartedAt: Date.now() - 60_000,
    turnDuration: 30,
    round: 1,
    scores: { 1: 0, 2: 0 },
    moveCount: 20,
    potCollectedByTeam: [],
    seatMap: { [P1]: 0, [P2]: 1 },
    usernames: { [P1]: 'player one', [P2]: 'player two' },
    toss: null,
    setupComplete: true,
    tossComplete: true,
    targetScore: 0,
    matchScores: { 1: 100, 2: 80 },
    consecutiveMissedTurns: {},
    forfeitMissedTurns: {},
    ...overrides,
  } as GameState;
}

function buildService(opts: { state?: GameState | null; existingRecord?: boolean } = {}) {
  const state = opts.state === undefined ? gameState() : opts.state;

  const prisma: any = {
    gameSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: GAME_ID,
        status: GameStatus.IN_PROGRESS,
        hostedBy: GameHost.SERVER,
        roomId: 'room-1',
        mode: 'CLASSIC',
        variant: 'ONE_VS_ONE',
        startedAt: new Date(Date.now() - 300_000),
        createdAt: new Date(Date.now() - 300_000),
        players: [{ userId: P1, teamId: 1 }, { userId: P2, teamId: 2 }],
        matchRecord: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    matchRecord: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(opts.existingRecord ? { id: 'existing' } : null),
    },
    matchResultReport: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    gameMove: { create: jest.fn().mockResolvedValue({}) },
    room: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
  };

  // Each distinct key can be SETNX'd once — the same "first caller wins" semantics the
  // real lock has, which is what the double-settlement tests depend on.
  const heldLocks = new Set<string>();
  const redis: any = {
    getJson: jest.fn().mockResolvedValue(state),
    setJson: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockImplementation((key: string) => { heldLocks.delete(key); return Promise.resolve(1); }),
    setNx: jest.fn().mockImplementation((key: string) => {
      if (heldLocks.has(key)) return Promise.resolve(null);
      heldLocks.add(key);
      return Promise.resolve('OK');
    }),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    keys: jest.fn().mockResolvedValue([]),
  };

  const economy: any = { distributeMatchReward: jest.fn().mockResolvedValue(undefined) };
  const stats: any = { updateAfterMatch: jest.fn().mockResolvedValue(undefined) };
  const socket: any = { emitToRoom: jest.fn(), emitPerPlayer: jest.fn().mockResolvedValue(undefined) };

  const service = new GameEngineService(prisma, redis, economy, stats, socket);
  return { service, prisma, redis, economy, stats, socket };
}

/** Drives checkAndForfeit (private) via handleTurnTimeout's public entry point. */
async function forfeitViaTimeout(service: GameEngineService) {
  await service.handleTurnTimeout(GAME_ID);
}

/** The payload of the last `game:end` emitted. */
function lastGameEnd(socket: any) {
  const call = [...socket.emitToRoom.mock.calls].reverse().find((c: any[]) => c[1] === 'game:end');
  return call?.[2];
}

describe('12 missed turns — who wins when nobody is playing', () => {
  it('gives the win to the opponent who is still present', async () => {
    // P1 is one auto-turn away from forfeiting; P2 is connected and has made manual moves
    // (forfeitMissedTurns 0), so P2 is present and takes the win.
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service, socket, stats } = buildService({ state });

    await forfeitViaTimeout(service);

    const end = lastGameEnd(socket);
    expect(end.winnerTeam).toBe(2);
    expect(end.winnerIds).toEqual([P2]);
    expect(end.isDraw).toBe(false);
    expect(end.reason).toBe('player_abandoned');
    expect(stats.updateAfterMatch).toHaveBeenCalledWith(P2, 'WIN', expect.any(Number), expect.any(Number));
    expect(stats.updateAfterMatch).toHaveBeenCalledWith(P1, 'LOSS', expect.any(Number), expect.any(Number));
  });

  it('draws when both players closed their phones', async () => {
    // Both sockets are down. Turn order means P1 crosses 12 first; without the mutual-absence
    // check P2 would "win" purely for having gone second.
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 11 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 11 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: false },
      ],
    });
    const { service, socket, prisma, stats } = buildService({ state });

    await forfeitViaTimeout(service);

    const end = lastGameEnd(socket);
    expect(end.winnerTeam).toBe(0);
    expect(end.winnerIds).toEqual([]);
    expect(end.isDraw).toBe(true);
    expect(end.reason).toBe('both_players_away');
    expect(end.players.every((p: any) => p.result === 'DRAW')).toBe(true);

    // Nobody is credited a win, and the winnerTeam columns stay null.
    expect(stats.updateAfterMatch).toHaveBeenCalledWith(P1, 'LOSS', expect.any(Number), expect.any(Number));
    expect(stats.updateAfterMatch).toHaveBeenCalledWith(P2, 'LOSS', expect.any(Number), expect.any(Number));
    expect(prisma.matchRecord.create.mock.calls[0][0].data.winnerTeam).toBeNull();
  });

  it('draws when the opponent is connected but has been idle for 6+ turns', async () => {
    // Phone on the table, app open, not playing — the AI has taken their last 7 turns.
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 7 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 7 },
    });
    const { service, socket } = buildService({ state });

    await forfeitViaTimeout(service);

    expect(lastGameEnd(socket).winnerTeam).toBe(0);
    expect(lastGameEnd(socket).isDraw).toBe(true);
  });

  it('still awards the win when the opponent has only missed a turn or two', async () => {
    // Below the away threshold — P2 is playing, they just lost one turn to the timer.
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 2 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 2 },
    });
    const { service, socket } = buildService({ state });

    await forfeitViaTimeout(service);

    expect(lastGameEnd(socket).winnerTeam).toBe(2);
    expect(lastGameEnd(socket).isDraw).toBe(false);
  });

  it('does not end the match before 12 auto-played turns', async () => {
    const state = gameState({
      forfeitMissedTurns: { [P1]: 5, [P2]: 5 },
      consecutiveMissedTurns: { [P1]: 5, [P2]: 5 },
    });
    const { service, socket, prisma } = buildService({ state });

    await forfeitViaTimeout(service);

    expect(lastGameEnd(socket)).toBeUndefined();
    expect(prisma.matchRecord.create).not.toHaveBeenCalled();
  });
});

describe('settlement happens exactly once', () => {
  it('does not pay a second time when another ending already settled the match', async () => {
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
    });
    // A matchRecord already exists — the durable "already settled" signal that survives a
    // Redis flush or an expired lock.
    const { service, prisma, economy, stats } = buildService({ state, existingRecord: true });

    await forfeitViaTimeout(service);

    expect(prisma.matchRecord.create).not.toHaveBeenCalled();
    expect(economy.distributeMatchReward).not.toHaveBeenCalled();
    expect(stats.updateAfterMatch).not.toHaveBeenCalled();
  });

  it('pays once when a resign and a forfeit race for the same match', async () => {
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
    });
    const { service, prisma, economy } = buildService({ state });

    // Both endings see a live state (getJson is stubbed to keep returning IN_PROGRESS), so
    // only the settled-lock stands between them and a double payout.
    await Promise.all([forfeitViaTimeout(service), service.resignGame(GAME_ID, P2)]);

    expect(prisma.matchRecord.create).toHaveBeenCalledTimes(1);
    expect(economy.distributeMatchReward).toHaveBeenCalledTimes(2); // one per player, once
  });

  it('does not overwrite the recorded outcome when it loses the race', async () => {
    // A forfeit landing after another path already settled must not republish a different
    // winner: the DB and the live Redis state would then disagree about who won.
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
    });
    const { service, redis, socket } = buildService({ state, existingRecord: true });
    redis.setJson.mockClear();

    await forfeitViaTimeout(service);

    // No terminal state written and no game:end broadcast by the losing path.
    const wroteTerminal = redis.setJson.mock.calls.some(
      (c: any[]) => c[1]?.status === GameStatus.COMPLETED,
    );
    expect(wroteTerminal).toBe(false);
    expect(lastGameEnd(socket)).toBeUndefined();
  });

  it('skips the payout when the matchRecord insert loses the unique-index race', async () => {
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
    });
    const { service, prisma, economy } = buildService({ state });
    prisma.matchRecord.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await forfeitViaTimeout(service);

    expect(economy.distributeMatchReward).not.toHaveBeenCalled();
  });
});

describe('only SERVER-hosted games are driven by the cron', () => {
  it('auto-plays a SERVER game whose turn has expired', async () => {
    const { service, redis } = buildService();
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    // The autoplay lock is taken only when the game is actually going to be played.
    expect(redis.setNx).toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
  });

  it('never touches a FUSION game, and drops it from the index', async () => {
    const { service, redis } = buildService({ state: gameState({ hostedBy: GameHost.FUSION }) });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.setNx).not.toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
    expect(redis.srem).toHaveBeenCalledWith('games:active:server', GAME_ID);
  });

  it('treats a state written before hostedBy existed as SERVER', async () => {
    // A live match at deploy time must keep being played, not silently stall.
    const legacy = gameState();
    delete (legacy as any).hostedBy;
    const { service, redis } = buildService({ state: legacy });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.setNx).toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
  });

  it('self-heals the index when the state is gone or the match is over', async () => {
    const { service, redis } = buildService({ state: null });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.srem).toHaveBeenCalledWith('games:active:server', GAME_ID);
  });

  it('rebuilds the index from live states at boot', async () => {
    const { service, redis } = buildService();
    redis.keys.mockResolvedValue([`game:${GAME_ID}:state`]);

    await service.onModuleInit();

    expect(redis.sadd).toHaveBeenCalledWith('games:active:server', GAME_ID);
  });
});

describe('a client cannot report the result of a server-hosted match', () => {
  it('403s report-result when hostedBy is SERVER', async () => {
    const { service } = buildService();

    await expect(
      service.reportMatchResult(GAME_ID, P1, {
        winnerTeam: 1,
        players: [{ playerId: P1, matchScore: 500 }, { playerId: P2, matchScore: 100 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('reconnect payload', () => {
  it('carries the away-from-phone counters and the thresholds they are measured against', async () => {
    const state = gameState({
      forfeitMissedTurns: { [P1]: 0, [P2]: 8 },
      consecutiveMissedTurns: { [P1]: 0, [P2]: 3 },
      players: [
        { userId: P1, teamId: 1, isConnected: true },
        { userId: P2, teamId: 2, isConnected: false },
      ],
    });
    const { service } = buildService({ state });

    const view: any = await service.getGameState(GAME_ID, P1);

    expect(view.forfeitAfterTurns).toBe(12);
    expect(view.awayAfterTurns).toBe(6);

    const me = view.players.find((p: any) => p.userId === P1);
    const them = view.players.find((p: any) => p.userId === P2);
    expect(me).toMatchObject({ awayTurns: 0, missedTurns: 0, isAway: false });
    expect(them).toMatchObject({ awayTurns: 8, missedTurns: 3, isAway: true, isConnected: false });
  });

  it('deals to a player once and resyncs every later join', async () => {
    const { service } = buildService();

    await expect(service.claimInitialDeal(GAME_ID, P1)).resolves.toBe(true);
    // claimInitialDeal persists dealtTo; replay the saved state back for the second call.
    const { service: s2 } = buildService({ state: gameState({ dealtTo: [P1] }) });
    await expect(s2.claimInitialDeal(GAME_ID, P1)).resolves.toBe(false);
    await expect(s2.claimInitialDeal(GAME_ID, P2)).resolves.toBe(true);
  });
});
