import { GameEngineService } from './game-engine.service';
import { generateDeck } from './buraco/deck';

// Rule: a Joker must never appear in the opening toss, in EITHER mode.
//
// The toss deck was built with generateDeck(true), so Classic's 4 jokers could be drawn —
// and tossRankValue ranks a Joker highest (15), so a seat could win the toss on a card the
// rules say is not part of it. Professional's DEAL deck already excluded jokers; this was
// only ever the toss path, which is shared by both modes.
const P = ['p-1', 'p-2', 'p-3', 'p-4'];
const SEATS = { 'p-1': 0, 'p-2': 1, 'p-3': 2, 'p-4': 3 };

function buildService() {
  const noop: any = {};
  const socket: any = { emitToRoom: jest.fn(), emitPerPlayer: jest.fn().mockResolvedValue(undefined) };
  return new GameEngineService(noop, noop, noop, noop, socket);
}

/** runToss is private; the toss has no public entry point of its own. */
function runToss(service: GameEngineService, playerIds = P, seats: Record<string, number> = SEATS) {
  return (service as any).runToss(playerIds, seats);
}

describe('opening toss — no Jokers', () => {
  it('never deals a Joker across many tosses, 4 players', () => {
    const service = buildService();
    // 1000 tosses x 4 seats is ~4000 draws. With the old joker-bearing deck (4 in 108) the
    // odds of seeing none are effectively zero, so a single clean run is conclusive.
    let cardsSeen = 0;
    for (let i = 0; i < 1000; i++) {
      const toss = runToss(service);
      for (const round of toss.rounds) {
        for (const entry of round.players) {
          cardsSeen++;
          expect(entry.card.rank).not.toBe('JOKER');
          expect(entry.card.suit).not.toBe('JOKER');
          expect(entry.card.isWild).toBe(entry.card.rank === '2');
          // Joker's toss value is 15; with none in the deck, Ace(14) is the ceiling.
          expect(entry.rankValue).toBeGreaterThanOrEqual(2);
          expect(entry.rankValue).toBeLessThanOrEqual(14);
        }
      }
    }
    expect(cardsSeen).toBeGreaterThanOrEqual(4000);
  });

  it('never deals a Joker in a 1v1 toss either', () => {
    const service = buildService();
    for (let i = 0; i < 1000; i++) {
      const toss = runToss(service, ['p-1', 'p-2'], { 'p-1': 0, 'p-2': 1 });
      for (const round of toss.rounds) {
        for (const entry of round.players) expect(entry.card.rank).not.toBe('JOKER');
      }
    }
  });

  it('still produces a decisive winner — ties re-toss until someone is high', () => {
    const service = buildService();
    for (let i = 0; i < 200; i++) {
      const toss = runToss(service);
      expect(toss.winnerPlayerId).toBeTruthy();
      expect(P).toContain(toss.winnerPlayerId);
      expect(toss.reason).toBe('HIGH_CARD');

      // Exactly one decisive round, and it is the last one.
      const decisive = toss.rounds.filter((r: any) => !r.isTie);
      expect(decisive).toHaveLength(1);
      expect(toss.rounds[toss.rounds.length - 1].isTie).toBe(false);

      // The winner really did hold the strictly highest card of that round.
      const final = toss.rounds[toss.rounds.length - 1];
      const top = Math.max(...final.players.map((e: any) => e.rankValue));
      const winner = final.players.find((e: any) => e.playerId === toss.winnerPlayerId);
      expect(winner.rankValue).toBe(top);
      expect(final.players.filter((e: any) => e.rankValue === top)).toHaveLength(1);
    }
  });

  it('the Classic PLAY deck still has its jokers — only the toss lost them', () => {
    // Guards against "fix the toss by removing jokers from the game".
    const classicPlayDeck = generateDeck(true);
    expect(classicPlayDeck).toHaveLength(108);
    expect(classicPlayDeck.filter(c => c.rank === 'JOKER')).toHaveLength(4);

    const tossDeck = generateDeck(false);
    expect(tossDeck).toHaveLength(104);
    expect(tossDeck.filter(c => c.rank === 'JOKER')).toHaveLength(0);
  });
});
