import { BadRequestException } from '@nestjs/common';
import { GameHost, GameStatus, MoveType } from '@prisma/client';
import { GameEngineService, GameState } from './game-engine.service';
import { Card } from './buraco/deck';

// Covers the 75-rule REWORK requested by Taimoor (2026-08-03): below-threshold melds are
// accepted and kept on the table (progress like "40/75") instead of rejected outright, can
// be voluntarily undone via game:move:cancel_melds, and are auto-undone (+20 penalty) if the
// player discards without ever reaching the requirement. The force-round scenario setup
// itself (round >= 2, team on 1000) is covered by force-round-debug.spec.ts — this file
// exercises the rule mechanics directly against a hand-built already-armed state.
const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';

function card(suit: Card['suit'], rank: Card['rank'], id: string): Card {
  return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' };
}

/** Minimal IN_PROGRESS state with the 75-rule already armed & unsatisfied for P1. */
function gameState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: GAME_ID,
    hostedBy: GameHost.SERVER,
    mode: 'CLASSIC',
    variant: 'ONE_VS_ONE',
    endMode: 'INDIRECT',
    makart: false,
    status: GameStatus.IN_PROGRESS,
    stockPile: [card('CLUBS', '5', 's1'), card('CLUBS', '6', 's2')],
    discardPile: [card('SPADES', 'J', 'd1')],
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
    turnPhase: 'CAN_MELD_OR_DISCARD',
    gameStartedAt: Date.now() - 300_000,
    turnStartedAt: Date.now() - 5_000,
    turnDuration: 30,
    round: 2,
    scores: { 1: 0, 2: 0 },
    moveCount: 20,
    potCollectedByTeam: [],
    seatMap: { [P1]: 0, [P2]: 1 },
    usernames: { [P1]: 'player one', [P2]: 'player two' },
    toss: null,
    setupComplete: true,
    tossComplete: true,
    targetScore: 3000,
    matchScores: { 1: 1000, 2: 1000 },
    consecutiveMissedTurns: {},
    forfeitMissedTurns: {},
    seventyFiveRule: {
      [P1]: { active: true, requirement: 75, satisfied: false, pendingCardIds: [] },
      [P2]: { active: true, requirement: 75, satisfied: false, pendingCardIds: [] },
    },
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

describe('75-rule — accumulate, cancel, auto-cancel', () => {
  it('accepts a below-threshold meld instead of rejecting it, and reports progress', async () => {
    const { service, state } = buildService();
    const cheap = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3')];
    state!.hands[P1] = [...cheap, card('HEARTS', 'K', 'k1')];

    const result = await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    expect(state!.melds[P1]).toHaveLength(1); // on the table, not rejected
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);
    expect(state!.seventyFiveRule![P1].requirement).toBe(75); // no penalty just for being short
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual(['c1', 'c2', 'c3']);
    const view = (result as any).state;
    expect(view.seventyFiveActive).toBe(true);
    expect(view.seventyFiveSatisfied).toBe(false);
    expect(view.seventyFiveRequired).toBe(75);
    expect(view.seventyFiveTurnPoints).toBe(15);
  });

  it('accumulates across multiple melds this turn until the requirement is met, then locks in', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'), // 15
      card('HEARTS', 'K', 'k1'), card('CLUBS', 'K', 'k2'), card('SPADES', 'K', 'k3'), // 30
      card('HEARTS', 'Q', 'q1'), card('CLUBS', 'Q', 'q2'), card('SPADES', 'Q', 'q3'), // 30 -> total 75
      card('DIAMONDS', '9', 'extra'),
    ];

    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);

    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['k1', 'k2', 'k3'] });
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);
    expect(state!.seventyFiveRule![P1].pendingCardIds).toHaveLength(6);

    const result = await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['q1', 'q2', 'q3'] });

    expect(state!.seventyFiveRule![P1].satisfied).toBe(true);
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual([]);
    expect(state!.seventyFiveRule![P1].requirement).toBe(75); // met it — no penalty
    expect(state!.melds[P1]).toHaveLength(3); // all three melds stay on the table
    expect((result as any).state.seventyFiveSatisfied).toBe(true);
    expect((result as any).state.seventyFiveTurnPoints).toBe(0);
  });

  it('game:move:cancel_melds returns this turn\'s cards to hand and raises the requirement by 20', async () => {
    const { service, state } = buildService();
    const cheap = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3')];
    state!.hands[P1] = [...cheap, card('HEARTS', 'K', 'k1')];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    const result = await service.cancelMelds(GAME_ID, P1);

    expect(state!.melds[P1]).toEqual([]); // meld removed from the board
    expect(state!.hands[P1].map(c => c.id).sort()).toEqual(['c1', 'c2', 'c3', 'k1'].sort());
    expect(state!.seventyFiveRule![P1].requirement).toBe(95);
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual([]);
    expect(state!.turnPhase).toBe('CAN_MELD_OR_DISCARD'); // turn continues, not ended
    expect((result.result as any).returnedCardIds.sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('cancel_melds refuses when there is nothing pending', async () => {
    const { service } = buildService();
    await expect(service.cancelMelds(GAME_ID, P1)).rejects.toThrow(BadRequestException);
  });

  it('cancel_melds refuses out of turn', async () => {
    const { service, state } = buildService();
    state!.seventyFiveRule![P2].pendingCardIds = ['x'];
    await expect(service.cancelMelds(GAME_ID, P2)).rejects.toThrow('NOT_YOUR_TURN');
  });

  it('discarding while still short auto-cancels the pending meld and applies the +20 penalty, then discards normally', async () => {
    const { service, state } = buildService();
    const cheap = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3')];
    state!.hands[P1] = [...cheap, card('HEARTS', 'K', 'k1')];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    // Hand now holds just k1 (the meld cards are on the table) — discard it.
    await service.processMove(GAME_ID, P1, { type: MoveType.DISCARD, cardIds: ['k1'] });

    expect(state!.melds[P1]).toEqual([]); // pending meld pulled back before the discard
    expect(state!.seventyFiveRule![P1].requirement).toBe(95);
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual([]);
    expect(state!.discardPile[state!.discardPile.length - 1].id).toBe('k1');
    // c1/c2/c3 went back to hand first, then k1 (already in hand) was discarded from it.
    expect(state!.hands[P1].map(c => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(state!.currentTurnIndex).toBe(1); // turn actually advanced
  });

  it('discarding with no meld attempt this turn is NOT penalised (nothing pending)', async () => {
    const { service, state } = buildService();
    // Two cards so the discard doesn't empty the hand and trip the (unrelated) close-game path.
    state!.hands[P1] = [card('HEARTS', 'K', 'k1'), card('CLUBS', '9', 'k2')];

    await service.processMove(GAME_ID, P1, { type: MoveType.DISCARD, cardIds: ['k1'] });

    expect(state!.seventyFiveRule![P1].requirement).toBe(75);
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);
  });

  it('ADD_TO_MELD also accumulates toward the requirement', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'), card('DIAMONDS', '4', 'c4'), card('HEARTS', 'A', 'a1')];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });
    const meldId = state!.melds[P1][0].id;

    const result = await service.processMove(GAME_ID, P1, { type: MoveType.ADD_TO_MELD, meldId, cardIds: ['c4'] });

    expect(state!.seventyFiveRule![P1].pendingCardIds.sort()).toEqual(['c1', 'c2', 'c3', 'c4'].sort());
    expect((result as any).state.seventyFiveTurnPoints).toBe(20);
  });

  it('rule inactive (below 1000) never gates or tracks melds', async () => {
    const { service, state } = buildService(gameState({
      seventyFiveRule: {
        [P1]: { active: false, requirement: 75, satisfied: true, pendingCardIds: [] },
        [P2]: { active: false, requirement: 75, satisfied: true, pendingCardIds: [] },
      },
    }));
    // Extra card so melding all three 4s doesn't also trip the unrelated Classic
    // "must leave a card to discard" guard.
    state!.hands[P1] = [card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'), card('DIAMONDS', '9', 'extra')];

    const result = await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual([]);
    expect((result as any).state.seventyFiveActive).toBe(false);
  });
});

// ── Opponent-visible state & rollback payloads ────────────────────────────────────────
// The bugs these cover were all "the two phones disagree": the actor's screen updated and
// the opponent's did not, because the 75-rule fields were viewer-scoped and the returned
// card ids never left the actor's payload.
describe('75-rule — payload seen by the OPPONENT', () => {
  it('publishes every seat\'s 75-rule state in players[], not just the viewer\'s', async () => {
    const { service, state } = buildService();
    state!.seventyFiveRule![P2] = { active: false, requirement: 0, satisfied: true, pendingCardIds: [] };

    // P2's phone asks for its own view — it must still learn P1 is 75-rule active.
    const opponentView: any = service.buildClientView(state!, P2);

    const p1Row = opponentView.players.find((p: any) => p.id === P1);
    expect(p1Row.seventyFiveActive).toBe(true);
    expect(p1Row.seventyFiveRequired).toBe(75);
    expect(p1Row.seventyFiveSatisfied).toBe(false);
    expect(p1Row.seventyFiveTurnPoints).toBe(0);

    // ...and the viewer's own row still describes the viewer, not the actor.
    const p2Row = opponentView.players.find((p: any) => p.id === P2);
    expect(p2Row.seventyFiveActive).toBe(false);
    // Root fields stay viewer-scoped for existing clients.
    expect(opponentView.seventyFiveActive).toBe(false);
  });

  it('shows the opponent the SAME requirement as the actor after a cancel (0/95 on both)', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'),
      card('HEARTS', 'K', 'k1'),
    ];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });
    await service.cancelMelds(GAME_ID, P1);

    const actorView: any    = service.buildClientView(state!, P1);
    const opponentView: any = service.buildClientView(state!, P2);
    const p1FromActor    = actorView.players.find((p: any) => p.id === P1);
    const p1FromOpponent = opponentView.players.find((p: any) => p.id === P1);

    expect(p1FromActor.seventyFiveRequired).toBe(95);
    expect(p1FromOpponent.seventyFiveRequired).toBe(95);
    expect(p1FromOpponent.seventyFiveTurnPoints).toBe(0);
    expect(actorView.seventyFiveRequired).toBe(95);
  });

  it('cancel reports returnedCardIds and the requirement before/after', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'),
      card('HEARTS', 'K', 'k1'),
    ];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    const result: any = await service.cancelMelds(GAME_ID, P1);

    expect(result.rollback).toEqual({
      playerId: P1,
      returnedCardIds: ['c1', 'c2', 'c3'],
      seventyFiveRequiredBefore: 75,
      seventyFiveRequiredAfter: 95,
      seventyFiveTurnPointsBefore: 15,
      seventyFiveTurnPointsAfter: 0,
    });
  });

  it('auto-cancel on discard reports the same rollback shape', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'),
      card('HEARTS', 'K', 'k1'), card('CLUBS', '9', 'k2'),
    ];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });

    const result: any = await service.processMove(GAME_ID, P1, { type: MoveType.DISCARD, cardIds: ['k1'] });

    expect(result.rollback).toEqual({
      playerId: P1,
      returnedCardIds: ['c1', 'c2', 'c3'],
      seventyFiveRequiredBefore: 75,
      seventyFiveRequiredAfter: 95,
      seventyFiveTurnPointsBefore: 15,
      seventyFiveTurnPointsAfter: 0,
    });
    expect(result.result.autoCancelled75).toBe(true);
    expect(result.result.returnedCardIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('a discard with no pending attempt carries no rollback', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [card('HEARTS', 'K', 'k1'), card('CLUBS', '9', 'k2')];

    const result: any = await service.processMove(GAME_ID, P1, { type: MoveType.DISCARD, cardIds: ['k1'] });

    expect(result.rollback).toBeNull();
    expect(result.result.autoCancelled75).toBeUndefined();
  });

  it('leaves no returned card in ANY meld array of EITHER viewer after rollback', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'),
      card('HEARTS', 'K', 'k1'),
    ];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });
    const returned = ((await service.cancelMelds(GAME_ID, P1)) as any).rollback.returnedCardIds;

    for (const viewer of [P1, P2]) {
      const view: any = service.buildClientView(state!, viewer);
      const meldCardIds = [
        ...view.players.flatMap((p: any) => p.melds.flatMap((m: any) => m.cards.map((c: any) => c.id))),
        ...Object.values(view.teamMelds).flatMap((ms: any) => ms.flatMap((m: any) => m.cards.map((c: any) => c.id))),
        ...view.myMelds.flatMap((m: any) => m.cards.map((c: any) => c.id)),
      ];
      for (const id of returned) expect(meldCardIds).not.toContain(id);
    }

    // The actor's hand count includes them again on BOTH viewers' payloads.
    for (const viewer of [P1, P2]) {
      const view: any = service.buildClientView(state!, viewer);
      expect(view.players.find((p: any) => p.id === P1).handCount).toBe(4);
    }
  });

  it('re-rendering the same state never re-applies the +20 penalty', async () => {
    const { service, state } = buildService();
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'),
      card('HEARTS', 'K', 'k1'),
    ];
    await service.processMove(GAME_ID, P1, { type: MoveType.PLAY_MELD, cardIds: ['c1', 'c2', 'c3'] });
    await service.cancelMelds(GAME_ID, P1);

    // Every echoed payload is a pure read of the already-updated state.
    for (let i = 0; i < 5; i++) {
      const view: any = service.buildClientView(state!, P2);
      expect(view.players.find((p: any) => p.id === P1).seventyFiveRequired).toBe(95);
    }
    expect(state!.seventyFiveRule![P1].requirement).toBe(95);

    // ...and a second cancel with nothing pending is refused rather than charged again.
    await expect(service.cancelMelds(GAME_ID, P1)).rejects.toThrow(BadRequestException);
    expect(state!.seventyFiveRule![P1].requirement).toBe(95);
  });
});

// ── Turn timer reported during server auto-play ───────────────────────────────────────
describe('turn timer while the server is auto-playing an absent player', () => {
  it('still reports the room\'s configured turn duration, not a flat 5s, once a player has been auto-played', () => {
    const { service, state } = buildService();
    state!.turnStartedAt = Date.now();
    state!.consecutiveMissedTurns = { [P1]: 1 }; // P1 already had a turn auto-played

    const view: any = service.buildClientView(state!, P2);

    expect(view.turnDuration).toBe(30);         // the table's own setting, not shortened
    expect(view.turnDurationBase).toBe(30);     // the room setting, unchanged
    expect(view.turnFastAutoplay).toBe(false);
    expect(view.turnEndsAt).toBe(state!.turnStartedAt + 30_000);
  });

  it('reports the full configured window for a present player', () => {
    const { service, state } = buildService();
    state!.turnStartedAt = Date.now();
    state!.consecutiveMissedTurns = { [P1]: 0 };

    const view: any = service.buildClientView(state!, P2);

    expect(view.turnDuration).toBe(30);
    expect(view.turnDurationBase).toBe(30);
    expect(view.turnFastAutoplay).toBe(false);
    expect(view.turnEndsAt).toBe(state!.turnStartedAt + 30_000);
  });
});

// ── AI auto-play is bound by the same rule ────────────────────────────────────────────
describe('75-rule — server auto-play (AFK) obeys the opening requirement', () => {
  it('does not open with a below-requirement meld on an absent player\'s behalf', async () => {
    const { service, state } = buildService();
    // Three 4s = 15 points, nowhere near 75, plus junk to discard.
    state!.hands[P1] = [
      card('HEARTS', '4', 'c1'), card('CLUBS', '4', 'c2'), card('SPADES', '4', 'c3'),
      card('DIAMONDS', '9', 'x1'), card('HEARTS', '7', 'x2'),
    ];
    state!.turnPhase = 'CAN_MELD_OR_DISCARD';
    state!.consecutiveMissedTurns = { [P1]: 1 }; // arms smart-play

    await service.handleTurnTimeout(GAME_ID);

    expect(state!.melds[P1]).toEqual([]);                       // nothing laid down
    expect(state!.seventyFiveRule![P1].requirement).toBe(75);    // and so, no penalty
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual([]);
    expect(state!.seventyFiveRule![P1].satisfied).toBe(false);
  });

  it('opens and marks the rule satisfied when the AI can actually reach the requirement', async () => {
    const { service, state } = buildService();
    // 3 Aces (60) + 3 Kings (30) = 90 >= 75.
    state!.hands[P1] = [
      card('HEARTS', 'A', 'a1'), card('CLUBS', 'A', 'a2'), card('SPADES', 'A', 'a3'),
      card('HEARTS', 'K', 'k1'), card('CLUBS', 'K', 'k2'), card('SPADES', 'K', 'k3'),
      card('DIAMONDS', '9', 'x1'), card('HEARTS', '7', 'x2'),
    ];
    state!.turnPhase = 'CAN_MELD_OR_DISCARD';
    state!.consecutiveMissedTurns = { [P1]: 1 };

    await service.handleTurnTimeout(GAME_ID);

    expect(state!.melds[P1].length).toBeGreaterThan(0);
    expect(state!.seventyFiveRule![P1].satisfied).toBe(true);
    expect(state!.seventyFiveRule![P1].pendingCardIds).toEqual([]);
    expect(state!.seventyFiveRule![P1].requirement).toBe(75); // met it — no penalty
  });
});
