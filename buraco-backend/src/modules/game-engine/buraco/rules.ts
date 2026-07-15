import { Card, rankOrder } from './deck';

export type MeldType = 'SET' | 'RUN';

export interface Meld {
  id: string;
  teamId?: number;
  type: MeldType;
  cards: Card[];
  isNatural: boolean;
  isCanasta: boolean;
  /** Professional mode: once a meld is dirty it stays dirty even if wild later moves to a natural position. */
  everDirty?: boolean;
}

/**
 * Checks whether a 2 card, treated as a natural rank-2 card, fits in the run formed
 * by `runCards`.  A 2 is "natural" when rank-2 is a genuine member of the sequence
 * (i.e., the run contains a rank-3 card and, after treating the 2 as rank 2,
 * the whole range from min-rank down to 2 is consecutive with zero acting wilds).
 */
export function hasNaturalTwoInRun(cards: Card[]): boolean {
  const twos    = cards.filter(c => c.rank === '2');
  const jokers  = cards.filter(c => c.rank === 'JOKER');
  if (twos.length === 0 || jokers.length > 0) return false; // jokers in the run → can't co-exist with natural-2 classification

  const naturals = cards.filter(c => c.rank !== '2' && c.rank !== 'JOKER');
  if (naturals.length === 0) return false;

  // Try treating the first 2 as a rank-2 natural card
  const withNaturalTwo = [...naturals, twos[0]];
  const remainingWilds = twos.length - 1; // other 2s remain acting wilds
  if (remainingWilds > 1) return false; // can only have 1 acting wild total

  if (!isValidRun(withNaturalTwo, remainingWilds)) return false;

  // Confirm rank-3 is present: without rank-3, rank-2 wouldn't be a "natural" consecutive member
  const ranks = withNaturalTwo.map(c => (c.rank === 'A' ? 1 : rankOrder(c.rank)));
  return ranks.includes(3);
}

/**
 * Returns true if the meld contains any wild card that is acting as a substitute
 * (i.e. filling a gap or extending the run at a non-rank-2 position).
 * For SETs, any wild is always acting.
 * For RUNs, a 2 in its natural rank-2 position is NOT acting.
 */
export function computeMeldHasActingWild(cards: Card[], type: MeldType): boolean {
  if (type === 'SET') return cards.some(c => c.isWild);

  // RUN
  const jokers = cards.filter(c => c.rank === 'JOKER');
  const twos   = cards.filter(c => c.rank === '2');
  if (jokers.length > 0) return true; // any joker in a run is always acting
  if (twos.length === 0) return false;

  const naturalTwos = hasNaturalTwoInRun(cards) ? 1 : 0;
  return twos.length > naturalTwos;
}

// ── Public validation ─────────────────────────────────────────────────────────

/**
 * Validates a meld and returns its type.
 *
 * SET rules:  all naturals same rank, max 1 acting wild, at least 1 natural.
 *             Professional special: all-2 SET (Buraco of 2) is valid.
 * RUN rules:  all non-joker cards same suit, consecutive ranks.
 *             Classic:      any single wild (Joker or 2) may fill a gap.
 *             Professional: only a 2 may fill a gap; Jokers barred.
 *                           Two 2s allowed when one is natural (rank-2 position).
 */
export function validateMeld(
  cards: Card[],
  mode: string = 'CLASSIC',
): { valid: boolean; type?: MeldType; reason?: string } {
  if (cards.length < 3) return { valid: false, reason: 'A meld must have at least 3 cards' };

  // Professional special: all-2 meld (treated as natural rank-2 cards — Buraco of 2 path)
  if (mode === 'PROFESSIONAL' && cards.every(c => c.rank === '2')) {
    return { valid: true, type: 'SET' };
  }

  const naturals = cards.filter(c => !c.isWild);
  const wilds    = cards.filter(c => c.isWild);

  if (naturals.length === 0) {
    return { valid: false, reason: 'A meld must have at least one natural card' };
  }

  // ── SET ──────────────────────────────────────────────────────────────────
  if (wilds.length <= 1 && isValidSet(naturals)) {
    return { valid: true, type: 'SET' };
  }

  // ── RUN ──────────────────────────────────────────────────────────────────
  if (mode === 'PROFESSIONAL') {
    if (wilds.some(c => c.rank === 'JOKER')) {
      return { valid: false, reason: 'Jokers cannot fill runs in Professional mode' };
    }
    const twos = wilds.filter(c => c.rank === '2');
    // Allow at most 1 acting-wild-2 (but one 2 may be natural at rank-2 position)
    if (twos.length > 2) {
      return { valid: false, reason: 'A run can contain at most two 2s (one natural + one wild)' };
    }
    if (twos.length <= 1) {
      if (isValidRun(naturals, twos.length)) return { valid: true, type: 'RUN' };
    } else {
      // Two 2s: one must be natural (rank-2 slot) and one is the acting wild
      // Try: treat one 2 as natural card (add it to naturals, use 1 acting wild for the other)
      const withNatural = [...naturals, twos[0]]; // twos[0] as rank-2 natural
      if (isValidRun(withNatural, 1)) {
        const ranks = withNatural.map(c => (c.rank === 'A' ? 1 : rankOrder(c.rank)));
        if (ranks.includes(3)) return { valid: true, type: 'RUN' };
      }
      // Symmetry check with twos[1]
      const withNatural2 = [...naturals, twos[1]];
      if (isValidRun(withNatural2, 1)) {
        const ranks2 = withNatural2.map(c => (c.rank === 'A' ? 1 : rankOrder(c.rank)));
        if (ranks2.includes(3)) return { valid: true, type: 'RUN' };
      }
      return { valid: false, reason: 'Two 2s in a run require one to be in the natural rank-2 position' };
    }
  } else {
    // Classic: one acting wild allowed (Joker or 2).
    // Exception: one same-suit 2 is natural when the framework (non-wild cards) is
    // single-suit and contains a rank-3. That natural 2 does not consume the wild
    // slot, so one additional wild (Joker or 2 of any suit) is still allowed.
    if (wilds.length === 2) {
      const wildTwos = wilds.filter(c => c.rank === '2');
      const suits = new Set(naturals.map(c => c.suit));
      if (wildTwos.length >= 1 && suits.size === 1 && naturals.some(c => c.rank === '3')) {
        const frameworkSuit = [...suits][0] as string;
        for (const cand of wildTwos) {
          if (cand.suit !== frameworkSuit) continue;
          const withNatural = [...naturals, cand];
          if (isValidRun(withNatural, 1)) {
            const ranks = withNatural.map(c => (c.rank === 'A' ? 1 : rankOrder(c.rank)));
            if (ranks.includes(3)) return { valid: true, type: 'RUN' };
          }
        }
      }
    }
    if (wilds.length > 1) {
      return { valid: false, reason: 'A meld can contain at most one wild card' };
    }
    if (isValidRun(naturals, wilds.length)) return { valid: true, type: 'RUN' };
  }

  return { valid: false, reason: 'Cards do not form a valid set or run' };
}

// ── Internal validators ───────────────────────────────────────────────────────

function isValidSet(naturals: Card[]): boolean {
  const ranks = naturals.map(c => c.rank);
  return new Set(ranks).size === 1;
}

/**
 * Checks that the natural cards alone can form a consecutive same-suit run
 * when `wildCount` wilds are available to fill gaps.
 * Tries Ace as low (1) first, then as high (14).
 */
function isValidRun(naturals: Card[], wildCount: number): boolean {
  if (naturals.length === 0) return false;
  const suits = new Set(naturals.map(c => c.suit));
  if (suits.size > 1) return false;

  const ranks = naturals.map(c => rankOrder(c.rank));
  if (fitsWithWilds(ranks, wildCount)) return true;

  if (naturals.some(c => c.rank === 'A')) {
    const highRanks = ranks.map(r => (r === 1 ? 14 : r));
    if (fitsWithWilds(highRanks, wildCount)) return true;
  }
  return false;
}

function fitsWithWilds(ranks: number[], wildCount: number): boolean {
  const sorted = [...ranks].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) return false; // duplicate rank
  }
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    gaps += sorted[i] - sorted[i - 1] - 1;
  }
  return gaps <= wildCount;
}

// ── Card sort ─────────────────────────────────────────────────────────────────

/**
 * Returns meld cards in logical display order:
 *   SET  — naturals first (any order), wild(s) last.
 *   RUN  — high-to-low, with each wild placed at the gap it fills;
 *          if no internal gap, the wild extends the lower end.
 */
export function sortMeldCards(cards: Card[], type: MeldType): Card[] {
  return type === 'RUN' ? sortRunCards(cards) : sortSetCards(cards);
}

function sortSetCards(cards: Card[]): Card[] {
  return [...cards.filter(c => !c.isWild), ...cards.filter(c => c.isWild)];
}

function shouldAceBeHigh(naturals: Card[]): boolean {
  if (!naturals.some(c => c.rank === 'A')) return false;
  return naturals.some(c => c.rank !== 'A' && rankOrder(c.rank) >= 10);
}

function sortRunCards(cards: Card[]): Card[] {
  const jokers = cards.filter(c => c.rank === 'JOKER');
  const twos   = cards.filter(c => c.rank === '2');
  const others = cards.filter(c => c.rank !== '2' && c.rank !== 'JOKER');

  // Identify the natural 2 only when it actually occupies the rank-2 slot
  // (…4,3,2), not merely because a 3 is present — otherwise 3,2,5,6 sorts the
  // 2 as natural instead of placing it as the acting wild in the gap at 4.
  let naturalTwo: Card | null = null;
  const frameworkSuits = new Set(others.map(c => c.suit));
  if (frameworkSuits.size === 1 && others.some(c => c.rank === '3') && twos.length > 0) {
    const fs = [...frameworkSuits][0] as string;
    const candidate = twos.find(c => c.suit === fs) ?? null;
    if (candidate) {
      const withNatural = [...others, candidate];
      const otherActing = [...jokers, ...twos.filter(c => c !== candidate)];
      if (isValidRun(withNatural, 0) || (otherActing.length >= 1 && isValidRun(withNatural, 1))) {
        naturalTwo = candidate;
      }
    }
  }

  // Acting wilds = jokers + any 2 that is not the natural 2.
  const actingWilds = [...jokers, ...twos.filter(c => c !== naturalTwo)];
  const naturalCards = naturalTwo ? [...others, naturalTwo] : [...others];

  if (naturalCards.length === 0) return cards;

  const aceHigh = shouldAceBeHigh(naturalCards);
  const rank = (c: Card) => (aceHigh && c.rank === 'A' ? 14 : rankOrder(c.rank));

  const sorted = [...naturalCards].sort((a, b) => rank(b) - rank(a));

  if (actingWilds.length === 0) return sorted;

  // Place the acting wild: fill the first internal gap, or extend an end.
  // Validation guarantees at most 1 acting wild; extras are appended as a
  // safety net so no card is ever dropped.
  const [wild, ...extras] = actingWilds;

  for (let i = 0; i < sorted.length - 1; i++) {
    if (rank(sorted[i]) - rank(sorted[i + 1]) > 1) {
      return [...sorted.slice(0, i + 1), wild, ...sorted.slice(i + 1), ...extras];
    }
  }

  // No internal gap — extend an end.
  // If the low end is Ace (rank 1), extend the high end instead.
  const lowRank = rank(sorted[sorted.length - 1]);
  if (lowRank > 1) {
    return [...sorted, wild, ...extras];
  }
  return [wild, ...sorted, ...extras];
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if `newCards` can legally be added to `meld`.
 */
export function canAddToMeld(meld: Meld, newCards: Card[], mode: string = 'CLASSIC'): boolean {
  const combined = [...meld.cards, ...newCards];
  const result   = validateMeld(combined, mode);
  return result.valid && result.type === meld.type;
}

/**
 * Finds the first existing team meld that the played cards can be merged into.
 * Returns the meld if found, or null if a new meld should be created instead.
 */
export function tryFindMergeTarget(
  playedCards: Card[],
  meldType: MeldType,
  teamMelds: Meld[],
  mode: string,
): Meld | null {
  for (const existing of teamMelds) {
    if (existing.type !== meldType) continue;
    const combined = [...existing.cards, ...playedCards];
    const result   = validateMeld(combined, mode);
    if (result.valid && result.type === meldType) return existing;
  }
  return null;
}

export function canPickupDiscardPile(topCard: Card, hand: Card[]): boolean {
  const naturalsInHand = hand.filter(c => !c.isWild);
  for (const c1 of naturalsInHand) {
    for (const c2 of naturalsInHand) {
      if (c1.id === c2.id) continue;
      if (validateMeld([topCard, c1, c2]).valid) return true;
    }
  }
  return false;
}

export function canPickupPot(hand: Card[]): boolean {
  return hand.length === 0;
}

export function hasBuraco(melds: Meld[]): boolean {
  return melds.some(m => m.cards.length >= 7);
}

/** Professional only: a Buraco formed entirely of rank-2 cards triggers an immediate win. */
export function hasBuracoOfTwos(melds: Meld[]): boolean {
  return melds.some(m => m.cards.length >= 7 && m.cards.every(c => c.rank === '2'));
}

export function isCanasta(meld: Meld): boolean {
  return meld.cards.length >= 7;
}

export function isNaturalCanasta(meld: Meld): boolean {
  return isCanasta(meld) && meld.cards.every(c => !c.isWild);
}
