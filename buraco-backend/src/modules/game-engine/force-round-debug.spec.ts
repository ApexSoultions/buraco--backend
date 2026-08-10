import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GameHost, GameStatus, MoveType } from '@prisma/client';
import { GameEngineService, GameState } from './game-engine.service';
import { Card } from './buraco/deck';

// Covers the temporary QA hook behind the `game:debug:force_round` socket event:
//  • it lands the match in the ONE state where the 75-rule applies (round >= 2, team on 1000)
//  • the rule it arms really is active/unsatisfied on the next meld (see seventy-five-rule.spec.ts
//    for the accumulate/cancel/auto-cancel behaviour itself)
//  • it stays out of the match-ending machinery — no settle, no game:end, no forfeit reset
// Delete this file together with forceRoundForTesting once the 75-rule is signed off.
const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';
const OUTSIDER = 'c1a2b3d4-0000-4000-8000-000000000000';

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
    targetScore: 3000,
    matchScores: { 1: 100, 2: 80 },
    consecutiveMissedTurns: {},
    forfeitMissedTurns: {},
    ...overrides,
  } as GameState;
}

function buildService(state: GameState | null = gameState()) {
  const prisma: any = {
    gameSession: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    matchRecord: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    matchResultReport: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    gameMove: { create: jest.fn().mockResolvedValue({}) },
    room: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
  };
  // Returns the same live object every read, so in-place mutations by the engine are
  // visible to the next call — the closest stand-in for a single Redis key.
  const redis: any = {
    getJson: jest.fn().mockResolvedValue(state),
    setJson: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    setNx: jest.fn().mockResolvedValue('OK'),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    keys: jest.fn().mockResolvedValue([]),
  };
  const economy: any = { distributeMatchReward: jest.fn().mockResolvedValue(undefined) };
  const stats: any = { updateAfterMatch: jest.fn().mockResolvedValue(undefined) };
  const socket: any = { emitToRoom: jest.fn(), emitPerPlayer: jest.fn().mockResolvedValue(undefined) };

  const service = new GameEngineService(prisma, redis, economy, stats, socket);
  return { service, prisma, redis, economy, stats, socket, state };
}

describe('game:debug:force_round — forceRoundForTesting', () => {
  it('jumps to round 2 with both teams on 1000 and the 75-rule armed', async () => {
    const { service, state } = buildService();

    const result = await service.forceRoundForTesting(GAME_ID, P1);

    expect(result.round).toBe(2);
    expect(result.matchScores).toEqual({ 1: 1000, 2: 1000 });
    for (const uid of [P1, P2]) {
      expect(result.seventyFiveRule[uid]).toEqual({ active: true, requirement: 75, satisfied: false, pendingCardIds: [] });
      expect(state!.hands[uid]).toHaveLength(11);
      expect(state!.melds[uid]).toEqual([]);
    }
    expect(state!.potPiles.map(p => p.length)).toEqual([11, 11]);
    expect(state!.discardPile).toHaveLength(1);
    expect(state!.turnPhase).toBe('MUST_DRAW');
    expect(state!.status).toBe(GameStatus.IN_PROGRESS);
    expect(state!.toss).toBeNull();
  });

  it('really arms the rule — a 15-point first meld is accepted but left pending (not yet satisfied)', async () => {
    const { service, state } = buildService();
    await service.forceRoundForTesting(GAME_ID, P1);

    // Hand the player a legal but cheap meld (three 4s = 15 pts) mid-turn.
    const cheap = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3')];
    state!.hands[P1] = [...cheap, card('HEARTS', 'K', 'k1'), card('CLUBS', '9', 'n1')];
    state!.turnPhase = 'CAN_MELD_OR_DISCARD';

    const result = await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    // Accepted, not rejected — but nowhere near 75, so still unsatisfied and reclaimable.
    expect(state!.seventyFiveRule![P1].requirement).toBe(75);
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual(['c1', 'c2', 'c3']);
    expect(state!.melds[P1]).toHaveLength(1);
    expect((result as any).state.seventyFiveTurnPoints).toBe(15);
    expect((result as any).state.seventyFiveSatisfied).toBe(false);
  });

  it('teamScore below the threshold leaves the rule off, so the same cheap meld is allowed', async () => {
    const { service, state } = buildService();
    await service.forceRoundForTesting(GAME_ID, P1, { teamScore: 500 });

    expect(state!.seventyFiveRule![P1]).toEqual({ active: false, requirement: 75, satisfied: true, pendingCardIds: [] });

    const cheap = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3')];
    state!.hands[P1] = [...cheap, card('HEARTS', 'K', 'k1'), card('CLUBS', '9', 'n1')];
    state!.turnPhase = 'CAN_MELD_OR_DISCARD';

    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });
    expect(state!.melds[P1]).toHaveLength(1);
  });

  it('broadcasts a normal game:new_round and never ends or settles the match', async () => {
    const { service, socket, prisma, economy, state } = buildService();

    await service.forceRoundForTesting(GAME_ID, P1);

    const events = socket.emitPerPlayer.mock.calls.map((c: any[]) => c[1]);
    expect(events).toContain('game:new_round');
    expect(socket.emitToRoom).not.toHaveBeenCalled();          // no game:end
    expect(prisma.matchRecord.create).not.toHaveBeenCalled();  // no settlement
    expect(economy.distributeMatchReward).not.toHaveBeenCalled();
    expect(state!.winnerTeam).toBeUndefined();
  });

  it('leaves the forfeit counter alone — the 12-turn AFK system is untouched', async () => {
    const { service, state } = buildService(gameState({ forfeitMissedTurns: { [P1]: 7 } }));

    await service.forceRoundForTesting(GAME_ID, P1);

    expect(state!.forfeitMissedTurns![P1]).toBe(7);
  });

  it('accepts an explicit round number and never goes below 2', async () => {
    const { service } = buildService();
    expect((await service.forceRoundForTesting(GAME_ID, P1, { round: 5 })).round).toBe(5);
    expect((await service.forceRoundForTesting(GAME_ID, P1, { round: 1 })).round).toBe(2);
  });

  it('refuses a caller who is not at this table', async () => {
    const { service } = buildService();
    await expect(service.forceRoundForTesting(GAME_ID, OUTSIDER)).rejects.toThrow(ForbiddenException);
  });

  it('refuses a match that has already ended', async () => {
    const { service } = buildService(gameState({ status: GameStatus.COMPLETED, winnerTeam: 1 }));
    await expect(service.forceRoundForTesting(GAME_ID, P1)).rejects.toThrow(BadRequestException);
  });
});
