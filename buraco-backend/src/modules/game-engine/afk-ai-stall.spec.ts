import { GameHost, GameStatus } from '@prisma/client';
import { GameEngineService, GameState } from './game-engine.service';
import { Card } from './buraco/deck';
import { Meld } from './buraco/rules';

// Regression cover for the Professional AFK stall.
//
// Both players inactive, so the server AI plays every turn. It held 2 cards, added one of
// them to a meld, and was left holding a single card it could not legally discard — no
// Buraco, so no pot to take and no close — which ended the turn as TIMEOUT_ADVANCE with no
// discard. Nothing about the position changed, so the very next AI turn did the same thing,
// forever. Human and offline play already refused that move; only the AFK AI did not.
//
// The rule under test: the AI may only meld down to 1 card when discarding THAT card would
// itself be legal.
const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';

function card(suit: Card['suit'], rank: Card['rank'], id: string): Card {
  return { id, suit, rank, isWild: rank === 'JOKER' || rank === '2' };
}

/** A team meld the AI can extend — HEARTS 4-5-6, so HEARTS 7 fits on the end. */
function run456(id = 'm1', extra: Card[] = []): Meld {
  return {
    id,
    teamId: 1,
    type: 'RUN',
    cards: [card('HEARTS', '6', `${id}-6`), card('HEARTS', '5', `${id}-5`), card('HEARTS', '4', `${id}-4`), ...extra],
    isNatural: true,
    isCanasta: false,
    everDirty: false,
  };
}

function gameState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: GAME_ID,
    hostedBy: GameHost.SERVER,
    mode: 'PROFESSIONAL',
    variant: 'ONE_VS_ONE',
    endMode: 'INDIRECT',
    makart: false,
    status: GameStatus.IN_PROGRESS,
    stockPile: [card('CLUBS', '8', 'stock-1')],
    discardPile: [card('DIAMONDS', 'Q', 'disc-1')],
    potPiles: [[card('CLUBS', '3', 'pot-a')], [card('CLUBS', '4', 'pot-b')]],
    // 2 cards, exactly the shape that used to stall: HEARTS 7 extends the meld,
    // SPADES K is the card that would be left behind and could not be discarded.
    hands: { [P1]: [card('HEARTS', '7', 'h7'), card('SPADES', 'K', 'sk')], [P2]: [] },
    melds: { [P1]: [run456()], [P2]: [] },
    teamMelds: { 1: [], 2: [] },
    players: [
      { userId: P1, teamId: 1, isConnected: true },
      { userId: P2, teamId: 2, isConnected: true },
    ],
    turnOrder: [P1, P2],
    currentTurnIndex: 0,
    // Already drawn: isolates the meld/discard decision, which is where the stall lived.
    turnPhase: 'CAN_MELD_OR_DISCARD',
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
    // >= 1 prior miss is what switches the AI from "discard something" to smart play —
    // i.e. the mode that melds, which is the only mode that could strand itself.
    consecutiveMissedTurns: { [P1]: 1 },
    forfeitMissedTurns: { [P1]: 1 },
    ...overrides,
  } as GameState;
}

function buildService(state: GameState) {
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
  return { service, socket, state };
}

/** Every `lastMove.type` the auto-play turn emitted, in order. */
function movesPlayed(socket: any): string[] {
  return socket.emitToRoom.mock.calls
    .filter((c: any[]) => c[1] === 'game:move_played')
    .map((c: any[]) => c[2]?.type);
}

describe('Professional AFK AI — must not meld itself down to an undiscardable last card', () => {
  it('skips the add-to-meld that would leave 1 card, and discards instead', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    const result: any = await service.handleTurnTimeout(GAME_ID);

    // The turn ENDS IN A DISCARD — this is the whole point. Before the fix it was
    // ADVANCE_NO_DISCARD, and the identical position came back round every turn.
    expect(result.autoAction).toBe('DISCARD');
    expect(movesPlayed(socket)).toEqual(['TIMEOUT_DISCARD']);
    expect(movesPlayed(socket)).not.toContain('TIMEOUT_ADVANCE');

    // The meld was left alone — extending it is exactly what stranded the AI.
    expect(state.melds[P1][0].cards).toHaveLength(3);

    // A card really left the hand and landed on the pile, and the turn moved on.
    expect(state.hands[P1]).toHaveLength(1);
    expect(state.discardPile).toHaveLength(2);
    expect(state.currentTurnIndex).toBe(1);
    expect(state.turnPhase).toBe('MUST_DRAW');
  });

  it('does not repeat the same position turn after turn (the actual stall)', async () => {
    const state = gameState();
    const { service, socket } = buildService(state);

    const actions: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      // Hand the AI its turn back with a fresh draw, as a real cycle of the table would.
      state.currentTurnIndex = 0;
      state.turnPhase        = 'CAN_MELD_OR_DISCARD';
      state.hands[P1].push(card('HEARTS', String(8 + turn) as Card['rank'], `draw-${turn}`));
      const result: any = await service.handleTurnTimeout(GAME_ID);
      actions.push(result.autoAction);
    }

    expect(actions).toEqual(['DISCARD', 'DISCARD', 'DISCARD', 'DISCARD']);
    expect(movesPlayed(socket).filter(t => t === 'TIMEOUT_ADVANCE')).toHaveLength(0);
  });

  it('still melds down to 1 card when that last discard IS legal — Buraco on the board unlocks the pot', async () => {
    // Same position, except the team already holds a Buraco. In Professional that makes a
    // last-card discard a legal pot-take, so the AI is free to extend. The guard must be
    // this narrow: it exists to stop dead ends, not to stop the AI playing.
    const buraco = run456('m1', [
      card('HEARTS', '7', 'b7'), card('HEARTS', '8', 'b8'), card('HEARTS', '9', 'b9'), card('HEARTS', '10', 'b10'),
    ]);
    buraco.isCanasta = true;
    const state = gameState({
      melds: { [P1]: [buraco], [P2]: [] },
      // J extends the 4-10 run; SPADES K is the card left behind and discarded for the pot.
      hands: { [P1]: [card('HEARTS', 'J', 'hj'), card('SPADES', 'K', 'sk')], [P2]: [] },
    });
    const { service, socket } = buildService(state);

    const result: any = await service.handleTurnTimeout(GAME_ID);

    expect(state.melds[P1][0].cards).toHaveLength(8);     // the add went through
    expect(movesPlayed(socket)).toContain('TIMEOUT_ADD_TO_MELD');
    expect(result.autoAction).toBe('DISCARD');
    expect(state.potCollectedByTeam).toContain(1);        // the discard emptied the hand and took the pot
    expect(state.hands[P1]).toEqual([{ id: 'pot-a', suit: 'CLUBS', rank: '3', isWild: false }]); // pot picked up
  });

  it('Classic is unaffected — a last-card discard there takes the pot without a Buraco', async () => {
    const state = gameState({ mode: 'CLASSIC' });
    const { service, socket } = buildService(state);

    const result: any = await service.handleTurnTimeout(GAME_ID);

    expect(state.melds[P1][0].cards).toHaveLength(4);     // HEARTS 7 added
    expect(movesPlayed(socket)).toContain('TIMEOUT_ADD_TO_MELD');
    expect(result.autoAction).toBe('DISCARD');
    expect(state.potCollectedByTeam).toContain(1);
  });

  it('Professional DIRECT never closes by discard, so the AI keeps 2 cards there too', async () => {
    // endMode DIRECT bars a closing discard outright, so leaving 1 card is a dead end even
    // with a Buraco on the board.
    const buraco = run456('m1', [
      card('HEARTS', '7', 'b7'), card('HEARTS', '8', 'b8'), card('HEARTS', '9', 'b9'), card('HEARTS', '10', 'b10'),
    ]);
    buraco.isCanasta = true;
    const state = gameState({
      endMode: 'DIRECT',
      melds: { [P1]: [buraco], [P2]: [] },
      hands: { [P1]: [card('HEARTS', 'J', 'hj'), card('SPADES', 'K', 'sk')], [P2]: [] },
      // Pot already taken, so there is nothing a last-card discard could win.
      potCollectedByTeam: [1],
    });
    const { service } = buildService(state);

    const result: any = await service.handleTurnTimeout(GAME_ID);

    expect(state.melds[P1][0].cards).toHaveLength(7);     // no add
    expect(result.autoAction).toBe('DISCARD');
    expect(state.hands[P1]).toHaveLength(1);
  });
});
