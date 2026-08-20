import { ForbiddenException } from '@nestjs/common';
import { GameHost, GameStatus, MoveType } from '@prisma/client';
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

// ── #13: 12 auto-turns ends the MATCH, never just the round ───────────────────────────
//
// The dangerous case is the auto-played turn that would ALSO have ended the round: if the
// round transition ran first it would emit game:new_round, deal a fresh hand and (before
// forfeitMissedTurns was made match-wide) reset the tally, so the match carried on with a
// player who had not touched their phone for 12 turns. Forfeit must be evaluated first and
// the round transition must not happen at all.
describe('12 auto-turns end the match immediately — no game:new_round', () => {
  function card(id: string, rank: any = '5', suit: any = 'CLUBS') {
    return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' } as any;
  }

  /**
   * MUST_DRAW state whose auto-draw leaves the Classic stock at 2 cards — the condition
   * that ends the round — so this single auto-turn is both the 12th miss AND a round end.
   */
  function roundEndingState(overrides: Partial<GameState> = {}) {
    return gameState({
      turnPhase: 'MUST_DRAW',
      stockPile: [card('s1'), card('s2'), card('s3')],
      discardPile: [], // keeps the AI on the stock-draw branch
      hands: { [P1]: [card('h1'), card('h2')], [P2]: [card('h3')] },
      targetScore: 3000,          // non-zero, so a finalize would transition rather than end
      matchScores: { 1: 100, 2: 80 },
      ...overrides,
    });
  }

  /** Every `game:new_round` emitted (it goes out per-player, not to the room). */
  function newRoundEmits(socket: any) {
    return socket.emitPerPlayer.mock.calls.filter((c: any[]) => c[1] === 'game:new_round');
  }

  it('ends with game:end and NO new_round when the 12th auto-turn also ends the round', async () => {
    const state = roundEndingState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service, socket } = buildService({ state });

    await forfeitViaTimeout(service);

    const end = lastGameEnd(socket);
    expect(end).toBeDefined();
    expect(end.winnerTeam).toBe(2);
    expect(end.reason).toBe('player_abandoned');
    expect(newRoundEmits(socket)).toHaveLength(0);
    expect(state.status).toBe(GameStatus.COMPLETED);
    // The round transition never ran, so the tally is not wiped and the round did not advance.
    expect(state.round).toBe(1);
    expect(state.forfeitMissedTurns![P1]).toBe(12);
  });

  it('ends with game:end and NO new_round on an ordinary 12th auto-turn', async () => {
    const state = gameState({
      turnPhase: 'CAN_MELD_OR_DISCARD',
      stockPile: [card('s1'), card('s2'), card('s3'), card('s4'), card('s5')],
      discardPile: [card('d1', 'K', 'SPADES')],
      hands: { [P1]: [card('h1', '9', 'HEARTS'), card('h2', '3', 'DIAMONDS')], [P2]: [card('h3')] },
      targetScore: 3000,
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
    });
    const { service, socket } = buildService({ state });

    await forfeitViaTimeout(service);

    expect(lastGameEnd(socket)).toBeDefined();
    expect(newRoundEmits(socket)).toHaveLength(0);
    expect(state.status).toBe(GameStatus.COMPLETED);
  });

  it('a straggling finalize after the forfeit cannot re-open the match into a new round', async () => {
    // Belt-and-braces on the ordering above: an in-flight finalize landing after the
    // forfeit has set COMPLETED must be refused by finalizeGame's terminal guard.
    const state = roundEndingState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
    });
    const { service, socket } = buildService({ state });

    await forfeitViaTimeout(service);
    const result: any = await service.finalizeGame(GAME_ID, state);

    expect(result.alreadyEnded).toBe(true);
    expect(newRoundEmits(socket)).toHaveLength(0);
    expect(state.round).toBe(1);
  });

  it('still transitions rounds normally when the player is BELOW the threshold', async () => {
    // The control: same round-ending auto-turn, but only 5 misses. The round must advance
    // via game:new_round and the match must NOT end — the forfeit check has to be an
    // early-exit, not a change to normal round handling.
    const state = roundEndingState({
      forfeitMissedTurns: { [P1]: 5, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 5, [P2]: 0 },
    });
    const { service, socket } = buildService({ state });

    await forfeitViaTimeout(service);

    expect(newRoundEmits(socket)).toHaveLength(1);
    expect(lastGameEnd(socket)).toBeUndefined();
    expect(state.status).toBe(GameStatus.IN_PROGRESS);
    expect(state.round).toBe(2);
    // Both miss counters survive the new deal — neither resets on a round transition.
    expect(state.forfeitMissedTurns![P1]).toBe(6);
    expect(state.consecutiveMissedTurns![P1]).toBe(6);
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

// ── Reported bug: reconnecting used to zero the AI-turn counters ─────────────────────
describe('reconnecting does not reset the AI-turn counters', () => {
  it('leaves both miss counters untouched on a bare reconnect', async () => {
    const state = gameState({
      forfeitMissedTurns: { [P1]: 5, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 5, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
      // Not P1's turn, so the "give a fresh window" branch doesn't fire either — this
      // isolates the counter-reset behaviour on its own.
      currentTurnIndex: 1,
    });
    const { service } = buildService({ state });

    await service.markPlayerReconnected(GAME_ID, P1);

    expect(state.players.find((p) => p.userId === P1)!.isConnected).toBe(true);
    // Reconnecting flips presence but must NOT forgive the streak — only an actual move does.
    expect(state.forfeitMissedTurns![P1]).toBe(5);
    expect(state.consecutiveMissedTurns![P1]).toBe(5);
  });

  it('lets a player who reconnects and goes AFK again reach the 12-turn forfeit without restarting the count', async () => {
    // P1 already missed 11 turns before disconnecting, on their own turn.
    const state = gameState({
      forfeitMissedTurns: { [P1]: 11, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 11, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
      currentTurnIndex: 0,
    });
    const { service, socket } = buildService({ state });

    await service.markPlayerReconnected(GAME_ID, P1);
    expect(state.forfeitMissedTurns![P1]).toBe(11);      // unchanged by the reconnect itself
    expect(state.consecutiveMissedTurns![P1]).toBe(11);

    // ...then goes quiet again without ever making a manual move — the very next
    // auto-played turn must be the 12th (forfeit), not the 1st.
    await service.handleTurnTimeout(GAME_ID);

    expect(state.forfeitMissedTurns![P1]).toBe(12);
    expect(lastGameEnd(socket)).toMatchObject({ reason: 'inactive_forfeit', winnerTeam: 2 });
  });

  it('carries both counters across a round transition too, not just a reconnect', async () => {
    // Regression for the flip side of the same bug: dealNewRound used to rebuild
    // consecutiveMissedTurns from scratch for anyone still "connected", silently erasing
    // their streak every time a new hand was dealt.
    const state = gameState({
      stockPile: [],
      discardPile: [],
      hands: { [P1]: [], [P2]: [] },
      forfeitMissedTurns: { [P1]: 4, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 4, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: true }, // connected — the old bug only spared the disconnected
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service } = buildService({ state });

    await service.handleTurnTimeout(GAME_ID); // 5th auto-play; empty hand/stock forces a round-ending path

    expect(state.forfeitMissedTurns![P1]).toBe(5);
    expect(state.consecutiveMissedTurns![P1]).toBe(5);
  });
});

// ── QA scenarios from the AFK-reset report: reconnect-only vs. reconnect-then-move ────
describe('reconnect vs. reconnect+move — which one actually clears the streak', () => {
  function card(id: string, rank: any = '5', suit: any = 'CLUBS') {
    return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' } as any;
  }

  it('scenario 1 — reconnect only: awayTurns stays 7 through state_sync/state_updated, then climbs to 8 on the next AFK timeout', async () => {
    const state = gameState({
      turnPhase: 'MUST_DRAW',
      stockPile: [card('s1'), card('s2'), card('s3'), card('s4'), card('s5')],
      discardPile: [card('d1')],
      hands: { [P1]: [card('h1'), card('h2')], [P2]: [] },
      forfeitMissedTurns: { [P1]: 7, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 7, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
      currentTurnIndex: 0, // P1's turn
    });
    const { service } = buildService({ state });

    // game:join / game:reconnect — no move made.
    await service.markPlayerReconnected(GAME_ID, P1);

    // What state_sync / state_updated actually hands the client — this is what the Unity
    // overlay renders via SyncAutoTurnsFromAuthority, so it's the payload that matters,
    // not just the raw redis field.
    let view: any = await service.getGameState(GAME_ID, P1);
    expect(view.players.find((p: any) => p.userId === P1)).toMatchObject({ awayTurns: 7 });

    // Still no move — next AFK timeout fires (this is what the cron does once turnDuration
    // elapses again).
    await service.handleTurnTimeout(GAME_ID);

    expect(state.forfeitMissedTurns![P1]).toBe(8);
    view = await service.getGameState(GAME_ID, P1);
    expect(view.players.find((p: any) => p.userId === P1)).toMatchObject({ awayTurns: 8 });
  });

  it('scenario 2 — reconnect + one manual move: the move (not the reconnect) resets the streak, so the next AFK run starts at 1, not 8', async () => {
    const state = gameState({
      turnPhase: 'CAN_MELD_OR_DISCARD', // already drew — one discard is the "one manual move"
      stockPile: [card('s1'), card('s2'), card('s3'), card('s4'), card('s5')],
      discardPile: [card('d1')],
      hands: { [P1]: [card('h1'), card('h2')], [P2]: [] },
      forfeitMissedTurns: { [P1]: 7, [P2]: 0 },
      consecutiveMissedTurns: { [P1]: 7, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
      currentTurnIndex: 0, // P1's turn
    });
    const { service } = buildService({ state });

    await service.markPlayerReconnected(GAME_ID, P1);
    expect(state.forfeitMissedTurns![P1]).toBe(7); // reconnect alone: unchanged

    // The one manual move.
    await service.processMove(GAME_ID, P1, { type: MoveType.DISCARD, cardIds: ['h1'] });
    expect(state.forfeitMissedTurns![P1]).toBe(0);
    expect(state.consecutiveMissedTurns![P1]).toBe(0);

    // AFK again — back to P1's turn (stands in for P2 having played theirs in between) and
    // let the timeout fire. This must be miss #1 of a fresh streak, not #8 of the old one.
    state.currentTurnIndex = state.turnOrder.indexOf(P1);
    await service.handleTurnTimeout(GAME_ID);

    expect(state.forfeitMissedTurns![P1]).toBe(1);
    expect(state.consecutiveMissedTurns![P1]).toBe(1);
    const view: any = await service.getGameState(GAME_ID, P1);
    expect(view.players.find((p: any) => p.userId === P1)).toMatchObject({ awayTurns: 1 });
  });
});

// ── A player's FIRST miss of the match always gets the table's full turnDuration; from
// their second consecutive miss onward the server acts after only 5s instead — the
// visible countdown (covered separately in seventy-five-rule.spec.ts) never shortens ────
describe('turn timeout waits the full table duration on a first miss, but only 5s on a repeat miss', () => {
  it('does NOT auto-play an absent player before turnDuration has elapsed, on their first miss', async () => {
    const state = gameState({
      turnDuration: 30,
      turnStartedAt: Date.now() - 10_000, // 10s in — past the repeat-miss 5s, well under 30s
      consecutiveMissedTurns: { [P1]: 0, [P2]: 0 }, // no prior miss yet
      forfeitMissedTurns: { [P1]: 0, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service, redis } = buildService({ state });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.setNx).not.toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
    expect(state.consecutiveMissedTurns![P1]).toBe(0);
  });

  it('auto-plays once turnDuration has elapsed, matching the table setting exactly, on a first miss', async () => {
    const state = gameState({
      turnDuration: 30,
      turnStartedAt: Date.now() - 31_000, // just past the table's 30s
      consecutiveMissedTurns: { [P1]: 0, [P2]: 0 },
      forfeitMissedTurns: { [P1]: 0, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service, redis } = buildService({ state });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.setNx).toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
  });

  it('does NOT auto-play a repeat-miss player before the 5s repeat-miss window elapses', async () => {
    const state = gameState({
      turnDuration: 30,
      turnStartedAt: Date.now() - 3_000, // only 3s in — under the 5s repeat-miss trigger
      consecutiveMissedTurns: { [P1]: 1, [P2]: 0 }, // P1 already missed a turn once
      forfeitMissedTurns: { [P1]: 1, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service, redis } = buildService({ state });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.setNx).not.toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
    expect(state.consecutiveMissedTurns![P1]).toBe(1);
  });

  it('auto-plays a repeat-miss player after only 5s, well before the table\'s 30s would elapse', async () => {
    const state = gameState({
      turnDuration: 30,
      turnStartedAt: Date.now() - 6_000, // 6s in — past the 5s repeat-miss trigger, well under 30s
      consecutiveMissedTurns: { [P1]: 1, [P2]: 0 }, // P1 already missed a turn once
      forfeitMissedTurns: { [P1]: 1, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service, redis } = buildService({ state });
    redis.smembers.mockResolvedValue([GAME_ID]);

    await service.checkTurnTimeouts();

    expect(redis.setNx).toHaveBeenCalledWith(`game:${GAME_ID}:autoplay`, '1', 15);
  });

  it('still shows the table\'s full turnDuration to clients even mid-repeat-miss streak', async () => {
    const state = gameState({
      turnDuration: 30,
      turnStartedAt: Date.now() - 6_000,
      consecutiveMissedTurns: { [P1]: 1, [P2]: 0 },
      forfeitMissedTurns: { [P1]: 1, [P2]: 0 },
      players: [
        { userId: P1, teamId: 1, isConnected: false },
        { userId: P2, teamId: 2, isConnected: true },
      ],
    });
    const { service } = buildService({ state });

    const view: any = await service.getGameState(GAME_ID, P2);

    expect(view.turnDuration).toBe(30);
    expect(view.turnDurationBase).toBe(30);
    expect(view.turnFastAutoplay).toBe(false);
    expect(view.turnEndsAt).toBe(state.turnStartedAt + 30_000);
  });
});

// Regression coverage for the timeout/AI discard path never re-validating a legal close
// the way processMove's manual DISCARD does (see the "No pot — validate close" block
// there: Classic wild, Buraco, and pot-count checks). handleTurnTimeout currently
// finalizes unconditionally once tryAwardPot comes back null, and pickLegalDiscardIndex
// currently offers the last card as "legal" whenever a pot pile is non-empty, without
// checking whether the team actually has a Buraco — so an AFK/timeout run in Professional
// mode with no Buraco can discard the last card and end the round even though neither a
// pot pickup nor a close was ever legally available.
describe('Professional: an illegal last-card discard must not end the round', () => {
  function card(id: string, rank: any = '5', suit: any = 'CLUBS') {
    return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' } as any;
  }

  it('no Buraco + pot still unclaimed: timeout discarding the last card must NOT finalize the round', async () => {
    const state = gameState({
      mode: 'PROFESSIONAL' as any,
      endMode: 'INDIRECT',
      makart: false,
      turnPhase: 'CAN_MELD_OR_DISCARD',
      hands: { [P1]: [card('h1')], [P2]: [card('h2'), card('h3')] },
      potPiles: [[card('p1'), card('p2')], []], // a pot is still sitting there, unclaimed
      potCollectedByTeam: [], // neither team has taken a pot yet
      melds: { [P1]: [], [P2]: [] }, // team 1 (P1) has NO Buraco
      consecutiveMissedTurns: { [P1]: 0, [P2]: 0 }, // first miss — no smart play, exercises pickLegalDiscardIndex
      forfeitMissedTurns: { [P1]: 0, [P2]: 0 },
      targetScore: 3000,
    });
    const { service, socket } = buildService({ state });
    const finalizeSpy = jest.spyOn(service, 'finalizeGame');

    await service.handleTurnTimeout(GAME_ID);

    // Team 1 has no Buraco, so emptying the hand this way is neither a legal pot pickup
    // (tryAwardPot's "must have Buraco before first pot" rule) nor a legal close (the same
    // rule processMove's manual DISCARD enforces) — the round must be left exactly alone.
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(state.status).toBe(GameStatus.IN_PROGRESS);
    expect(state.round).toBe(1);

    const newRoundEmits = socket.emitPerPlayer.mock.calls.filter((c: any[]) => c[1] === 'game:new_round');
    expect(newRoundEmits).toHaveLength(0);
    const gameEnd = socket.emitToRoom.mock.calls.find((c: any[]) => c[1] === 'game:end');
    expect(gameEnd).toBeUndefined();
  });
});
