import { GameHost, GameStatus } from '@prisma/client';
import { GameEngineService, GameState } from './game-engine.service';
import { Card } from './buraco/deck';
import { Meld } from './buraco/rules';

// Verification of the `game:end` payload a client reads after a target-score win, using a
// 2500-point table as the worked example:
//
//   reason               → 'target_score_reached'
//   players[].score      → the MATCH score, >= the target, WITH the final round already in
//   players[].roundScore → that same final round on its own
//
// The one that matters is the relationship between the two: a client showing 2145 on the
// final scoreboard after a 1100 round would be reading a match score that had not been
// accumulated yet. It must read 3245.
const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';

const TARGET_SCORE   = 2500;
const SCORE_BEFORE   = 2145;   // team 1's match score going into the final round
const EXPECTED_ROUND = 1100;   // what the board below is worth, including the +100 close
const EXPECTED_TOTAL = 3245;   // 2145 + 1100

function card(suit: Card['suit'], rank: Card['rank'], id: string): Card {
  return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' };
}

/** A same-rank meld of `n` cards. 7+ with no wilds scores a clean Buraco (+200). */
function set(rank: Card['rank'], n: number, id: string): Meld {
  const suits: Card['suit'][] = ['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES'];
  const cards = Array.from({ length: n }, (_, i) => card(suits[i % 4], rank, `${id}-${i}`));
  return { id, teamId: 1, type: 'SET', cards, isNatural: true, isCanasta: n >= 7, everDirty: false };
}

/**
 * Team 1's closing board, worth exactly 1100 in Classic:
 *   card values   7 K(10) + 7 Q(10) + 7 J(10) + 6 A(15) + 5 10(10) + 5 9(10) = 400
 *   Buraco bonus  3 clean canastas (K, Q, J) x 200                           = 600
 *   close bonus                                                              = 100
 *   hand penalty  they went out, nothing left                                =   0
 *   pot penalty   team 1 took its pot                                        =   0
 *                                                                      total = 1100
 */
function winningBoard(): Meld[] {
  return [set('K', 7, 'mk'), set('Q', 7, 'mq'), set('J', 7, 'mj'), set('A', 6, 'ma'), set('10', 5, 'm10'), set('9', 5, 'm9')];
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
    stockPile: [],
    discardPile: [card('DIAMONDS', 'Q', 'disc-1')],
    potPiles: [[], []],
    hands: { [P1]: [], [P2]: [] },
    melds: { [P1]: winningBoard(), [P2]: [] },
    teamMelds: { 1: [], 2: [] },
    players: [
      { userId: P1, teamId: 1, isConnected: true },
      { userId: P2, teamId: 2, isConnected: true },
    ],
    turnOrder: [P1, P2],
    currentTurnIndex: 0,
    turnPhase: 'CAN_MELD_OR_DISCARD',
    gameStartedAt: Date.now() - 600_000,
    turnStartedAt: Date.now(),
    turnDuration: 30,
    round: 4,
    scores: { 1: 0, 2: 0 },
    moveCount: 120,
    potCollectedByTeam: [1],          // team 1 took its pot; team 2 did not (-100)
    seatMap: { [P1]: 0, [P2]: 1 },
    usernames: { [P1]: 'player one', [P2]: 'player two' },
    toss: null,
    setupComplete: true,
    tossComplete: true,
    targetScore: TARGET_SCORE,
    // Where the match stands BEFORE this round is added — the "previous match" number.
    matchScores: { 1: SCORE_BEFORE, 2: 900 },
    consecutiveMissedTurns: {},
    forfeitMissedTurns: {},
    ...overrides,
  } as GameState;
}

function buildService(state: GameState) {
  const prisma: any = {
    gameSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: GAME_ID,
        status: GameStatus.IN_PROGRESS,
        hostedBy: GameHost.SERVER,
        roomId: 'room-1',
        mode: 'CLASSIC',
        variant: 'ONE_VS_ONE',
        startedAt: new Date(Date.now() - 600_000),
        createdAt: new Date(Date.now() - 600_000),
        players: [{ userId: P1, teamId: 1 }, { userId: P2, teamId: 2 }],
        matchRecord: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    matchRecord: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    matchResultReport: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    gameMove: { create: jest.fn().mockResolvedValue({}) },
    room: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
  };
  const heldLocks = new Set<string>();
  const redis: any = {
    getJson: jest.fn().mockResolvedValue(state),
    setJson: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockImplementation((k: string) => { heldLocks.delete(k); return Promise.resolve(1); }),
    setNx: jest.fn().mockImplementation((k: string) => {
      if (heldLocks.has(k)) return Promise.resolve(null);
      heldLocks.add(k);
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
  return { service, prisma, redis, socket, state };
}

/** The `game:end` payload broadcast to the table. */
function gameEnd(socket: any) {
  const call = [...socket.emitToRoom.mock.calls].reverse().find((c: any[]) => c[1] === 'game:end');
  return call?.[2];
}

describe('game:end after a target-score (2500) win', () => {
  it('answers all four checks in one payload', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    await service.finalizeGame(GAME_ID, state, /* closerTeamId */ 1);
    const end = gameEnd(socket);
    const winner = end.players.find((p: any) => p.userId === P1);

    // 1 — reason
    expect(end.reason).toBe('target_score_reached');

    // 2 — the winner's Match Score is at or past the target
    expect(winner.score).toBe(EXPECTED_TOTAL);
    expect(winner.score).toBeGreaterThanOrEqual(TARGET_SCORE);

    // 3 — the same player's roundScore is the LAST round on its own
    expect(winner.roundScore).toBe(EXPECTED_ROUND);
    expect(end.roundScores[1]).toBe(EXPECTED_ROUND);

    // 4 — score ALREADY includes that round: 2145 + 1100 = 3245, not 2145
    expect(winner.score).toBe(SCORE_BEFORE + winner.roundScore);
    expect(winner.score).not.toBe(SCORE_BEFORE);
  });

  it('agrees with itself everywhere the client can look', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    await service.finalizeGame(GAME_ID, state, 1);
    const end = gameEnd(socket);

    expect(end.winnerTeam).toBe(1);
    expect(end.winnerIds).toEqual([P1]);
    // Root `scores` is team-keyed and carries the same accumulated totals as players[].score.
    expect(end.scores).toEqual({ 1: EXPECTED_TOTAL, 2: 800 });
    for (const row of end.players) expect(row.score).toBe(end.scores[row.teamId]);
    for (const row of end.players) expect(row.roundScore).toBe(end.roundScores[row.teamId]);
    expect(end.buracoOfTwos).toBe(false);

    // Redis keeps the same numbers, so a reconnect after the fact reads the same scoreboard.
    expect(state.status).toBe(GameStatus.COMPLETED);
    expect(state.matchScores).toEqual({ 1: EXPECTED_TOTAL, 2: 800 });
    const resync = service.buildGameEndPlayersFromState({ lastRoundScores: state.lastRoundScores, winnerTeam: state.winnerTeam });
    expect(resync.find(r => r.userId === P1)).toMatchObject({ score: EXPECTED_TOTAL, roundScore: EXPECTED_ROUND, result: 'WIN' });
  });

  it('reports the loser the same way — accumulated score, own round score', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    await service.finalizeGame(GAME_ID, state, 1);
    const loser = gameEnd(socket).players.find((p: any) => p.userId === P2);

    expect(loser.result).toBe('LOSS');
    expect(loser.roundScore).toBe(-100);          // no melds, and the pot was never taken
    expect(loser.score).toBe(900 + loser.roundScore);
    expect(loser.score).toBe(800);
  });

  it('breaks the round down so both devices show identical rows', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    await service.finalizeGame(GAME_ID, state, 1);
    const winner = gameEnd(socket).players.find((p: any) => p.userId === P1);

    expect(winner).toMatchObject({
      boardScore:      400,    // card values of the melds, bonuses counted separately
      cleanBuraco:     3,      // K, Q and J
      semiCleanBuraco: 0,
      dirtyBuraco:     0,
      paidCards:       0,      // went out, nothing left in hand
      finishBonus:     100,
      potNotTaken:     0,      // team 1 took its pot
    });
    // boardScore + 3 clean Buracos + close bonus - hand = the round score reported.
    expect(winner.boardScore + winner.cleanBuraco * 200 + winner.finishBonus - winner.paidCards)
      .toBe(winner.roundScore);
  });

  it('ends the match on landing exactly ON the target, not only past it', async () => {
    // 1400 + 1100 = exactly 2500. `>= targetScore` must be what decides it.
    const state = gameState({ matchScores: { 1: TARGET_SCORE - EXPECTED_ROUND, 2: 0 } });
    const { service, socket } = buildService(state);

    const result: any = await service.finalizeGame(GAME_ID, state, 1);

    expect(result.roundTransition).toBeUndefined();     // no new round was dealt
    expect(gameEnd(socket).reason).toBe('target_score_reached');
    expect(gameEnd(socket).players.find((p: any) => p.userId === P1).score).toBe(TARGET_SCORE);
  });

  it('one point short of the target deals another round instead of ending', async () => {
    const state = gameState({ matchScores: { 1: TARGET_SCORE - EXPECTED_ROUND - 1, 2: 0 } });
    const { service, socket } = buildService(state);

    const result: any = await service.finalizeGame(GAME_ID, state, 1);

    expect(result.roundTransition).toBe(true);
    expect(gameEnd(socket)).toBeUndefined();
    expect(state.matchScores[1]).toBe(TARGET_SCORE - 1);
  });

  it('below the target it is a round transition, and no game:end is sent', async () => {
    const state = gameState({ matchScores: { 1: 100, 2: 0 } });
    const { service, socket } = buildService(state);

    const result: any = await service.finalizeGame(GAME_ID, state, 1);

    expect(result.roundTransition).toBe(true);
    expect(gameEnd(socket)).toBeUndefined();
    // The round is still accumulated — 100 + 1100 = 1200, carried into the next round.
    expect(state.matchScores[1]).toBe(100 + EXPECTED_ROUND);
  });

  it('a Buraco-of-2s win is labelled buraco_of_twos, not target_score_reached', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    await service.finalizeGame(GAME_ID, state, 1, /* buracoOfTwos */ true);

    expect(gameEnd(socket).reason).toBe('buraco_of_twos');
    expect(gameEnd(socket).buracoOfTwos).toBe(true);
    // Scores accumulate identically on this path.
    expect(gameEnd(socket).players.find((p: any) => p.userId === P1).score).toBe(EXPECTED_TOTAL);
  });
});
