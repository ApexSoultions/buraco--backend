import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GameHost, GameMode, GameStatus, GameVariant, MoveType, Prisma, RoomStatus } from '@prisma/client';

// Once a player has already missed a turn this match (consecutiveMissedTurns >= 1), the
// AI takes their NEXT turn over after only this many seconds instead of waiting out the
// table's full turnDuration — see internalTurnTimeoutSeconds. Applies ONLY to the internal
// decision of when the server acts; the countdown shown to clients never uses this value
// (see effectiveTurnSeconds), so a 30s table still visibly reads 30, it just gets acted on
// early once someone is already mid-AFK-streak.
const AFK_REPEAT_MISS_TIMEOUT_SECONDS = 5;
// Forfeit a player after this many FULLY auto-played turns. Counted once per turn
// (see handleTurnTimeout) and accumulated per-player across the whole match — a new
// round/hand does NOT reset it; only a manual move by that player clears it.
const FORFEIT_AFTER_AUTO_TURNS = 12;
// A player counts as "away from their phone" once this many of their turns in a row have
// been auto-played. Used ONLY to decide the outcome when someone hits the 12-turn forfeit:
// if every opponent is also away the match is a DRAW rather than a win handed to a player
// who is equally absent. Half the forfeit threshold, so a player who genuinely stopped
// playing is recognised well before their own forfeit fires. A manual move zeroes
// forfeitMissedTurns (see processMove), so anyone actually playing is never "away".
const AWAY_AFTER_AUTO_TURNS = 6;
// Space auto-play sub-moves (draw / each meld / discard) ~one animation apart so the
// client animates them smoothly AND the socket heartbeat pong isn't buried behind a
// burst of messages (which the client mis-reads as a ~1500ms ping spike). Paced — NOT
// coalesced: collapsing a turn to only its final board made draws/melds snap into place.
const AUTOPLAY_MOVE_PACING_MS = 400;
// Cumulative team score at which the 75-rule switches on for that team's players: their
// FIRST meld of the round must be worth at least 75 points (+20 per failed attempt).
const SEVENTY_FIVE_RULE_MIN_SCORE = 1000;
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { EconomyService } from '../economy/economy.service';
import { StatsService } from '../stats/stats.service';
import { generateDeck, shuffle, Card, tossRankValue, rankOrder, cardValue } from './buraco/deck';
import {
  validateMeld,
  canAddToMeld,
  canPickupDiscardPile,
  canPickupPot,
  hasBuraco,
  hasBuracoOfTwos,
  tryFindMergeTarget,
  sortMeldCards,
  computeMeldHasActingWild,
  Meld,
} from './buraco/rules';
import { calculateScore, calculateMatchReward, calculateScoreBreakdown } from './buraco/scoring';
import { SocketService } from '../../common/socket/socket.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MATCH_END_REASONS, ReportMatchResultDto } from './dto/report-match-result.dto';

export type TurnPhase = 'MUST_DRAW' | 'CAN_MELD_OR_DISCARD' | 'ROUND_ENDED';

export interface SeventyFiveRuleState {
  /** True when this player's team cumulative score was >= 1000 at round start. */
  active: boolean;
  /** Current minimum point total required for this round's opening meld; starts at 75, +20 per cancelled/unmet attempt. */
  requirement: number;
  /** True once this player's cumulative meld points this turn reached `requirement` (or if the rule is inactive). Stays true for the rest of the round. */
  satisfied: boolean;
  /**
   * Card ids currently on the table from THIS TURN's meld/add-to-meld plays, while the rule
   * is active and not yet satisfied — below-threshold melds are accepted and left in place
   * rather than rejected, so the player can build up to `requirement` across several plays.
   * Reclaimable via `game:move:cancel_melds`, or auto-returned (with the usual +20 bump) if
   * the turn ends without reaching `requirement`. Always empty once satisfied or cancelled.
   */
  pendingCardIds: string[];
}

/**
 * What a 75-rule rollback actually did — emitted verbatim inside `lastMove` on both the
 * manual `CANCEL_MELDS` and the `DISCARD` that auto-cancels, and to EVERY viewer, not just
 * the actor. The client animates exactly `returnedCardIds` from that seat's meld area back
 * to its hand; without the ids it had to diff meld rows that were already gone, so the
 * cards just vanished on the opponent's phone. Before/after pairs let a client show the
 * penalty as a transition (75 → 95) and detect a payload it has already applied.
 */
export interface SeventyFiveRollback {
  playerId: string;
  returnedCardIds: string[];
  seventyFiveRequiredBefore: number;
  seventyFiveRequiredAfter: number;
  seventyFiveTurnPointsBefore: number;
  seventyFiveTurnPointsAfter: number;
}

export interface TossEntry {
  playerId: string;
  seatIndex: number;
  card: Card;
  rankValue: number;
}

export interface TossRound {
  round: number;
  isTie: boolean;
  players: TossEntry[];
  winnerPlayerId?: string;
  winnerSeatIndex?: number;
  reason?: string;
}

export interface TossResult {
  rounds: TossRound[];
  winnerPlayerId: string;
  winnerSeatIndex: number;
  players: TossEntry[];
  reason: string;
}

export interface GameState {
  gameId: string;
  /**
   * Who owns this match. Always 'SERVER' for anything this engine deals — the backend runs
   * the turns, timers and AI for it. A state written before this field existed was also
   * written by this engine, so a MISSING value is read as 'SERVER' everywhere (see
   * isServerHosted); only an explicit 'FUSION' is excluded from the cron.
   */
  hostedBy?: GameHost;
  mode: GameMode;
  variant: GameVariant;
  /** Professional Direct = hand empties on-the-fly to close; Indirect = must discard last card. */
  endMode: 'DIRECT' | 'INDIRECT';
  /** Professional MAKART: player with 1 card in hand cannot take discard when pile also has 1 card. */
  makart: boolean;
  status: GameStatus;
  stockPile: Card[];
  discardPile: Card[];
  potPiles: Card[][];
  hands: Record<string, Card[]>;
  melds: Record<string, Meld[]>;
  teamMelds: Record<number, Meld[]>;
  players: Array<{ userId: string; teamId: number; isConnected: boolean }>;
  turnOrder: string[];
  currentTurnIndex: number;
  turnPhase: TurnPhase;
  gameStartedAt: number;
  turnStartedAt: number;
  turnDuration: number;
  round: number;
  scores: Record<number, number>;
  moveCount: number;
  /**
   * Array of team IDs that have collected a pot; duplicates allowed (team appearing twice = took 2 pots).
   * Classic: max 1 per team. Professional: max 2 per team.
   */
  potCollectedByTeam: number[];
  seatMap: Record<string, number>;
  usernames: Record<string, string>;
  toss: TossResult | null;
  setupComplete: boolean;
  tossComplete: boolean;
  /**
   * User ids that have already been sent the opening toss + deal for this match.
   * A player in this list is RESUMING, so game:join replays the current board via
   * game:state_sync instead of re-running the deal animation. Without it the only
   * signal was `moveCount > 0`, so a reconnect during the very first turn re-dealt.
   */
  dealtTo?: string[];
  targetScore: number;
  matchScores: Record<number, number>;
  winnerTeam?: number;
  /**
   * Cadence counter — consecutive auto-played turns per player, shown to clients as
   * `missedTurns`. Resets to 0 ONLY on a manual move by that player (see processMove) —
   * NOT on a bare reconnect or a round transition, so a player who reconnects and then
   * goes AFK again resumes counting from where they left off instead of starting over.
   * Kept as a separate field from forfeitMissedTurns for the client's benefit (a
   * "this-streak" number vs. a "whole match" tally); the two currently move in lockstep.
   */
  consecutiveMissedTurns?: Record<string, number>;
  /**
   * Forfeit counter — consecutive auto-played turns per player, shown to clients as
   * `awayTurns`. Resets to 0 ONLY on a manual move (not bare reconnect).
   * Reaches 12 → forfeit, same semantics as the original single counter.
   */
  forfeitMissedTurns?: Record<string, number>;
  /** Per-player 75-rule state for the current round. */
  seventyFiveRule?: Record<string, SeventyFiveRuleState>;
  /**
   * Per-player score breakdown for the most recently completed round, persisted so that
   * any client resyncing via getGameState/buildClientView (e.g. after a reconnect that
   * missed the one-shot 'game:new_round' event) still receives the correct round score.
   */
  lastRoundScores?: Array<{
    playerId: string;
    playerName: string;
    teamId: number;
    roundScore: number;
    matchScore: number;
    // Flat breakdown fields (the client scoreboard reads these directly). Kept
    // alongside the nested `breakdown` for any existing consumer.
    boardScore: number;
    cleanBuraco: number;
    semiCleanBuraco: number;
    dirtyBuraco: number;
    potNotTaken: number;
    paidCards: number;
    finishBonus: number;
    breakdown: ReturnType<typeof calculateScoreBreakdown>;
  }>;
}

/** One player's authoritative round-score breakdown row — same shape as `GameState.lastRoundScores` elements. */
type PlayerRoundScoreRow = NonNullable<GameState['lastRoundScores']>[number];

/** WIN / LOSS, or DRAW when the match ended with every player away from their phone. */
type MatchOutcome = 'WIN' | 'LOSS' | 'DRAW';

/** Public `game:end` per-player row — `userId`-keyed (vs. `PlayerRoundScoreRow`'s internal `playerId`) to match the socket payload the client reads. */
type GameEndPlayerRow = {
  userId: string;
  playerName: string;
  teamId: number;
  result: MatchOutcome;
  score: number;
  roundScore: number;
  boardScore: number;
  cleanBuraco: number;
  semiCleanBuraco: number;
  dirtyBuraco: number;
  potNotTaken: number;
  paidCards: number;
  finishBonus: number;
};

@Injectable()
export class GameEngineService implements OnModuleInit {
  private readonly logger = new Logger(GameEngineService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private economyService: EconomyService,
    private statsService: StatsService,
    private socketService: SocketService,
  ) {}

  /**
   * Rebuild the active-game index once at boot.
   *
   * The index (see activeGamesKey) is what the 5s cron iterates, so it must survive a
   * deploy or crash: an in-flight match whose id is missing from it would silently stop
   * being auto-played. This is the ONE place a full `keys()` scan is acceptable — it runs
   * a single time at startup rather than every 5 seconds.
   *
   * States written before `hostedBy` existed were written by THIS engine, so a missing
   * marker is read as SERVER — otherwise every match live at deploy time would be dropped.
   */
  async onModuleInit() {
    try {
      const keys = await this.redis.keys('game:*:state');
      const live: string[] = [];
      for (const key of keys) {
        const state = await this.redis.getJson<GameState>(key);
        if (!state || state.status !== GameStatus.IN_PROGRESS) continue;
        if (!this.isServerHosted(state)) continue;
        live.push(state.gameId);
      }
      if (live.length > 0) await this.redis.sadd(this.activeGamesKey(), ...live);
      this.logger.log(`Active-game index rebuilt: ${live.length} server-hosted match(es) resumed`);
    } catch (err) {
      this.logger.error('Failed to rebuild the active-game index', err);
    }
  }

  /** Redis SET of game ids the backend is actively hosting. Drives the turn-timeout cron. */
  private activeGamesKey() {
    return 'games:active:server';
  }

  /**
   * True when this backend owns the match. A state with no `hostedBy` predates the field and
   * was written by this engine, so it counts as SERVER; only an explicit FUSION is excluded.
   */
  private isServerHosted(state: GameState): boolean {
    return (state.hostedBy ?? GameHost.SERVER) === GameHost.SERVER;
  }

  /**
   * Drives every server-hosted match forward, whether or not anyone is connected. This is
   * what makes the backend — not a player's phone — the match host: two players can close
   * their apps and the turns, timers and AI keep running here until the match ends or
   * somebody comes back.
   *
   * Iterates the active-game index rather than `keys('game:*:state')`: that was an O(N)
   * blocking scan of the entire Redis keyspace every 5 seconds, and it could not tell a
   * server-hosted match from a legacy Fusion one.
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async checkTurnTimeouts() {
    try {
      const gameIds = await this.redis.smembers(this.activeGamesKey());
      await Promise.all(
        gameIds.map(async (gameId) => {
          const state = await this.redis.getJson<GameState>(this.stateKey(gameId));

          // Self-heal: drop ids whose state is gone or finished so the index cannot grow
          // unbounded and the cron never works a match that is already over.
          if (!state || state.status !== GameStatus.IN_PROGRESS) {
            await this.redis.srem(this.activeGamesKey(), gameId);
            return;
          }
          // Legacy player-hosted match — the backend must never move it.
          if (!this.isServerHosted(state)) {
            await this.redis.srem(this.activeGamesKey(), gameId);
            return;
          }
          if (state.turnPhase === 'ROUND_ENDED') return;

          const currentPlayerId = state.turnOrder[state.currentTurnIndex];
          const effectiveTimeout = this.internalTurnTimeoutSeconds(state, currentPlayerId);
          if (Date.now() - state.turnStartedAt > effectiveTimeout * 1000) {
            // Idempotency lock. This cron runs EVERY_5_SECONDS over ALL games via
            // Promise.all, and @Cron does not prevent a slow run from overlapping the
            // next tick. Without this, two overlapping ticks could auto-play the SAME
            // expired turn and each bump the miss counters (~2-3x per turn) — which is
            // why the 12-turn forfeit was firing after only ~5 turns. Serialize
            // auto-play to one run per game; the 15s TTL is a crash backstop.
            const autoplayLock = `game:${state.gameId}:autoplay`;
            if (await this.redis.setNx(autoplayLock, '1', 15)) {
              try {
                await this.handleTurnTimeout(state.gameId);
              } finally {
                await this.redis.del(autoplayLock);
              }
            }
          }
        }),
      );
    } catch (err) {
      this.logger.error('checkTurnTimeouts error', err);
    }
  }

  stateKey(gameId: string) {
    return `game:${gameId}:state`;
  }

  async startGame(
    roomId: string,
    mode: GameMode,
    variant: GameVariant,
    playerIds: string[],
    endMode?: string | null,
    makart?: boolean,
    turnDuration?: number,
    targetScore?: number,
  ): Promise<GameState> {
    const game = await this.prisma.gameSession.create({
      data: {
        roomId,
        mode,
        variant,
        status: GameStatus.IN_PROGRESS,
        // This backend is the authoritative host for every match it deals. Only SERVER
        // rows are driven by the turn-timeout cron.
        hostedBy: GameHost.SERVER,
        startedAt: new Date(),
        winnerIds: [],
        players: {
          create: playerIds.map((userId, idx) => ({
            userId,
            teamId: variant === GameVariant.ONE_VS_ONE ? idx + 1 : idx % 2 === 0 ? 1 : 2,
          })),
        },
      },
      include: { players: true },
    });

    const dbPlayers = game.players;
    const dbUserIds = dbPlayers.map(p => p.userId);

    const users = await this.prisma.user.findMany({
      where: { id: { in: dbUserIds } },
      select: { id: true, username: true },
    });
    const usernames: Record<string, string> = {};
    for (const u of users) usernames[u.id] = u.username;

    const seatMap: Record<string, number> = {};
    dbPlayers.forEach((p, i) => { seatMap[p.userId] = i; });

    const tossResult = this.runToss(dbUserIds, seatMap);

    const deck = shuffle(generateDeck(mode !== GameMode.PROFESSIONAL));
    const hands: Record<string, Card[]> = {};
    const potPiles: Card[][] = [[], []];

    let deckIdx = 0;
    for (const player of dbPlayers) {
      hands[player.userId] = deck.slice(deckIdx, deckIdx + 11);
      deckIdx += 11;
    }
    potPiles[0] = deck.slice(deckIdx, deckIdx + 11); deckIdx += 11;
    potPiles[1] = deck.slice(deckIdx, deckIdx + 11); deckIdx += 11;

    const stockPile = deck.slice(deckIdx);
    const topCard = stockPile.pop();
    const discardPile: Card[] = topCard ? [topCard] : [];

    const winnerSeat = seatMap[tossResult.winnerPlayerId] ?? 0;
    const turnOrder = [...dbUserIds.slice(winnerSeat), ...dbUserIds.slice(0, winnerSeat)];
    const players = dbPlayers.map(p => ({ userId: p.userId, teamId: p.teamId, isConnected: true }));
    const now = Date.now();

    const resolvedEndMode: 'DIRECT' | 'INDIRECT' =
      (endMode === 'DIRECT' ? 'DIRECT' : 'INDIRECT');

    const state: GameState = {
      gameId: game.id,
      hostedBy: GameHost.SERVER,
      mode,
      variant,
      endMode: resolvedEndMode,
      makart: !!makart,
      status: GameStatus.IN_PROGRESS,
      stockPile,
      discardPile,
      potPiles,
      hands,
      melds: Object.fromEntries(dbUserIds.map(id => [id, []])),
      teamMelds: { 1: [], 2: [] },
      players,
      turnOrder,
      currentTurnIndex: 0,
      turnPhase: 'MUST_DRAW',
      gameStartedAt: now,
      turnStartedAt: now,
      turnDuration: turnDuration ?? 30,
      round: 1,
      scores: { 1: 0, 2: 0 },
      targetScore: targetScore ?? 0,
      matchScores: { 1: 0, 2: 0 },
      moveCount: 0,
      potCollectedByTeam: [],
      seatMap,
      usernames,
      toss: tossResult,
      setupComplete: true,
      tossComplete: true,
      dealtTo: [],
      consecutiveMissedTurns: {},
      forfeitMissedTurns: {},
      // Round 1: all matchScores are 0 → 75-rule inactive for everyone
      seventyFiveRule: Object.fromEntries(players.map(p => [
        p.userId,
        { active: false, requirement: 75, satisfied: true, pendingCardIds: [] },
      ])),
    };

    await this.redis.setJson(this.stateKey(game.id), state, 86400);
    // Hand the match to the cron. From here the backend drives it — turns, timers and AI
    // keep running even if every player closes their app.
    await this.redis.sadd(this.activeGamesKey(), game.id);
    return state;
  }

  /**
   * Records that `userId` has been sent the opening toss + deal, so a later game:join from
   * the same player resumes via game:state_sync instead of dealing again.
   * Returns true when this is the player's FIRST join (i.e. they should get the deal).
   */
  async claimInitialDeal(gameId: string, userId: string): Promise<boolean> {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state) return false;
    const dealtTo = state.dealtTo ?? [];
    if (dealtTo.includes(userId)) return false;
    state.dealtTo = [...dealtTo, userId];
    await this.redis.setJson(this.stateKey(gameId), state, 86400);
    return true;
  }

  async getGameState(gameId: string, requestingUserId: string) {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (state) return this.buildClientView(state, requestingUserId);

    // No live state: either the Redis copy aged out or this is a Fusion match whose
    // in-memory state was never the source of truth. If the DB says the match is over,
    // answer with a terminal view instead of a 404 — a client returning from a long
    // absence must be able to learn "this match is finished" from /state as well as
    // /result, otherwise it keeps retrying a game that no longer exists.
    const terminal = await this.buildTerminalStateFromDb(gameId);
    if (terminal) return terminal;

    throw new NotFoundException('Game state not found');
  }

  /**
   * Minimal COMPLETED client view rebuilt from the DB for a match with no live Redis
   * state. Shaped like buildClientView (every field present, empty board) so a client
   * parsing it never trips over missing members; `status` + `winnerTeamId` are the
   * fields that actually matter here. Returns null while the match is still live.
   */
  private async buildTerminalStateFromDb(gameId: string) {
    const game = await this.prisma.gameSession.findUnique({
      where: { id: gameId },
      select: {
        id: true, mode: true, variant: true, status: true, winnerTeam: true,
        players: {
          select: { userId: true, teamId: true, finalScore: true, user: { select: { username: true } } },
        },
        resultReport: { select: { winnerTeam: true, payload: true } },
      },
    });
    if (!game) return null;
    if (game.status === GameStatus.WAITING || game.status === GameStatus.IN_PROGRESS) return null;

    const winnerTeam = game.resultReport?.winnerTeam ?? game.winnerTeam ?? null;

    return {
      gameId:               game.id,
      mode:                 game.mode,
      variant:              game.variant,
      endMode:              'INDIRECT',
      makart:               false,
      status:               GameStatus.COMPLETED,
      currentPlayerId:      '',
      turnPhase:            'ROUND_ENDED' as TurnPhase,
      stockPileCount:       0,
      discardPile:          [] as Card[],
      topDiscardCard:       null,
      discardPileCount:     0,
      potPileCounts:        [] as number[],
      players: game.players.map((p, i) => ({
        id:          p.userId,
        userId:      p.userId,
        username:    p.user?.username ?? '',
        teamId:      p.teamId,
        isConnected: false,
        seatIndex:   i,
        handCount:   0,
        score:       p.finalScore ?? 0,
        missedTurns: 0,
        awayTurns:   0,
        isAway:      false,
        melds:       [] as Meld[],
        seventyFiveActive:     false,
        seventyFiveSatisfied:  true,
        seventyFiveRequired:   75,
        seventyFiveTurnPoints: 0,
      })),
      myHand:               [] as Card[],
      myMelds:              [] as Meld[],
      teamMelds:            {} as Record<number, Meld[]>,
      turnOrder:            game.players.map(p => p.userId),
      currentTurnIndex:     0,
      turnStartedAt:        0,
      turnDuration:         0,
      turnDurationBase:     0,
      turnFastAutoplay:     false,
      turnEndsAt:           0,
      round:                0,
      scores:               {} as Record<number, number>,
      moveCount:            0,
      potCollectedByTeam:   [] as number[],
      setupComplete:        true,
      tossComplete:         true,
      toss:                 null,
      targetScore:          0,
      matchScores:          Object.fromEntries(game.players.map(p => [p.teamId, p.finalScore ?? 0])),
      winnerTeam,
      winnerTeamId:         winnerTeam != null ? String(winnerTeam) : null,
      lastRoundScores:      [] as NonNullable<GameState['lastRoundScores']>,
      seventyFiveActive:    false,
      seventyFiveSatisfied: true,
      seventyFiveRequired:  75,
      seventyFiveTurnPoints: 0,
      awayAfterTurns:       AWAY_AFTER_AUTO_TURNS,
      forfeitAfterTurns:    FORFEIT_AFTER_AUTO_TURNS,
      turnTimeRemaining:    0,
    };
  }

  /**
   * Seconds the CURRENT turn is shown counting down from — always `state.turnDuration`,
   * the table's own configured turn length, no matter what has happened on prior turns.
   * Feeds ONLY the client-facing view (turnDuration/turnDurationBase/turnFastAutoplay/
   * turnEndsAt/turnTimeRemaining in buildClientView) — a 30s table always visibly reads 30.
   * The server's own decision of when it actually acts is a separate number, see
   * internalTurnTimeoutSeconds; the two used to be the same value, which made the visible
   * countdown itself snap to 5s whenever a player was mid-AFK-streak.
   */
  private effectiveTurnSeconds(state: GameState, _playerId: string): number {
    return state.turnDuration;
  }

  /**
   * Seconds the CURRENT turn actually lasts before the server auto-plays it. This is the
   * real deadline the timeout cron and a reconnect check act on — deliberately separate
   * from effectiveTurnSeconds, which only feeds what the client sees.
   *
   * A player's first miss of the match still gets the table's full turnDuration. From their
   * second consecutive miss onward (consecutiveMissedTurns[playerId] >= 1 — already reset to
   * 0 by any manual move, see processMove, and deliberately left untouched by a bare
   * reconnect, see markPlayerReconnected) the server acts after only
   * AFK_REPEAT_MISS_TIMEOUT_SECONDS, e.g. a 30s table counts down to 25 and the AI already
   * has taken the turn. The visible countdown is untouched either way.
   */
  private internalTurnTimeoutSeconds(state: GameState, playerId: string): number {
    const priorMisses = state.consecutiveMissedTurns?.[playerId] ?? 0;
    return priorMisses >= 1 ? AFK_REPEAT_MISS_TIMEOUT_SECONDS : state.turnDuration;
  }

  /**
   * One player's authoritative 75-rule block, in the shape the client renders a
   * "YOUR 75-RULE 40/75" / "OPP 75-RULE 0/95" label from.
   *
   * Emitted for EVERY player (see buildClientView), not just the viewer: a phone cannot
   * label the opponent's 75-rule state from viewer-scoped fields, which is why the opponent
   * seat stayed on "0/75" (or showed nothing at all) after the actor's requirement moved.
   */
  private seventyFiveViewFor(state: GameState, playerId: string) {
    const rule = state.seventyFiveRule?.[playerId];
    return {
      seventyFiveActive:     rule?.active ?? false,
      seventyFiveSatisfied:  rule?.satisfied ?? true,
      seventyFiveRequired:   rule?.requirement ?? 75,
      seventyFiveTurnPoints: this.seventyFiveTurnPoints(state, playerId),
    };
  }

  /**
   * Public so the gateway can fan a single Redis read out to every socket in a game room
   * (see AppGateway.broadcastGameState) instead of re-reading the state once per player.
   */
  buildClientView(state: GameState, requestingUserId: string) {
    const currentPlayerId = state.turnOrder[state.currentTurnIndex] ?? '';
    const topDiscardCard  = state.discardPile.length > 0
      ? state.discardPile[state.discardPile.length - 1]
      : null;

    const sortedPlayers = [...state.players].sort(
      (a, b) => (state.seatMap?.[a.userId] ?? 0) - (state.seatMap?.[b.userId] ?? 0),
    );

    const teamMelds: Record<number, Meld[]> = {};
    for (const p of state.players) {
      if (!teamMelds[p.teamId]) teamMelds[p.teamId] = [];
      for (const m of state.melds[p.userId] || []) {
        teamMelds[p.teamId].push({ ...m, teamId: p.teamId });
      }
    }

    const requestingTeamId = state.players.find(p => p.userId === requestingUserId)?.teamId;

    const players = sortedPlayers.map(p => ({
      id:          p.userId,
      userId:      p.userId,
      username:    state.usernames?.[p.userId] ?? '',
      teamId:      p.teamId,
      isConnected: p.isConnected,
      seatIndex:   state.seatMap?.[p.userId] ?? 0,
      handCount:   (state.hands[p.userId] || []).length,
      score:       (state.matchScores ?? {})[p.teamId] ?? 0,
      // ── Away-from-phone counters ────────────────────────────────────────────
      // Live on the server (the AI plays these turns), so a reconnecting client can show
      // "opponent has missed N turns / forfeits in M" without tracking any of it locally.
      // Both are whole-match tallies now, cleared ONLY by a manual move (see processMove) —
      // neither is reset by a bare reconnect or a new round, so a player who keeps
      // disconnecting and reconnecting without ever actually playing keeps climbing toward
      // the 12-turn forfeit instead of getting a free reset each time they pop back in.
      missedTurns: (state.consecutiveMissedTurns ?? {})[p.userId] ?? 0,
      awayTurns:   (state.forfeitMissedTurns ?? {})[p.userId] ?? 0,
      isAway:      this.isPlayerAway(state, p.userId),
      // This seat's melds, always derived from the live `state.melds` on THIS call — so a
      // rollback (cancel / auto-cancel) can never leave a returned card visible here on the
      // opponent's phone while the actor's own payload has already dropped it.
      melds:       (state.melds[p.userId] || []).map(m => ({ ...m, teamId: p.teamId })),
      // Authoritative per-seat 75-rule state — both phones label both seats from this.
      ...this.seventyFiveViewFor(state, p.userId),
    }));

    // Effective window for the turn in progress — always the table's own configured turn
    // length (see effectiveTurnSeconds), whether or not the current player is absent.
    const effectiveTurnDuration = this.effectiveTurnSeconds(state, currentPlayerId);

    return {
      gameId:               state.gameId,
      mode:                 state.mode,
      variant:              state.variant,
      endMode:              state.endMode ?? 'INDIRECT',
      makart:               state.makart ?? false,
      status:               state.status,
      currentPlayerId,
      turnPhase:            state.turnPhase ?? 'MUST_DRAW',
      stockPileCount:       state.stockPile.length,
      discardPile:          state.discardPile,
      topDiscardCard,
      discardPileCount:     state.discardPile.length,
      potPileCounts:        state.potPiles.map(p => p.length),
      players,
      myHand:               state.hands[requestingUserId] || [],
      myMelds:              requestingTeamId !== undefined ? (teamMelds[requestingTeamId] || []) : [],
      teamMelds,
      turnOrder:            state.turnOrder,
      currentTurnIndex:     state.currentTurnIndex,
      turnStartedAt:        state.turnStartedAt,
      // The window the SERVER will actually act on — always the table's own configured
      // turn length now (see effectiveTurnSeconds); an absent player no longer shortens it.
      turnDuration:         effectiveTurnDuration,
      // Same value as turnDuration today. Kept as a separate field (rather than removed)
      // for client compatibility — anything reading "the table's rule rather than this
      // turn's countdown" can keep using this name.
      turnDurationBase:     state.turnDuration,
      // Always false now that an absent player's turn is timed at the table's own length
      // rather than a shortened one. Kept for client compatibility.
      turnFastAutoplay:     effectiveTurnDuration !== state.turnDuration,
      // Absolute deadline, so a client can drive its countdown without accumulating drift.
      turnEndsAt:           state.turnStartedAt + effectiveTurnDuration * 1000,
      round:                state.round,
      scores:               state.scores,
      moveCount:            state.moveCount,
      potCollectedByTeam:   state.potCollectedByTeam ?? [],
      setupComplete:        state.setupComplete ?? true,
      tossComplete:         state.tossComplete ?? true,
      toss:                 state.toss ?? null,
      targetScore:          state.targetScore ?? 0,
      matchScores:          state.matchScores ?? { 1: 0, 2: 0 },
      winnerTeam:           state.winnerTeam ?? null,
      // String twin of winnerTeam. Clients that resolve a finished match through the
      // /state fallback (rather than /result) read this field by name.
      winnerTeamId:         state.winnerTeam != null ? String(state.winnerTeam) : null,
      lastRoundScores:      state.lastRoundScores ?? [],
      // Requesting player's own 75-rule progress — e.g. "40/75" — active/required/satisfied
      // plus the running total of this turn's not-yet-satisfied meld plays. Kept as root
      // fields for existing clients; the same values are also in players[] for EVERY seat,
      // which is what an opponent label has to be built from.
      ...this.seventyFiveViewFor(state, requestingUserId),
      // Thresholds the counters above are measured against, so the client can render
      // "3 / 12" without hardcoding server rules.
      awayAfterTurns:       AWAY_AFTER_AUTO_TURNS,
      forfeitAfterTurns:    FORFEIT_AFTER_AUTO_TURNS,
      turnTimeRemaining: Math.max(
        0,
        effectiveTurnDuration - Math.floor((Date.now() - state.turnStartedAt) / 1000),
      ),
    };
  }

  async processMove(
    gameId: string,
    playerId: string,
    move: { type: MoveType; cardIds?: string[]; meldId?: string; source?: 'STOCK' | 'DISCARD' },
  ) {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state) throw new NotFoundException('Game not found');
    if (state.status !== GameStatus.IN_PROGRESS) throw new BadRequestException('GAME_NOT_IN_PROGRESS');

    const currentPlayer = state.turnOrder[state.currentTurnIndex];
    if (currentPlayer !== playerId) throw new BadRequestException('NOT_YOUR_TURN');

    // Any successful manual move resets both the cadence counter and the forfeit counter.
    if (!state.consecutiveMissedTurns) state.consecutiveMissedTurns = {};
    if (!state.forfeitMissedTurns) state.forfeitMissedTurns = {};
    // TEMP DIAGNOSTIC (awayTurns-reset investigation): only an actual manual move should
    // ever clear a nonzero streak — logging every occurrence lets us confirm from server
    // logs that a reported reset really did come through here, on this move, and not from
    // some other write racing the same Redis key. Remove once the investigation is closed.
    const priorForfeit = state.forfeitMissedTurns[playerId] ?? 0;
    const priorConsecutive = state.consecutiveMissedTurns[playerId] ?? 0;
    if (priorForfeit > 0 || priorConsecutive > 0) {
      this.logger.warn(
        `[afk-counter] processMove(${move.type}) by ${playerId} in game ${gameId} cleared an ` +
        `active AFK streak: forfeitMissedTurns ${priorForfeit}->0, consecutiveMissedTurns ${priorConsecutive}->0`,
      );
    }
    state.consecutiveMissedTurns[playerId] = 0;
    state.forfeitMissedTurns[playerId] = 0;

    const turnPhase: TurnPhase = state.turnPhase ?? 'MUST_DRAW';
    const hand = state.hands[playerId];
    const playerTeamId = state.players.find(p => p.userId === playerId)?.teamId ?? 1;
    const teamPlayerIds = state.players.filter(p => p.teamId === playerTeamId).map(p => p.userId);
    let result: any = {};
    /** Set by the DISCARD case when that discard also auto-cancelled a short 75-rule attempt. */
    let autoCancelRollback: SeventyFiveRollback | null = null;

    switch (move.type) {

      // ────────────────────────────────────────────────────────────────────────
      case MoveType.DRAW_STOCK: {
        if (turnPhase !== 'MUST_DRAW') throw new BadRequestException('WRONG_PHASE');
        if (state.stockPile.length === 0) {
          if (state.discardPile.length <= 1) throw new BadRequestException('EMPTY_STOCK');
          const top = state.discardPile.pop()!;
          state.stockPile = shuffle(state.discardPile);
          state.discardPile = [top];
        }
        const card = state.stockPile.pop()!;
        hand.push(card);
        state.turnPhase = 'CAN_MELD_OR_DISCARD';
        result = { card, handCount: hand.length, stockPileCount: state.stockPile.length };

        if (state.mode === GameMode.CLASSIC) {
          // Classic: end the round when ≤ 2 cards remain (no pot refill)
          if (state.stockPile.length <= 2) {
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            return this.finalizeGame(gameId, state);
          }
        } else {
          // Professional: when stock empties, pour untaken pots (A then B) into the stock
          // and continue. End only when stock AND all remaining pots are exhausted.
          if (state.stockPile.length === 0) {
            const potIdx = state.potPiles.findIndex(p => p.length > 0);
            if (potIdx !== -1) {
              state.stockPile = shuffle(state.potPiles[potIdx]);
              state.potPiles[potIdx] = [];
              result.stockPileCount = state.stockPile.length;
              result.potRefilled = true;
            } else {
              // Stock empty, no pots left — end the round
              await this.redis.setJson(this.stateKey(gameId), state, 86400);
              return this.finalizeGame(gameId, state);
            }
          }
        }
        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      case MoveType.DRAW_DISCARD: {
        if (turnPhase !== 'MUST_DRAW') throw new BadRequestException('WRONG_PHASE');
        if (state.discardPile.length === 0) throw new BadRequestException('EMPTY_DISCARD');

        // MAKART option (Professional): player with 1 card cannot take discard when pile has 1 card
        if (state.makart && hand.length === 1 && state.discardPile.length === 1) {
          throw new BadRequestException('MAKART: must draw from stock when both hand and discard have 1 card');
        }

        const takenCards = [...state.discardPile];
        hand.push(...takenCards);
        state.discardPile = [];
        state.turnPhase = 'CAN_MELD_OR_DISCARD';
        result = { takenCount: takenCards.length, takenCardIds: takenCards.map(c => c.id), handCount: hand.length };
        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      case MoveType.PLAY_MELD: {
        if (turnPhase !== 'CAN_MELD_OR_DISCARD') throw new BadRequestException('WRONG_PHASE');
        const cards = this.resolveCards(hand, move.cardIds || []);
        const validation = validateMeld(cards, state.mode as string);
        if (!validation.valid) throw new BadRequestException(validation.reason || 'INVALID_MELD');
        const meldType = validation.type!;

        // ── 75-rule: accept the meld regardless of value; accumulate toward this turn's
        // opening requirement instead of rejecting a below-threshold attempt outright. The
        // cards stay on the table (reclaimable via game:move:cancel_melds, or auto-returned
        // with the usual +20 bump if the turn ends without reaching `requirement`) until the
        // running total across this turn's plays meets it, at which point it's locked in.
        {
          const rule = state.seventyFiveRule?.[playerId];
          if (rule?.active && !rule.satisfied) {
            const isPro   = state.mode === GameMode.PROFESSIONAL;
            const priorPts = this.seventyFiveTurnPoints(state, playerId);
            const newPts   = cards.reduce((s, c) => s + cardValue(c, isPro), 0);
            if (!rule.pendingCardIds) rule.pendingCardIds = [];
            rule.pendingCardIds.push(...cards.map(c => c.id));
            if (priorPts + newPts >= rule.requirement) {
              rule.satisfied = true;
              rule.pendingCardIds = [];
            }
          }
        }

        // ── Lookahead: find merge target early (needed for Buraco-exception guard) ─
        const handAfterMeld = hand.filter(c => !cards.some(mc => mc.id === c.id));
        const allTeamMelds = teamPlayerIds.flatMap(uid => state.melds[uid] || []);
        const mergeTarget = tryFindMergeTarget(cards, meldType, allTeamMelds, state.mode as string);
        // True when this play itself reaches 7+ cards (guards are relaxed when a Buraco is formed)
        const thisMeldCreatesCanasta =
          cards.length >= 7 ||
          (mergeTarget !== null && mergeTarget.cards.length + cards.length >= 7);

        // ── Pre-meld Classic / Professional Direct checks ──────────────────────
        if (state.mode === GameMode.CLASSIC) {
          const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;
          const potStillAvailable = teamPotCount < 1 && state.potPiles.some(p => p.length > 0);
          // Before the pot is taken, melding/discarding to 0 is a pot pickup — always allow.
          // After the pot, Classic requires at least 1 card left to discard.
          if (handAfterMeld.length === 0 && !potStillAvailable) {
            throw new BadRequestException(
              'Classic: cannot meld all cards — must leave at least one card to discard',
            );
          }
          // A lone wild is only invalid as a last card after the pot (would be an illegal close discard).
          // Before the pot, the wild will be discarded to trigger pot pickup — allow it.
          if (handAfterMeld.length === 1 && handAfterMeld[0].isWild && !thisMeldCreatesCanasta && !potStillAvailable) {
            throw new BadRequestException(
              'Classic: cannot leave a lone Joker or 2 as your last card',
            );
          }
        }

        if (state.mode === GameMode.PROFESSIONAL && state.endMode === 'DIRECT') {
          const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;
          // Include this meld's contribution to Buraco detection
          const teamHasBuraco =
            teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || [])) || thisMeldCreatesCanasta;
          const potAvailable = state.potPiles.some(p => p.length > 0) && teamPotCount < 2;

          if (handAfterMeld.length === 0) {
            if (potAvailable) {
              // Will take a pot — first pot requires a Buraco
              if (teamPotCount === 0 && !teamHasBuraco) {
                throw new BadRequestException(
                  'Professional Direct: must have a Buraco before collecting the first pot on-the-fly',
                );
              }
            } else {
              // No pot → this is a close attempt; must have Buraco + both pots
              if (!teamHasBuraco) {
                throw new BadRequestException(
                  'Professional Direct: must have a Buraco before closing on-the-fly',
                );
              }
              if (teamPotCount < 2) {
                throw new BadRequestException(
                  'Professional Direct: must have collected both pots before closing on-the-fly',
                );
              }
            }
          }

          // Never leave exactly 1 card that cannot be played on the fly
          if (handAfterMeld.length === 1) {
            const singleCard = handAfterMeld[0];
            const prospectiveMeld: Meld = mergeTarget
              ? { ...mergeTarget, cards: [...mergeTarget.cards, ...cards] }
              : {
                  id: 'tmp', teamId: playerTeamId, type: meldType, cards,
                  isNatural: !cards.some(c => c.isWild), isCanasta: cards.length >= 7,
                };
            const meldsAfterPlay = mergeTarget
              ? allTeamMelds.map(m => m.id === mergeTarget.id ? prospectiveMeld : m)
              : [...allTeamMelds, prospectiveMeld];
            if (!meldsAfterPlay.some(m => canAddToMeld(m, [singleCard], state.mode as string))) {
              throw new BadRequestException(
                'Professional Direct: this play would leave a card you cannot finish on the fly',
              );
            }
          }
        }

        // ── Remove cards from hand ─────────────────────────────────────────────
        const sortedCards = sortMeldCards(cards, meldType);
        ;(move.cardIds ?? []).forEach(id => {
          const idx = hand.findIndex(c => c.id === id);
          if (idx !== -1) hand.splice(idx, 1);
        });

        if (mergeTarget) {
          mergeTarget.cards = sortMeldCards([...mergeTarget.cards, ...sortedCards], meldType);
          mergeTarget.isCanasta = mergeTarget.cards.length >= 7;
          mergeTarget.isNatural = mergeTarget.cards.every(c => !c.isWild);
          const nowDirty = computeMeldHasActingWild(mergeTarget.cards, meldType);
          mergeTarget.everDirty = state.mode === GameMode.PROFESSIONAL
            ? (mergeTarget.everDirty || nowDirty)
            : nowDirty;
          result = { meld: mergeTarget, merged: true, handCount: hand.length };
        } else {
          const isDirty = computeMeldHasActingWild(sortedCards, meldType);
          const newMeld: Meld = {
            id:        uuidv4(),
            teamId:    playerTeamId,
            type:      meldType,
            cards:     sortedCards,
            isNatural: sortedCards.every(c => !c.isWild),
            isCanasta: sortedCards.length >= 7,
            everDirty: isDirty,
          };
          state.melds[playerId].push(newMeld);
          result = { meld: newMeld, merged: false, handCount: hand.length };
        }

        // ── Professional: Buraco of 2 instant win ───────────────────────────
        if (state.mode === GameMode.PROFESSIONAL) {
          const allMelds = Object.values(state.melds).flat();
          if (hasBuracoOfTwos(allMelds)) {
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: { ...result, buracoOfTwos: true }, isValid: true },
            });
            const finalResult = await this.finalizeGame(gameId, state, playerTeamId, true);
            return { state: this.buildClientView(state, playerId), result, ...finalResult };
          }
        }

        // ── Hand empty → try pot or close ────────────────────────────────────
        if (hand.length === 0) {
          const potAward = this.tryAwardPot(state, playerId, 'PLAY_MELD');
          if (potAward) {
            result.potAwarded = potAward;
          } else if (state.mode === GameMode.PROFESSIONAL && state.endMode === 'DIRECT') {
            // Close on-the-fly in Professional Direct (close conditions already validated above)
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: result, isValid: true },
            });
            return this.finalizeGame(gameId, state, playerTeamId);
          } else {
            // Classic: already blocked above. Professional Indirect or edge: finalize without close bonus.
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: result, isValid: true },
            });
            return this.finalizeGame(gameId, state);
          }
        }
        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      case MoveType.ADD_TO_MELD: {
        if (turnPhase !== 'CAN_MELD_OR_DISCARD') throw new BadRequestException('WRONG_PHASE');
        let meld: Meld | undefined;
        for (const uid of teamPlayerIds) {
          meld = state.melds[uid]?.find(m => m.id === move.meldId);
          if (meld) break;
        }
        if (!meld) throw new NotFoundException('Meld not found');
        const cards = this.resolveCards(hand, move.cardIds || []);
        if (!canAddToMeld(meld, cards, state.mode as string)) {
          throw new BadRequestException('Cannot add those cards to this meld');
        }

        // ── 75-rule: same accumulate-and-accept treatment as PLAY_MELD (see there) ──
        {
          const rule = state.seventyFiveRule?.[playerId];
          if (rule?.active && !rule.satisfied) {
            const isPro    = state.mode === GameMode.PROFESSIONAL;
            const priorPts = this.seventyFiveTurnPoints(state, playerId);
            const newPts   = cards.reduce((s, c) => s + cardValue(c, isPro), 0);
            if (!rule.pendingCardIds) rule.pendingCardIds = [];
            rule.pendingCardIds.push(...cards.map(c => c.id));
            if (priorPts + newPts >= rule.requirement) {
              rule.satisfied = true;
              rule.pendingCardIds = [];
            }
          }
        }

        // ── Pre-add Classic / Professional Direct checks ─────────────────────
        const handAfterAdd = hand.filter(c => !cards.some(mc => mc.id === c.id));
        const addCreatesCanasta = meld.cards.length + cards.length >= 7;

        if (state.mode === GameMode.CLASSIC) {
          const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;
          const potStillAvailable = teamPotCount < 1 && state.potPiles.some(p => p.length > 0);
          if (handAfterAdd.length === 0 && !potStillAvailable) {
            throw new BadRequestException(
              'Classic: cannot play all cards — must leave at least one card to discard',
            );
          }
          if (handAfterAdd.length === 1 && handAfterAdd[0].isWild && !addCreatesCanasta && !potStillAvailable) {
            throw new BadRequestException(
              'Classic: cannot leave a lone Joker or 2 as your last card',
            );
          }
        }

        if (state.mode === GameMode.PROFESSIONAL && state.endMode === 'DIRECT') {
          const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;
          const teamHasBuraco =
            teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || [])) || addCreatesCanasta;
          const potAvailable = state.potPiles.some(p => p.length > 0) && teamPotCount < 2;

          if (handAfterAdd.length === 0) {
            if (potAvailable) {
              if (teamPotCount === 0 && !teamHasBuraco) {
                throw new BadRequestException(
                  'Professional Direct: must have a Buraco before collecting the first pot on-the-fly',
                );
              }
            } else {
              if (!teamHasBuraco) {
                throw new BadRequestException(
                  'Professional Direct: must have a Buraco before closing on-the-fly',
                );
              }
              if (teamPotCount < 2) {
                throw new BadRequestException(
                  'Professional Direct: must have collected both pots before closing on-the-fly',
                );
              }
            }
          }

          // Never leave exactly 1 card that cannot be played on the fly
          if (handAfterAdd.length === 1) {
            const singleCard = handAfterAdd[0];
            const updatedMeld: Meld = { ...meld, cards: [...meld.cards, ...cards] };
            const teamMeldsAfterAdd = teamPlayerIds
              .flatMap(uid => state.melds[uid] || [])
              .map(m => (m.id === meld.id ? updatedMeld : m));
            if (!teamMeldsAfterAdd.some(m => canAddToMeld(m, [singleCard], state.mode as string))) {
              throw new BadRequestException(
                'Professional Direct: this play would leave a card you cannot finish on the fly',
              );
            }
          }
        }

        // ── Apply add ────────────────────────────────────────────────────────
        meld.cards.push(...cards);
        meld.cards     = sortMeldCards(meld.cards, meld.type);
        meld.isCanasta = meld.cards.length >= 7;
        meld.isNatural = meld.cards.every(c => !c.isWild);
        const nowDirty = computeMeldHasActingWild(meld.cards, meld.type);
        meld.everDirty = state.mode === GameMode.PROFESSIONAL
          ? (meld.everDirty || nowDirty)
          : nowDirty;
        ;(move.cardIds ?? []).forEach(id => {
          const idx = hand.findIndex(c => c.id === id);
          if (idx !== -1) hand.splice(idx, 1);
        });
        result = { meld, handCount: hand.length };

        // ── Professional: Buraco of 2 instant win ───────────────────────────
        if (state.mode === GameMode.PROFESSIONAL) {
          const allMelds = Object.values(state.melds).flat();
          if (hasBuracoOfTwos(allMelds)) {
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: { ...result, buracoOfTwos: true }, isValid: true },
            });
            const finalResult = await this.finalizeGame(gameId, state, playerTeamId, true);
            return { state: this.buildClientView(state, playerId), result, ...finalResult };
          }
        }

        // ── Hand empty → try pot or close ────────────────────────────────────
        if (hand.length === 0) {
          const potAward = this.tryAwardPot(state, playerId, 'ADD_TO_MELD');
          if (potAward) {
            result.potAwarded = potAward;
          } else if (state.mode === GameMode.PROFESSIONAL && state.endMode === 'DIRECT') {
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: result, isValid: true },
            });
            return this.finalizeGame(gameId, state, playerTeamId);
          } else {
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: result, isValid: true },
            });
            return this.finalizeGame(gameId, state);
          }
        }
        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      case MoveType.DISCARD: {
        if (turnPhase !== 'CAN_MELD_OR_DISCARD') throw new BadRequestException('WRONG_PHASE');

        // 75-rule: discarding ends the turn, so a still-open opening attempt is resolved
        // now rather than carrying into next turn — see autoResolveSeventyFiveRuleOnTurnEnd.
        // Non-null only when this discard actually rolled an attempt back; the caller
        // forwards it as autoCancelled75 + returnedCardIds so the client can tell a plain
        // discard from one that also returned cards and moved the requirement.
        autoCancelRollback = this.autoResolveSeventyFiveRuleOnTurnEnd(state, playerId);

        const cardId = move.cardIds?.[0];
        if (!cardId) throw new BadRequestException('No card specified for discard');
        const idx = hand.findIndex(c => c.id === cardId);
        if (idx === -1) throw new BadRequestException('Card not in hand');
        const [card] = hand.splice(idx, 1);

        // Professional Direct: finishing by discard is never allowed — must empty hand on the fly
        if (state.mode === GameMode.PROFESSIONAL && state.endMode === 'DIRECT' && hand.length === 0) {
          hand.push(card);
          throw new BadRequestException(
            'Professional Direct: you cannot discard your last card. You must finish on the fly.',
          );
        }

        if (hand.length === 0) {
          // Auto-award pot first (tryAwardPot also advances the turn for DISCARD)
          const potAward = this.tryAwardPot(state, playerId, 'DISCARD');
          if (potAward) {
            state.discardPile.push(card);
            result = { discardedCard: card, handCount: hand.length, potAwarded: potAward };
            break;
          }

          // No pot — validate close
          if (state.mode === GameMode.CLASSIC && card.isWild) {
            hand.push(card);
            throw new BadRequestException('Classic: cannot close the game by discarding a wild card');
          }

          const teamHasBuraco = teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || []));
          if (!teamHasBuraco) {
            hand.push(card);
            throw new BadRequestException('Your team must have at least one Buraco (7+ cards) to close the game');
          }

          const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;
          const requiredPots = state.mode === GameMode.PROFESSIONAL ? 2 : 1;
          if (teamPotCount < requiredPots) {
            hand.push(card);
            throw new BadRequestException(
              state.mode === GameMode.PROFESSIONAL
                ? 'Professional: must collect both pots before closing the game'
                : 'Your team must collect the pot before closing the game',
            );
          }

          state.discardPile.push(card);
          return this.finalizeGame(gameId, state, playerTeamId);
        }

        state.discardPile.push(card);
        result = { discardedCard: card, handCount: hand.length };
        state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
        state.turnStartedAt    = Date.now();
        state.turnPhase        = 'MUST_DRAW';
        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      case MoveType.PICKUP_POT: {
        if (turnPhase !== 'CAN_MELD_OR_DISCARD') throw new BadRequestException('WRONG_PHASE');
        if (!canPickupPot(hand)) throw new BadRequestException('Hand must be empty to pick up pot');

        const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;

        const isClassic      = state.mode === GameMode.CLASSIC;
        const maxPots        = isClassic ? 1 : 2;
        if (teamPotCount >= maxPots) {
          throw new BadRequestException(
            isClassic
              ? 'Classic: your team has already collected their pot'
              : 'Your team has already collected both pots',
          );
        }

        // Professional: must have Buraco before taking first pot
        if (state.mode === GameMode.PROFESSIONAL && teamPotCount === 0) {
          const teamHasBuraco = teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || []));
          if (!teamHasBuraco) {
            throw new BadRequestException(
              'Professional: must have at least one Buraco before collecting the pot',
            );
          }
        }

        // Second pot (and Professional Direct first pot): only on-the-fly (hand empty via meld, not manual PICKUP_POT)
        // PICKUP_POT is the manual command — block second pot here
        if (teamPotCount >= 1) {
          throw new BadRequestException(
            'Second pot can only be taken on-the-fly (by melding all cards, not manually)',
          );
        }

        const pot = state.potPiles.find(p => p.length > 0);
        if (!pot) throw new BadRequestException('No pot available');
        hand.push(...pot.splice(0, pot.length));

        if (!state.potCollectedByTeam) state.potCollectedByTeam = [];
        state.potCollectedByTeam.push(playerTeamId);

        // Player continues their turn with the new hand — reset the turn timer
        state.turnStartedAt = Date.now();

        result = { handCount: hand.length, potCollectedByTeam: state.potCollectedByTeam };
        break;
      }
    }

    // A discard that also rolled a short 75-rule attempt back reports both, so the client
    // never has to infer the escalation from a requirement that silently changed.
    if (autoCancelRollback) {
      result.autoCancelled75 = true;
      Object.assign(result, autoCancelRollback);
    }

    state.moveCount++;
    await this.redis.setJson(this.stateKey(gameId), state, 86400);
    await this.prisma.gameMove.create({
      data: { gameId, playerId, turnNumber: state.moveCount, moveType: move.type, cardData: result, isValid: true },
    });

    return {
      state:            this.buildClientView(state, playerId),
      result,
      rollback:         autoCancelRollback,
      teamId:           state.players.find(p => p.userId === playerId)?.teamId,
      nextTurnPlayerId: state.turnOrder[state.currentTurnIndex],
    };
  }

  // ── Shared round-score breakdown (finalizeGame, resignGame, endMatchByAbsence) ─────
  // A resign/forfeit ends the game from a hidden-hand state exactly like a normal round
  // close does, so it must go through the SAME server-side computation — otherwise those
  // paths fall back to omitting roundScore/breakdown, and each client derives the
  // opponent's hand-penalty locally from its own partial view and disagrees with the
  // other device. Computing it once here and sending it verbatim is the fix.

  /** Per-team round total + score breakdown from the CURRENT melds/hands on `state`. */
  private computeRoundBreakdown(
    state: GameState,
    closerTeamId?: number,
    applyPotPenalty = true,
  ): { roundScores: Record<number, number>; teamBreakdowns: Record<number, ReturnType<typeof calculateScoreBreakdown>> } {
    const roundScores: Record<number, number> = { 1: 0, 2: 0 };
    for (const player of state.players) {
      const score = calculateScore(state.melds[player.userId] || [], state.hands[player.userId] || [], state.mode);
      roundScores[player.teamId] = (roundScores[player.teamId] || 0) + score;
    }
    if (closerTeamId !== undefined) {
      roundScores[closerTeamId] = (roundScores[closerTeamId] || 0) + 100;
    }
    const collectedTeams = state.potCollectedByTeam ?? [];
    if (applyPotPenalty) {
      for (const teamId of [1, 2]) {
        if (!collectedTeams.includes(teamId)) {
          roundScores[teamId] = (roundScores[teamId] || 0) - 100;
        }
      }
    }

    const teamBreakdowns: Record<number, ReturnType<typeof calculateScoreBreakdown>> = {};
    for (const teamId of [1, 2]) {
      const teamPlayers = state.players.filter(p => p.teamId === teamId);
      const allMelds = teamPlayers.flatMap(p => state.melds[p.userId] || []);
      const allHand  = teamPlayers.flatMap(p => state.hands[p.userId] || []);
      teamBreakdowns[teamId] = calculateScoreBreakdown(
        allMelds,
        allHand,
        state.mode,
        closerTeamId === teamId ? 100 : 0,
        applyPotPenalty && !collectedTeams.includes(teamId) ? -100 : 0,
      );
    }
    return { roundScores, teamBreakdowns };
  }

  /** Builds one authoritative round-scoreboard row per player — identical for every client. */
  private buildPlayerRoundScoreRows(
    state: GameState,
    roundScores: Record<number, number>,
    teamBreakdowns: Record<number, ReturnType<typeof calculateScoreBreakdown>>,
    matchScores: Record<number, number>,
  ): PlayerRoundScoreRow[] {
    return state.players.map(p => {
      const b = teamBreakdowns[p.teamId];
      return {
        playerId:        p.userId,
        playerName:      state.usernames?.[p.userId] ?? '',
        teamId:          p.teamId,
        roundScore:      roundScores[p.teamId] ?? 0,
        matchScore:      matchScores[p.teamId] ?? 0,
        boardScore:      b.boardScore,
        cleanBuraco:     b.cleanBuraco,
        semiCleanBuraco: b.semiCleanBuraco,
        dirtyBuraco:     b.dirtyBuraco,
        potNotTaken:     b.potNotTaken,
        paidCards:       b.paidCards,
        finishBonus:     b.finishBonus,
        breakdown:       b,
      };
    });
  }

  /**
   * Converts internal (`playerId`-keyed) rows to the public `game:end` (`userId`-keyed) shape.
   * `isDraw` (both players away from their phones) marks EVERY row DRAW and ignores winnerIds.
   */
  private toGameEndPlayers(rows: PlayerRoundScoreRow[], winnerIds: string[], isDraw = false): GameEndPlayerRow[] {
    return rows.map(s => ({
      userId:          s.playerId,
      playerName:      s.playerName,
      teamId:          s.teamId,
      result:          isDraw
        ? 'DRAW' as const
        : winnerIds.includes(s.playerId) ? 'WIN' as const : 'LOSS' as const,
      score:           s.matchScore,
      roundScore:      s.roundScore,
      boardScore:      s.boardScore,
      cleanBuraco:     s.cleanBuraco,
      semiCleanBuraco: s.semiCleanBuraco,
      dirtyBuraco:     s.dirtyBuraco,
      potNotTaken:     s.potNotTaken,
      paidCards:       s.paidCards,
      finishBonus:     s.finishBonus,
    }));
  }

  /**
   * Resyncs a client that replays a move after the game already ended server-side
   * (see AppGateway.handleMoveError) with the same authoritative breakdown everyone
   * else already received in `game:end`, instead of omitting it.
   */
  buildGameEndPlayersFromState(view: { lastRoundScores?: PlayerRoundScoreRow[]; winnerTeam?: number | null }): GameEndPlayerRow[] {
    const rows = view.lastRoundScores ?? [];
    // winnerTeam 0 is the draw marker persisted by a both-players-away ending; there is no
    // winning side to match rows against, so every row must come back DRAW.
    const isDraw = view.winnerTeam === 0;
    const winnerIds = rows.filter(r => r.teamId === view.winnerTeam).map(r => r.playerId);
    return this.toGameEndPlayers(rows, winnerIds, isDraw);
  }

  // ── Single settlement path ────────────────────────────────────────────────────────
  //
  // Every way a match can end — normal finish, resign, 12-turn forfeit, mutual-absence
  // draw, or a legacy Fusion report — funnels through settleMatchOnce. Before this, each
  // path repeated the same "write gameSession + matchRecord, then pay stats and coins"
  // block behind nothing stronger than a read-then-write `status !== IN_PROGRESS` check,
  // so two endings racing (a resign landing while the cron's forfeit was mid-flight)
  // could pay both players twice. distributeMatchReward is a bare balance increment with
  // no dedupe of its own, so this guard is the only thing preventing that.

  /**
   * Persists the match outcome and pays rewards EXACTLY ONCE for `gameId`.
   *
   * Guarded three ways, cheapest first:
   *   1. `game:{id}:settled` SETNX — blocks concurrent endings in the same process/cluster.
   *   2. an existing `matchRecord` row — survives a Redis flush or an expired lock.
   *   3. a P2002 catch on the insert — the DB's own unique index is the final backstop, and
   *      losing that race means rewards are skipped rather than paid twice.
   *
   * @returns true when THIS call settled the match; false when it was already settled.
   */
  private async settleMatchOnce(
    gameId: string,
    args: {
      players:    Array<{ userId: string; teamId: number }>;
      mode:       GameMode;
      variant:    GameVariant;
      /** 0 = draw: no winners, everyone scored as DRAW and paid the non-winner reward. */
      winnerTeam: number;
      winnerIds:  string[];
      scores:     Record<number, number>;
      duration:   number;
      reason:     string;
    },
  ): Promise<boolean> {
    const { players, winnerTeam, winnerIds, scores, duration, reason } = args;
    const isDraw = winnerTeam === 0;

    if (!(await this.redis.setNx(`game:${gameId}:settled`, '1', 86400))) {
      this.logger.warn(`Settlement for ${gameId} (${reason}) skipped — another ending path holds the lock`);
      return false;
    }

    if (await this.prisma.matchRecord.findUnique({ where: { gameId }, select: { id: true } })) {
      this.logger.warn(`Settlement for ${gameId} (${reason}) skipped — matchRecord already exists`);
      return false;
    }

    const resultFor = (userId: string): MatchOutcome =>
      isDraw ? 'DRAW' : winnerIds.includes(userId) ? 'WIN' : 'LOSS';
    // A draw has no winning side, so the winnerTeam columns stay null.
    const winnerTeamColumn = isDraw ? null : winnerTeam;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.gameSession.update({
          where: { id: gameId },
          data: {
            status:  GameStatus.COMPLETED,
            endedAt: new Date(),
            winnerIds,
            winnerTeam: winnerTeamColumn,
            duration,
            players: {
              updateMany: players.map(p => ({
                where: { userId: p.userId },
                data: { finalScore: scores[p.teamId] ?? 0, result: resultFor(p.userId) },
              })),
            },
          },
        });

        await tx.matchRecord.create({
          data: {
            gameId,
            mode:    args.mode,
            variant: args.variant,
            winnerIds,
            winnerTeam: winnerTeamColumn,
            scores,
            duration,
            players: {
              create: players.map(p => ({
                userId: p.userId,
                teamId: p.teamId,
                score:  scores[p.teamId] ?? 0,
                result: resultFor(p.userId),
              })),
            },
          },
        });
      });
    } catch (err) {
      // P2002 on matchRecord.gameId — another ending won the race between our two checks
      // above and the insert. Bail out BEFORE paying rather than paying a second time.
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.warn(`Settlement for ${gameId} (${reason}) lost the insert race — rewards not re-issued`);
        return false;
      }
      throw err;
    }

    // On a draw nobody is credited a win; both sides take the non-winner payout, matching
    // how reportMatchResult already treats a neutral (winnerTeam 0) ending.
    await Promise.all(players.map(async (p) => {
      const isWinner = !isDraw && winnerIds.includes(p.userId);
      const reward   = calculateMatchReward(scores[p.teamId] ?? 0, isWinner);
      await this.statsService.updateAfterMatch(p.userId, isWinner ? 'WIN' : 'LOSS', reward.points, reward.xp);
      await this.economyService.distributeMatchReward(p.userId, gameId, reward.coins);
    }));

    // The match is over: stop the cron from ever looking at it again.
    await this.redis.srem(this.activeGamesKey(), gameId);
    await this.resetRoomAfterGame(gameId, players.map(p => p.userId));

    this.logger.log(
      `Match ${gameId} settled: reason=${reason} ${isDraw ? 'DRAW' : `winnerTeam=${winnerTeam}`}`,
    );
    return true;
  }

  async finalizeGame(gameId: string, state?: GameState, closerTeamId?: number, buracoOfTwos?: boolean) {
    if (!state) state = (await this.redis.getJson<GameState>(this.stateKey(gameId))) ?? undefined;
    if (!state) throw new NotFoundException('Game not found');

    // Terminal guard: never re-open a match that another ending path (forfeit / resign /
    // a prior finalize) already completed. Without this, a stale or concurrent finalize —
    // e.g. an in-flight auto-play sub-move landing just after a forfeit set COMPLETED —
    // would deal a fresh round on an already-ended game, resurrecting a finished match and
    // producing the "one device shows the scoreboard, the other starts a new round" desync
    // (#4). It also enforces "12 auto-turns ALWAYS ends the match, never just the round" (#13):
    // once forfeit fires, no straggling finalize can turn the match-end back into a round.
    if (state.status !== GameStatus.IN_PROGRESS) {
      // Return a winnerTeam-bearing shape so callers that narrow on `'winnerTeam' in result`
      // (the gateway move handlers) treat this exactly like a normal match-end — clear active
      // games, do NOT re-broadcast or re-deal. The game already ended; there is nothing to do.
      return { alreadyEnded: true as const, winnerTeam: state.winnerTeam ?? 0 };
    }

    // Compute this round's scores + per-player breakdown from the shared helpers above —
    // also used by resignGame/endMatchByAbsence so every ending path sends identical numbers.
    const { roundScores, teamBreakdowns } = this.computeRoundBreakdown(state, closerTeamId, true);

    // Accumulate into match scores
    if (!state.matchScores) state.matchScores = { 1: 0, 2: 0 };
    state.matchScores[1] = (state.matchScores[1] || 0) + roundScores[1];
    state.matchScores[2] = (state.matchScores[2] || 0) + roundScores[2];

    // Per-player authoritative round scoreboard rows — computed HERE, while the completed
    // round's hands/melds are still intact (the new-round branch below overwrites
    // state.hands/state.melds before it deals). Shared by the match-end game:end payload
    // AND the new-round scoreboard so every client shows identical numbers.
    const playerRoundRows = this.buildPlayerRoundScoreRows(state, roundScores, teamBreakdowns, state.matchScores);

    const targetScore = state.targetScore ?? 0;
    const matchEnded =
      !!buracoOfTwos ||
      targetScore === 0 ||
      state.matchScores[1] >= targetScore ||
      state.matchScores[2] >= targetScore;

    if (matchEnded) {
      const winnerTeam = (buracoOfTwos && closerTeamId !== undefined)
        ? closerTeamId
        : (state.matchScores[1] >= state.matchScores[2] ? 1 : 2);
      const winnerIds  = state.players.filter(p => p.teamId === winnerTeam).map(p => p.userId);
      const duration   = Math.floor((Date.now() - state.gameStartedAt) / 1000);

      // Settle FIRST, and only publish this outcome if we won the race. Writing the
      // terminal state before settling meant a path that lost (e.g. this finalize landing
      // just after a resign settled) still overwrote Redis and broadcast a contradicting
      // game:end — leaving the DB saying one team won and the live state saying another.
      const settled = await this.settleMatchOnce(gameId, {
        players:    state.players.map(p => ({ userId: p.userId, teamId: p.teamId })),
        mode:       state.mode,
        variant:    state.variant,
        winnerTeam,
        winnerIds,
        scores:     state.matchScores,
        duration,
        reason:     buracoOfTwos ? 'buraco_of_twos' : 'target_score_reached',
      });

      if (!settled) {
        // Another ending already published the result. Leave it alone and report the
        // outcome it recorded, in the same shape the terminal guard above returns.
        const current = await this.redis.getJson<GameState>(this.stateKey(gameId));
        return { alreadyEnded: true as const, winnerTeam: current?.winnerTeam ?? 0 };
      }

      // Keep terminal state in Redis so GET /state returns COMPLETED status
      state.status     = GameStatus.COMPLETED;
      state.winnerTeam = winnerTeam;
      // Persist the final round's per-player breakdown so GET /result can return the
      // authoritative round score/breakdown (the DB matchRecord only stores cumulative score).
      state.lastRoundScores = playerRoundRows;
      await this.redis.setJson(this.stateKey(gameId), state, 7200);

      const endPayload = {
        gameId,
        winnerTeam,
        winnerIds,
        scores: state.matchScores,
        roundScores,
        // Per-player authoritative breakdown of the final round — identical in the
        // payload sent to every client, so the WIN/LOSE scoreboard's Round Score and
        // breakdown rows match on both devices (previously each client derived the
        // opponent's breakdown from its own partial view and they diverged).
        players: this.toGameEndPlayers(playerRoundRows, winnerIds),
        duration,
        buracoOfTwos: !!buracoOfTwos,
        reason: buracoOfTwos ? 'buraco_of_twos' : 'target_score_reached',
      };
      this.socketService.emitToRoom(`game:${gameId}`, 'game:end', endPayload);
      return { winnerTeam, winnerIds, scores: state.matchScores, roundScores, duration, buracoOfTwos: !!buracoOfTwos };
    }

    // Not match end — deal a new round with the same players
    state.round += 1;
    this.dealNewRound(state);

    // Per-player round scoreboard, sent identically to every client. Built from the
    // shared teamBreakdowns computed at the top of finalizeGame — BEFORE the new round
    // above overwrote state.hands/state.melds. (The old code recomputed the breakdown
    // here from the freshly dealt hands/empty melds, which produced wrong per-player
    // numbers.)
    // Persist so a client that misses the one-shot 'game:new_round' event (e.g. mid-reconnect)
    // still gets the correct round score via getGameState/buildClientView.
    state.lastRoundScores = playerRoundRows;

    await this.redis.setJson(this.stateKey(gameId), state, 86400);

    await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:new_round', async (uid) => ({
      ...this.buildClientView(state, uid),
    }));

    return { roundTransition: true as const, round: state.round, matchScores: state.matchScores };
  }

  // ── 75-rule: pending (this-turn, unsatisfied) meld tracking ─────────────────────────
  //
  // A below-threshold meld/add is accepted and left on the table rather than rejected, so
  // its cards are tracked by id in `pendingCardIds` until the running total this turn
  // reaches `requirement`. They're found by id rather than by meld, because a merge (see
  // tryFindMergeTarget) can land newly-played cards inside an EXISTING meld — possibly a
  // teammate's already-permanent one — so only the specific pending cards, never a whole
  // meld, are ever eligible to be stripped back out.

  /** Sum of card values currently pending (this turn's unsatisfied 75-rule cards) for a player — the "40" in "40/75". */
  private seventyFiveTurnPoints(state: GameState, playerId: string): number {
    const rule = state.seventyFiveRule?.[playerId];
    if (!rule?.pendingCardIds?.length) return 0;
    const isPro       = state.mode === GameMode.PROFESSIONAL;
    const pendingIds  = new Set(rule.pendingCardIds);
    let total = 0;
    for (const melds of Object.values(state.melds)) {
      for (const meld of melds) {
        for (const card of meld.cards) {
          if (pendingIds.has(card.id)) total += cardValue(card, isPro);
        }
      }
    }
    return total;
  }

  /**
   * Strips a player's pending 75-rule cards out of wherever they currently sit on the board
   * (any meld, any player — see merge note above), returns them to that player's hand, bumps
   * `requirement` by 20, and clears the pending list. Deletes any meld left with zero cards;
   * a meld that keeps some cards (a merge onto an older permanent meld) survives with just
   * the non-pending ones. Does NOT touch `satisfied` — the caller only reaches here when it's
   * already false. Returns a SeventyFiveRollback describing exactly what moved (the caller
   * puts it straight into `lastMove`); null when nothing was pending.
   */
  private cancelPendingMelds(state: GameState, playerId: string): SeventyFiveRollback | null {
    const rule = state.seventyFiveRule?.[playerId];
    if (!rule?.pendingCardIds?.length) return null;

    // Snapshot before the board is touched — seventyFiveTurnPoints reads the melds we are
    // about to strip, so it must be sampled first.
    const requiredBefore   = rule.requirement;
    const turnPointsBefore = this.seventyFiveTurnPoints(state, playerId);

    const pendingIds = new Set(rule.pendingCardIds);
    const returned: Card[] = [];

    for (const uid of Object.keys(state.melds)) {
      const melds = state.melds[uid];
      for (let i = melds.length - 1; i >= 0; i--) {
        const meld = melds[i];
        const kept: Card[] = [];
        for (const card of meld.cards) {
          if (pendingIds.has(card.id)) returned.push(card);
          else kept.push(card);
        }
        if (kept.length === meld.cards.length) continue; // nothing pending in this meld
        if (kept.length === 0) {
          melds.splice(i, 1);
        } else {
          meld.cards     = kept;
          meld.isCanasta = meld.cards.length >= 7;
          meld.isNatural = meld.cards.every(c => !c.isWild);
        }
      }
    }

    state.hands[playerId].push(...returned);
    rule.requirement += 20;
    rule.pendingCardIds = [];

    return {
      playerId,
      returnedCardIds: returned.map(c => c.id),
      seventyFiveRequiredBefore:   requiredBefore,
      seventyFiveRequiredAfter:    rule.requirement,
      seventyFiveTurnPointsBefore: turnPointsBefore,
      // Always 0 — pendingCardIds was just emptied. Sent explicitly so a client never has
      // to assume the reset.
      seventyFiveTurnPointsAfter:  this.seventyFiveTurnPoints(state, playerId),
    };
  }

  /**
   * Called wherever a player's turn ends (manual discard, timeout auto-discard, or a
   * timeout that advances with no legal discard at all). If the 75-rule is active and still
   * unsatisfied with cards pending, this silently performs the same rollback as a manual
   * game:move:cancel_melds — otherwise a still-open opening attempt would carry into the
   * player's NEXT turn and corrupt that turn's own pending/turnPoints tracking. A no-op
   * whenever there's nothing pending (rule inactive, already satisfied, or the player never
   * attempted a meld this turn — matching the pre-existing behaviour of not penalising a
   * turn where no meld was attempted at all).
   *
   * Returns the rollback descriptor so the caller can advertise it on the DISCARD as
   * `autoCancelled75` + `returnedCardIds`, or null when it was a no-op — which is also the
   * signal that the discard was an ordinary one with no penalty attached.
   */
  private autoResolveSeventyFiveRuleOnTurnEnd(state: GameState, playerId: string): SeventyFiveRollback | null {
    const rule = state.seventyFiveRule?.[playerId];
    if (!rule?.active || rule.satisfied || !rule.pendingCardIds?.length) return null;
    return this.cancelPendingMelds(state, playerId);
  }

  /**
   * `game:move:cancel_melds` — the player voluntarily gives up this turn's not-yet-satisfied
   * 75-rule melds: cards return to hand, `requirement` rises by 20, turn continues (still
   * CAN_MELD_OR_DISCARD) so they can try again or just discard. Same rollback the backend
   * performs automatically on discard (see autoResolveSeventyFiveRuleOnTurnEnd) — this just
   * lets the player trigger it early instead of via a throwaway discard.
   */
  async cancelMelds(gameId: string, playerId: string) {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state) throw new NotFoundException('Game not found');
    if (state.status !== GameStatus.IN_PROGRESS) throw new BadRequestException('GAME_NOT_IN_PROGRESS');

    const currentPlayer = state.turnOrder[state.currentTurnIndex];
    if (currentPlayer !== playerId) throw new BadRequestException('NOT_YOUR_TURN');
    if ((state.turnPhase ?? 'MUST_DRAW') !== 'CAN_MELD_OR_DISCARD') throw new BadRequestException('WRONG_PHASE');

    const rule = state.seventyFiveRule?.[playerId];
    if (!rule?.active || rule.satisfied || !rule.pendingCardIds?.length) {
      throw new BadRequestException('NOTHING_TO_CANCEL');
    }

    const rollback = this.cancelPendingMelds(state, playerId)!;

    // A deliberate action, same as any other manual move — proves the player is present.
    if (!state.consecutiveMissedTurns) state.consecutiveMissedTurns = {};
    if (!state.forfeitMissedTurns) state.forfeitMissedTurns = {};
    // TEMP DIAGNOSTIC (awayTurns-reset investigation) — see processMove for rationale.
    const cancelPriorForfeit = state.forfeitMissedTurns[playerId] ?? 0;
    const cancelPriorConsecutive = state.consecutiveMissedTurns[playerId] ?? 0;
    if (cancelPriorForfeit > 0 || cancelPriorConsecutive > 0) {
      this.logger.warn(
        `[afk-counter] cancelMelds by ${playerId} in game ${gameId} cleared an active AFK streak: ` +
        `forfeitMissedTurns ${cancelPriorForfeit}->0, consecutiveMissedTurns ${cancelPriorConsecutive}->0`,
      );
    }
    state.consecutiveMissedTurns[playerId] = 0;
    state.forfeitMissedTurns[playerId] = 0;

    // Counts as a move so the payload carries a fresh sequence number — see `seq` in
    // buildClientView's callers: a client that has already applied this rollback can drop
    // an echoed copy instead of tearing down and rebuilding the meld rows again.
    state.moveCount++;

    await this.redis.setJson(this.stateKey(gameId), state, 86400);

    return {
      state: this.buildClientView(state, playerId),
      result: {
        cancelled:        true,
        handCount:        state.hands[playerId].length,
        requirement:      rule.requirement,
        ...rollback,
      },
      rollback,
      teamId: state.players.find(p => p.userId === playerId)?.teamId,
    };
  }

  /**
   * Deals a fresh round onto `state` in place: new deck, hands, pots, stock and opening
   * discard, melds cleared, turn back to seat 0 / MUST_DRAW, no toss animation, cadence
   * carried for still-disconnected players, and the 75-rule re-evaluated from the CURRENT
   * cumulative match scores.
   *
   * Lifted verbatim out of finalizeGame's round-transition branch (its only caller until
   * the QA force-round hook below) so a forced test round is dealt by exactly the same code
   * as a real one — a test round that drifted from the real deal would not be testing the
   * real thing. The caller owns `state.round` and all score bookkeeping; this only deals.
   */
  private dealNewRound(state: GameState): void {
    state.scores             = { 1: 0, 2: 0 };
    state.potCollectedByTeam = [];
    state.status             = GameStatus.IN_PROGRESS;

    const newDeck = shuffle(generateDeck(state.mode !== GameMode.PROFESSIONAL));
    const newHands: Record<string, Card[]> = {};
    const newPots: Card[][] = [[], []];
    let di = 0;
    for (const player of state.players) {
      newHands[player.userId] = newDeck.slice(di, di + 11);
      di += 11;
    }
    newPots[0] = newDeck.slice(di, di + 11); di += 11;
    newPots[1] = newDeck.slice(di, di + 11); di += 11;
    const newStock = newDeck.slice(di);
    const topCard  = newStock.pop();

    state.hands       = newHands;
    state.potPiles    = newPots;
    state.stockPile   = newStock;
    state.discardPile = topCard ? [topCard] : [];
    state.melds       = Object.fromEntries(state.players.map(p => [p.userId, []]));
    state.teamMelds   = { 1: [], 2: [] };
    state.currentTurnIndex = 0;
    state.turnPhase   = 'MUST_DRAW';
    state.turnStartedAt = Date.now();
    state.toss        = null; // no toss animation for round ≥ 2
    // Neither miss counter is touched on a round transition. forfeitMissedTurns tracks a
    // player's cumulative AI-auto-played turns across the WHOLE match (it resets solely on
    // a manual move, see processMove) — wiping it on every round transition meant an AFK
    // player's 12-move forfeit threshold could never be reached in a multi-round match,
    // since a round almost always ends before 12 is hit within it. consecutiveMissedTurns
    // now follows the exact same rule (see markPlayerReconnected and its own doc comment on
    // GameState) so an AFK player's streak keeps climbing across round boundaries too,
    // instead of quietly resetting every time a new hand is dealt.

    // Re-evaluate 75-rule for every player using the updated cumulative match scores
    state.seventyFiveRule = Object.fromEntries(state.players.map(p => {
      const teamScore = state.matchScores[p.teamId] ?? 0;
      const active    = teamScore >= SEVENTY_FIVE_RULE_MIN_SCORE;
      return [p.userId, { active, requirement: 75, satisfied: !active, pendingCardIds: [] }];
    }));
  }

  // ── TEMPORARY QA HOOK — `game:debug:force_round` ────────────────────────────
  //
  // Jumps a live match straight to a later round with both teams parked on the 75-rule
  // threshold, which is the only state where that rule applies. Without it, exercising the
  // 75-rule means playing a full round to 1000+ points first, and every retry of a
  // 75-rule bug costs another full round.
  //
  // Deliberately isolated: nothing in the move / draw / meld / discard / AFK / leave /
  // resign / forfeit paths calls this. It never settles a match, never pays a reward,
  // never writes a match record and never ends a game — it only re-deals and rewrites the
  // scoreboard numbers in Redis. Gated by config `game.debugEventsEnabled`
  // (DEBUG_GAME_EVENTS=false) at the gateway.
  //
  // Delete this method and its gateway handler once the 75-rule is signed off.
  async forceRoundForTesting(
    gameId: string,
    requestingUserId: string,
    opts: { round?: number; teamScore?: number } = {},
  ) {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state) throw new NotFoundException('Game not found');
    if (state.status !== GameStatus.IN_PROGRESS) throw new BadRequestException('GAME_NOT_IN_PROGRESS');
    // Only someone actually at this table may re-deal it, so a stray test build cannot
    // reach into a stranger's live match.
    if (!state.players.some(p => p.userId === requestingUserId)) {
      throw new ForbiddenException('NOT_IN_GAME');
    }

    // Defaults give the plain `{ gameId }` call the scenario QA actually wants: the next
    // round (never below 2) with BOTH teams on 1000, so the rule is active in every seat.
    // `round` / `teamScore` are optional overrides — e.g. teamScore below 1000 to confirm
    // the rule correctly stays OFF, or a specific round number to reproduce a report.
    const round     = Math.max(2, Math.floor(opts.round ?? state.round + 1));
    const teamScore = Math.max(0, Math.floor(opts.teamScore ?? SEVENTY_FIVE_RULE_MIN_SCORE));

    state.round       = round;
    state.matchScores = { 1: teamScore, 2: teamScore };

    // Same deal a real round transition performs — including the 75-rule re-evaluation,
    // which reads the match scores just written above.
    this.dealNewRound(state);

    // A forced jump is not a played round, so there is no round score to report. Zeroed
    // rows keep the client's round scoreboard renderable while showing the injected match
    // totals, instead of leaving it on the previous round's stale numbers.
    const zeroBreakdown = calculateScoreBreakdown([], [], state.mode);
    state.lastRoundScores = this.buildPlayerRoundScoreRows(
      state,
      { 1: 0, 2: 0 },
      { 1: zeroBreakdown, 2: zeroBreakdown },
      state.matchScores,
    );

    await this.redis.setJson(this.stateKey(gameId), state, 86400);

    // Broadcast the ordinary round-transition event so the client needs no new handling
    // beyond firing the debug event. `debugForced` is additive — existing clients ignore it.
    await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:new_round', async (uid) => ({
      ...this.buildClientView(state, uid),
      debugForced: true,
    }));

    this.logger.warn(
      `[DEBUG] force_round by ${requestingUserId}: game ${gameId} → round ${state.round}, ` +
      `matchScores ${teamScore}/${teamScore}, 75-rule active=${teamScore >= SEVENTY_FIVE_RULE_MIN_SCORE}`,
    );

    return {
      gameId,
      round:            state.round,
      matchScores:      state.matchScores,
      // Per-player { active, requirement, satisfied } — lets the tester confirm the rule
      // armed without having to read it off the board.
      seventyFiveRule:  state.seventyFiveRule ?? {},
      currentPlayerId:  state.turnOrder[state.currentTurnIndex] ?? '',
    };
  }

  // `abandonGame` used to live here. It was dead code (nothing called it) and it was the
  // only ending path that DELETED the Redis state instead of marking it COMPLETED, which
  // left a returning player with no state to resync against. A disconnect is now handled
  // by the auto-play cron + the 12-turn forfeit; a deliberate exit goes through resignGame.

  async resignGame(
    gameId: string,
    resigningUserId: string,
  ): Promise<{
    winnerTeam: number; winnerIds: string[]; scores: Record<number, number>; duration: number;
    players: GameEndPlayerRow[];
  } | null> {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state || state.status !== GameStatus.IN_PROGRESS) return null;

    const resigner = state.players.find(p => p.userId === resigningUserId);
    if (!resigner) return null;

    const winnerTeam = resigner.teamId === 1 ? 2 : 1;
    const winnerIds  = state.players.filter(p => p.teamId === winnerTeam).map(p => p.userId);
    const duration   = Math.floor((Date.now() - state.gameStartedAt) / 1000);
    // Carry over the match's actual accumulated score instead of fabricating zeros —
    // otherwise a resign mid-round overwrote both the resigner's cached scoreboard and
    // reward calculation with {1:0, 2:0}, losing all in-progress round score.
    const scores     = state.matchScores ?? { 1: 0, 2: 0 };

    // Authoritative per-player breakdown of the round in progress when they resigned —
    // no closer (nobody melded out) and no pot penalty (the round never reached a state
    // where "failing" to take the pot is meaningful). Same computation finalizeGame uses,
    // so both devices' resign scoreboards show identical numbers instead of each deriving
    // the opponent's hidden-hand penalty locally and disagreeing (see computeRoundBreakdown).
    const { roundScores, teamBreakdowns } = this.computeRoundBreakdown(state, undefined, false);
    const playerRoundRows = this.buildPlayerRoundScoreRows(state, roundScores, teamBreakdowns, scores);

    // Settle before publishing, so a resign that loses the race to a concurrent forfeit
    // does not overwrite the outcome that was actually recorded (see finalizeGame).
    const settled = await this.settleMatchOnce(gameId, {
      players:    state.players.map(p => ({ userId: p.userId, teamId: p.teamId })),
      mode:       state.mode,
      variant:    state.variant,
      winnerTeam,
      winnerIds,
      scores,
      duration,
      reason:     'resigned',
    });
    if (!settled) return null;

    // Mark the state COMPLETED (matching endMatchByAbsence/finalizeGame) instead of deleting
    // it outright, so a straggling move from the other player gets a clean
    // GAME_NOT_IN_PROGRESS error instead of a raw "Game not found" 404.
    state.status     = GameStatus.COMPLETED;
    state.winnerTeam = winnerTeam;
    // Persist so GET /result and a resync via getGameState can also return the breakdown
    // (mirrors finalizeGame — see getGameResult's byId lookup on state.lastRoundScores).
    state.lastRoundScores = playerRoundRows;
    await this.redis.setJson(this.stateKey(gameId), state, 7200);

    return { winnerTeam, winnerIds, scores, duration, players: this.toGameEndPlayers(playerRoundRows, winnerIds) };
  }

  // ── Photon Fusion match-end reporting ─────────────────────────────────────
  //
  // In-match play runs on the players' devices (Fusion, player-hosted), so this server
  // no longer computes the outcome — the acting host reports it here. That makes this
  // row the only durable "the match is over" marker: a player who was offline at match
  // end (forfeited, network loss, app killed) learns the outcome by polling GET /result.

  /** Unknown reason strings are normalised to `finished` rather than rejected. */
  private normalizeReason(reason?: string): string {
    return reason && (MATCH_END_REASONS as readonly string[]).includes(reason) ? reason : 'finished';
  }

  /**
   * Validate a report body here rather than via the global ValidationPipe, which is
   * configured with `forbidNonWhitelisted` and would 400 a report that carries one extra
   * field. Unknown properties are stripped instead — a genuinely finished match must not
   * fail to persist over a field the server has not been taught about yet.
   */
  private async validateReportBody(body: Record<string, unknown>): Promise<ReportMatchResultDto> {
    const dto = plainToInstance(ReportMatchResultDto, body ?? {}, {
      excludeExtraneousValues: false,
      enableImplicitConversion: true,
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      const detail = errors
        .map(e => Object.values(e.constraints ?? {}).join(', ') || e.property)
        .join('; ');
      throw new BadRequestException(`INVALID_MATCH_RESULT: ${detail}`);
    }
    if (!Array.isArray(dto.players) || dto.players.length === 0) {
      throw new BadRequestException('INVALID_MATCH_RESULT: players is required');
    }
    return dto;
  }

  /**
   * Persist the final result of a legacy FUSION (player-hosted) match as reported by the
   * acting host device.
   *
   * Rejected outright for SERVER-hosted matches: this backend computes those outcomes
   * itself, so accepting a client's word for one would let a device declare its own win.
   *
   * Idempotent by `gameId`: the first report wins and every later one — a client retry,
   * or the *other* device reporting after a host migration — is acknowledged with the
   * same `{ ok: true }` without touching the stored data. Duplicates are normal here, so
   * they must never surface as an error the client logs.
   */
  async reportMatchResult(gameId: string, reporterUserId: string, body: Record<string, unknown>) {
    const dto = await this.validateReportBody(body);

    const game = await this.prisma.gameSession.findUnique({
      where: { id: gameId },
      select: {
        id: true, mode: true, variant: true, status: true, hostedBy: true,
        startedAt: true, createdAt: true,
        players: { select: { userId: true, teamId: true } },
        matchRecord: { select: { id: true } },
      },
    });
    if (!game) throw new NotFoundException('GAME_NOT_FOUND');

    if (game.hostedBy === GameHost.SERVER) {
      throw new ForbiddenException('SERVER_HOSTED_MATCH');
    }

    // Host migration means EITHER participant can end up as the reporter, so
    // participation is the only check — there is no designated host user to match.
    if (!game.players.some(p => p.userId === reporterUserId)) {
      throw new ForbiddenException('NOT_A_PARTICIPANT');
    }

    const reason     = this.normalizeReason(dto.reason);
    const winnerTeam = dto.winnerTeam && dto.winnerTeam > 0 ? dto.winnerTeam : 0;
    // Resolve the winning side from the reported team id against the server's own
    // team assignment rather than the client-supplied winnerIds, so a buggy or hostile
    // host cannot pay out both players. The body is still stored verbatim for GET /result.
    const winnerIds  = winnerTeam > 0
      ? game.players.filter(p => p.teamId === winnerTeam).map(p => p.userId)
      : [];

    // Stored (and returned by GET /result) with the reporter's own rows intact, but with
    // the identifying fields normalised to what the server resolved, so the persisted
    // result cannot disagree with the game record it was written alongside.
    const payload = { ...dto, gameId, reason, winnerTeam, winnerIds };

    try {
      await this.prisma.matchResultReport.create({
        data: {
          gameId,
          reportedBy: reporterUserId,
          winnerTeam,
          winnerIds,
          reason,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // P2002 = unique violation on gameId → somebody already reported this match.
      // Matched on the code rather than `instanceof` so a client instantiated from a
      // different module copy still resolves to the duplicate path.
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log(`Duplicate result report for game ${gameId} from ${reporterUserId} — kept the first one`);
        return { ok: true };
      }
      throw err;
    }

    const teamByUser  = new Map(game.players.map(p => [p.userId, p.teamId]));
    const scoreByUser = new Map(dto.players.map(p => [p.playerId, p.matchScore ?? p.roundScore ?? 0]));
    const duration    = Math.max(0, Math.floor((Date.now() - (game.startedAt ?? game.createdAt).getTime()) / 1000));

    // A match that was already force-closed (admin action, timeout job, or the legacy
    // socket flow) has had its economy and stats applied once already. Store the report
    // — it is the only place the per-player breakdown lives — but leave the earlier
    // settlement alone rather than paying out twice.
    //
    // The settled marker is the same key settleMatchOnce takes, so this legacy path and
    // the server-hosted ending paths can never both pay out for one gameId. (A SERVER
    // match is rejected above, so in practice they cannot meet — this is belt-and-braces
    // for a row whose hostedBy was changed by hand.)
    const alreadySettled =
      !!game.matchRecord ||
      (game.status !== GameStatus.IN_PROGRESS && game.status !== GameStatus.WAITING) ||
      !(await this.redis.setNx(`game:${gameId}:settled`, '1', 86400));

    if (alreadySettled) {
      this.logger.warn(
        `Late result report for already-settled game ${gameId} (status=${game.status}) — stored, economy/stats untouched`,
      );
    } else {
      await this.prisma.$transaction(async (tx) => {
        await tx.gameSession.update({
          where: { id: gameId },
          data: {
            status:  GameStatus.COMPLETED,
            endedAt: new Date(),
            winnerIds,
            winnerTeam: winnerTeam > 0 ? winnerTeam : null,
            duration,
            players: {
              updateMany: game.players.map(p => ({
                where: { userId: p.userId },
                data: {
                  finalScore: scoreByUser.get(p.userId) ?? 0,
                  result: winnerTeam === 0 ? 'DRAW' : winnerIds.includes(p.userId) ? 'WIN' : 'LOSS',
                },
              })),
            },
          },
        });

        await tx.matchRecord.create({
          data: {
            gameId,
            mode:    game.mode,
            variant: game.variant,
            winnerIds,
            winnerTeam: winnerTeam > 0 ? winnerTeam : null,
            scores:  Object.fromEntries(game.players.map(p => [p.teamId, scoreByUser.get(p.userId) ?? 0])),
            duration,
            players: {
              create: game.players.map(p => ({
                userId: p.userId,
                teamId: p.teamId,
                score:  scoreByUser.get(p.userId) ?? 0,
                result: winnerTeam === 0 ? 'DRAW' : winnerIds.includes(p.userId) ? 'WIN' : 'LOSS',
              })),
            },
          },
        });
      });

      // Same reward curve the old server-side end-of-game flow used. On a neutral end
      // (winnerTeam 0) nobody is credited a win — both sides take the loser payout.
      await Promise.all(game.players.map(async (p) => {
        const isWinner = winnerIds.includes(p.userId);
        const reward   = calculateMatchReward(Math.max(0, scoreByUser.get(p.userId) ?? 0), isWinner);
        await this.statsService.updateAfterMatch(p.userId, isWinner ? 'WIN' : 'LOSS', reward.points, reward.xp);
        await this.economyService.distributeMatchReward(p.userId, gameId, reward.coins);
      }));
    }

    // Retire the legacy parallel state: marking it COMPLETED both stops the turn-timeout
    // cron from auto-playing a match that is already over and makes GET /state report the
    // finish to any client still on the fallback path.
    await this.markLegacyStateCompleted(gameId, winnerTeam, dto, teamByUser);

    // Frees both seats, flips the room back to EMPTY, and clears each player's
    // `activeGame` key so their next launch does not try to resume a dead match.
    await this.resetRoomAfterGame(gameId, game.players.map(p => p.userId));

    this.logger.log(
      `Fusion match ${gameId} reported by ${reporterUserId}: winnerTeam=${winnerTeam} reason=${reason}`,
    );
    return { ok: true };
  }

  /**
   * Fold the reported scoreboard into the leftover socket-era Redis state, if one exists.
   * Fusion matches never advance this copy, so without it the state stays IN_PROGRESS
   * forever and the auto-play cron keeps working a finished game.
   */
  private async markLegacyStateCompleted(
    gameId: string,
    winnerTeam: number,
    dto: ReportMatchResultDto,
    teamByUser: Map<string, number>,
  ): Promise<void> {
    // Belt-and-braces: a Fusion match should never be in the active-game index, but if one
    // ever got there it must stop being auto-played the moment its result lands.
    await this.redis.srem(this.activeGamesKey(), gameId);

    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state) return;

    state.status     = GameStatus.COMPLETED;
    state.winnerTeam = winnerTeam;
    state.matchScores = state.matchScores ?? { 1: 0, 2: 0 };
    for (const p of dto.players) {
      const teamId = teamByUser.get(p.playerId);
      if (teamId !== undefined) state.matchScores[teamId] = p.matchScore ?? p.roundScore ?? 0;
    }
    state.lastRoundScores = dto.players.map((p) => {
      const boardScore      = p.boardScore ?? 0;
      const cleanBuraco     = p.cleanBuraco ?? 0;
      const semiCleanBuraco = p.semiCleanBuraco ?? 0;
      const dirtyBuraco     = p.dirtyBuraco ?? 0;
      const potNotTaken     = p.potNotTaken ?? 0;
      const paidCards       = p.paidCards ?? 0;
      const finishBonus     = p.finishBonus ?? 0;
      const roundScore      = p.roundScore ?? 0;
      return {
        playerId:   p.playerId,
        playerName: p.playerName ?? state.usernames?.[p.playerId] ?? '',
        teamId:     teamByUser.get(p.playerId) ?? 0,
        roundScore,
        matchScore: p.matchScore ?? roundScore,
        boardScore, cleanBuraco, semiCleanBuraco, dirtyBuraco, potNotTaken, paidCards, finishBonus,
        breakdown: {
          boardScore,
          cleanBuraco,
          semiCleanBuraco,
          dirtyBuraco,
          buracoBonus: cleanBuraco + semiCleanBuraco + dirtyBuraco,
          paidCards,
          finishBonus,
          potNotTaken,
          total: roundScore,
        },
      };
    });

    // 2h, matching finalizeGame's terminal-state retention.
    await this.redis.setJson(this.stateKey(gameId), state, 7200);
  }

  async getGameResult(gameId: string) {
    // A Fusion match's authoritative result is the acting host's report, returned
    // verbatim — the client deserialises this straight into its MatchResult model.
    // Checked first because it is the live path; a miss here is the common "match still
    // running" case and both lookups are unique-index hits.
    const report = await this.prisma.matchResultReport.findUnique({
      where: { gameId },
      select: { payload: true },
    });
    if (report) return report.payload;

    const record = await this.prisma.matchRecord.findUnique({
      where: { gameId },
      include: {
        players: {
          include: { user: { select: { username: true, avatarUrl: true } } },
        },
      },
    });
    if (!record) throw new NotFoundException('Game result not found');

    // The DB matchRecord only persists cumulative `score`. Enrich each player row with
    // the authoritative final-round breakdown so the WIN/LOSE scoreboard's Round Score
    // and breakdown rows match on every device. Recomputed from the terminal Redis state,
    // which finalizeGame keeps for ~2h; if it has expired we return the DB record as-is
    // and the client falls back to its own local computation.
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    const byId = new Map((state?.lastRoundScores ?? []).map(s => [s.playerId, s]));
    if (byId.size === 0) return record;

    return {
      ...record,
      players: record.players.map(p => {
        const s = byId.get(p.userId);
        if (!s) return p;
        return {
          ...p,
          roundScore:      s.roundScore,
          boardScore:      s.boardScore,
          cleanBuraco:     s.cleanBuraco,
          semiCleanBuraco: s.semiCleanBuraco,
          dirtyBuraco:     s.dirtyBuraco,
          potNotTaken:     s.potNotTaken,
          paidCards:       s.paidCards,
          finishBonus:     s.finishBonus,
        };
      }),
    };
  }

  /**
   * What this user should be put back into on launch, resolved server-side rather than from
   * whatever gameId the client happens to have cached locally.
   *
   * `isActive: true`  → a live server-hosted match; the client should join and resync.
   * `isActive: false` → the match they last played has finished; the client should fetch
   *                     GET /:gameId/result and show the scoreboard they missed.
   */
  async getResumeTarget(userId: string): Promise<{
    gameId: string | null;
    isActive: boolean;
    status: GameStatus | null;
    hostedBy: GameHost | null;
  }> {
    const activeGameId = await this.redis.get(`user:${userId}:activeGame`);
    const gameId = activeGameId ?? (await this.redis.get(`user:${userId}:lastGame`));
    if (!gameId) return { gameId: null, isActive: false, status: null, hostedBy: null };

    const game = await this.prisma.gameSession.findUnique({
      where: { id: gameId },
      select: { status: true, hostedBy: true },
    });
    if (!game) return { gameId: null, isActive: false, status: null, hostedBy: null };

    return {
      gameId,
      isActive: game.status === GameStatus.IN_PROGRESS,
      status:   game.status,
      hostedBy: game.hostedBy,
    };
  }

  // ── Disconnect / reconnect state tracking ─────────────────────────────────

  async markPlayerDisconnected(gameId: string, userId: string): Promise<void> {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state || state.status !== GameStatus.IN_PROGRESS) return;
    const player = state.players.find(p => p.userId === userId);
    if (!player) return;
    player.isConnected = false;
    await this.redis.setJson(this.stateKey(gameId), state, 86400);
  }

  async markPlayerReconnected(gameId: string, userId: string): Promise<void> {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state) return;
    const player = state.players.find(p => p.userId === userId);
    if (!player) return;
    player.isConnected = true;
    // TEMP DIAGNOSTIC (awayTurns-reset investigation): this call never mutates either
    // counter (see comment below) — logging what it READ, next to handleTurnTimeout's own
    // read/write log, lets the two be lined up by timestamp on a real repro to see whether
    // this read-modify-write cycle raced one from an in-flight auto-play turn and, by
    // writing back its own (stale) unmodified copy of the counters, clobbered a concurrent
    // increment. Remove once the investigation is closed.
    this.logger.log(
      `[afk-counter] markPlayerReconnected ${userId} in game ${gameId}: observed ` +
      `forfeitMissedTurns=${state.forfeitMissedTurns?.[userId] ?? 0}, ` +
      `consecutiveMissedTurns=${state.consecutiveMissedTurns?.[userId] ?? 0} (this call does not change them)`,
    );
    // If the timer already expired while this player was away and it is still their
    // turn, give them a fresh window (still governed by internalTurnTimeoutSeconds — a
    // player already mid-AFK-streak only gets a fresh 5s, not a bonus full turnDuration)
    // so the next cron tick does not immediately auto-play on their behalf. Otherwise
    // leave turnStartedAt untouched so the remaining time is resumed rather than reset.
    if (state.status === GameStatus.IN_PROGRESS && state.turnOrder[state.currentTurnIndex] === userId) {
      const effectiveTimeout = this.internalTurnTimeoutSeconds(state, userId);
      const expired = Date.now() - state.turnStartedAt > effectiveTimeout * 1000;
      if (expired) {
        state.turnStartedAt = Date.now();
      }
    }
    // Deliberately does NOT touch consecutiveMissedTurns/forfeitMissedTurns. A bare
    // reconnect means the player is back on the socket, not that they made a move — it
    // should not erase how many turns the AI has already played for them. If they go AFK
    // again right after reconnecting, both counters resume from where they left off
    // instead of restarting at 0 (only an actual move, see processMove, clears them).
    await this.redis.setJson(this.stateKey(gameId), state, 86400);
  }

  /**
   * True when a player is "away from their phone": their socket is gone, OR they are still
   * connected but the last AWAY_AFTER_AUTO_TURNS of their turns were all played by the AI.
   *
   * `forfeitMissedTurns` is zeroed by any manual move (processMove), so a player who is
   * actually playing always reads as present no matter how long the match has run.
   */
  private isPlayerAway(state: GameState, userId: string): boolean {
    const player = state.players.find(p => p.userId === userId);
    if (player && player.isConnected === false) return true;
    return (state.forfeitMissedTurns?.[userId] ?? 0) >= AWAY_AFTER_AUTO_TURNS;
  }

  /**
   * After each auto-played turn, check whether the player has reached 12 consecutive
   * auto-plays (IDLE or DISCONNECTED) and end the match if so.
   *
   * The outcome depends on whether anyone is still actually there:
   *   - at least one opponent present → that team WINS by forfeit;
   *   - every opponent also away      → DRAW, because handing the win to a player who is
   *     equally absent is not a result either side earned. This is the "both players closed
   *     their phones" case; with alternating turns one of them always crosses 12 first, so
   *     without this check the second player would win purely on turn order.
   *
   * Returns true if the match ended (caller should return immediately).
   */
  private async checkAndForfeit(gameId: string, playerId: string, state: GameState): Promise<boolean> {
    const missed = state.forfeitMissedTurns?.[playerId] ?? state.consecutiveMissedTurns?.[playerId] ?? 0;
    if (missed < FORFEIT_AFTER_AUTO_TURNS) return false;

    const forfeiter = state.players.find(p => p.userId === playerId);
    if (!forfeiter) return false;

    const opponents  = state.players.filter(p => p.teamId !== forfeiter.teamId);
    const allAway    = opponents.length > 0 && opponents.every(p => this.isPlayerAway(state, p.userId));
    const isDisconnected = !(forfeiter.isConnected ?? true);

    await this.endMatchByAbsence(
      gameId,
      state,
      // winnerTeam 0 = draw. Otherwise the opposing team takes the win.
      allAway ? 0 : (forfeiter.teamId === 1 ? 2 : 1),
      allAway ? 'both_players_away'
              : isDisconnected ? 'player_abandoned' : 'inactive_forfeit',
    );
    return true;
  }

  /**
   * Ends a match that ran out of participants — one player forfeiting after 12 auto-played
   * turns, or every player being away (a draw). Uses a Redis lock so concurrent cron ticks
   * cannot both fire, and routes the payout through settleMatchOnce so rewards are issued
   * exactly once even if another ending path is racing this one.
   */
  private async endMatchByAbsence(
    gameId: string,
    state: GameState,
    /** Winning team id, or 0 for a draw (every player away from their phone). */
    winnerTeam: number,
    reason: 'inactive_forfeit' | 'player_abandoned' | 'both_players_away',
  ): Promise<void> {
    if (state.status !== GameStatus.IN_PROGRESS) return;

    // Atomic lock: only one concurrent cron tick may execute the ending
    const lockKey = `game:${gameId}:ending`;
    const locked  = await this.redis.setNx(lockKey, '1', 30);
    if (!locked) return;

    const isDraw    = winnerTeam === 0;
    const winnerIds = isDraw ? [] : state.players.filter(p => p.teamId === winnerTeam).map(p => p.userId);
    const duration  = Math.floor((Date.now() - state.gameStartedAt) / 1000);
    const scores    = state.matchScores ?? { 1: 0, 2: 0 };

    // Authoritative per-player breakdown of the round in progress at forfeit time — same
    // reasoning as resignGame: no closer, no pot penalty, computed once server-side so
    // both devices' scoreboards agree instead of each guessing the opponent's hand penalty.
    const { roundScores, teamBreakdowns } = this.computeRoundBreakdown(state, undefined, false);
    const playerRoundRows = this.buildPlayerRoundScoreRows(state, roundScores, teamBreakdowns, scores);

    // Settle before publishing, so an ending that loses the race to a concurrent resign
    // does not overwrite the recorded outcome or broadcast a contradicting game:end.
    const settled = await this.settleMatchOnce(gameId, {
      players:    state.players.map(p => ({ userId: p.userId, teamId: p.teamId })),
      mode:       state.mode,
      variant:    state.variant,
      winnerTeam,
      winnerIds,
      scores,
      duration,
      reason,
    });
    if (!settled) return;

    state.status     = GameStatus.COMPLETED;
    // 0 is the persisted draw marker: buildClientView and buildGameEndPlayersFromState both
    // read it, so a player who reconnects long after the match still learns it was a draw.
    state.winnerTeam = winnerTeam;
    // Persist so GET /result and a resync via getGameState can also return the breakdown.
    state.lastRoundScores = playerRoundRows;
    await this.redis.setJson(this.stateKey(gameId), state, 7200);

    this.socketService.emitToRoom(`game:${gameId}`, 'game:end', {
      gameId,
      winnerTeam,
      winnerIds,
      scores,
      duration,
      reason,
      isDraw,
      players: this.toGameEndPlayers(playerRoundRows, winnerIds, isDraw),
    });
  }

  /** Delay between auto-play sub-moves so the client animates them smoothly and the
   *  outbound burst doesn't delay the socket heartbeat pong (the "ping spike"). */
  private paceAutoMove(): Promise<void> {
    return new Promise(res => setTimeout(res, AUTOPLAY_MOVE_PACING_MS));
  }

  async handleTurnTimeout(gameId: string) {
    const state = await this.redis.getJson<GameState>(this.stateKey(gameId));
    if (!state || state.status !== GameStatus.IN_PROGRESS) return;
    if (state.turnPhase === 'ROUND_ENDED') return;

    const playerId = state.turnOrder[state.currentTurnIndex];
    const hand     = state.hands[playerId];

    // Increment consecutive-miss counter before any state save so the updated
    // value is always persisted with the auto-play result.
    if (!state.consecutiveMissedTurns) state.consecutiveMissedTurns = {};
    const priorMissed = state.consecutiveMissedTurns[playerId] ?? 0;
    state.consecutiveMissedTurns[playerId] = priorMissed + 1;
    if (!state.forfeitMissedTurns) state.forfeitMissedTurns = {};
    const priorForfeit = state.forfeitMissedTurns[playerId] ?? 0;
    state.forfeitMissedTurns[playerId] = priorForfeit + 1;
    // TEMP DIAGNOSTIC (awayTurns-reset investigation): this function reads state once up
    // front, then stays in memory across several awaits (Prisma writes, the per-meld
    // pacing delay) before its own setJson persists it — the widest window of any writer
    // on this key. Logging the read-time value here, next to markPlayerReconnected's own
    // read-time log, lets us line the two up by timestamp and see whether a reconnect's
    // write actually landed AFTER this one and clobbered it back down. Remove once closed.
    this.logger.log(
      `[afk-counter] handleTurnTimeout auto-played for ${playerId} in game ${gameId}: ` +
      `forfeitMissedTurns ${priorForfeit}->${priorForfeit + 1}, consecutiveMissedTurns ${priorMissed}->${priorMissed + 1}`,
    );
    // Smart play activates on the second and subsequent misses (priorMissed ≥ 1).
    const useSmartPlay = priorMissed >= 1;

    let drawnCard: Card | undefined;
    if (state.turnPhase === 'MUST_DRAW') {
      // Smart play: take the discard top if it immediately helps form/extend a meld.
      if (useSmartPlay && this.aiShouldTakeDiscard(state, hand)) {
        const takenCards = [...state.discardPile];
        hand.push(...takenCards);
        state.discardPile = [];
        state.turnPhase   = 'CAN_MELD_OR_DISCARD';
        drawnCard = takenCards[takenCards.length - 1]; // representative card for the event
      } else {
        if (state.stockPile.length === 0 && state.discardPile.length > 1) {
          const top = state.discardPile.pop()!;
          state.stockPile = shuffle(state.discardPile);
          state.discardPile = [top];
        }
        if (state.stockPile.length > 0) {
          drawnCard = state.stockPile.pop()!;
          hand.push(drawnCard);
          state.turnPhase = 'CAN_MELD_OR_DISCARD';

          let shouldFinalize = false;
          if (state.mode === GameMode.CLASSIC) {
            shouldFinalize = state.stockPile.length <= 2;
          } else {
            // Professional: refill stock from next untaken pot before finalizing
            if (state.stockPile.length === 0) {
              const potIdx = state.potPiles.findIndex(p => p.length > 0);
              if (potIdx !== -1) {
                state.stockPile = shuffle(state.potPiles[potIdx]);
                state.potPiles[potIdx] = [];
              } else {
                shouldFinalize = true;
              }
            }
          }

          if (shouldFinalize) {
            state.moveCount++;
            await this.redis.setJson(this.stateKey(gameId), state, 86400);
            await this.prisma.gameMove.create({
              data: { gameId, playerId, turnNumber: state.moveCount, moveType: MoveType.DRAW_STOCK, cardData: { auto: true, card: drawnCard as any }, isValid: true },
            });
            const drawMove = { type: 'TIMEOUT_DRAW', playerId, cardId: drawnCard.id, isAuto: true };
            this.socketService.emitToRoom(`game:${gameId}`, 'game:move_played', drawMove);
            await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
              lastMove: drawMove,
              ...this.buildClientView(state, uid),
            }));
            // Check the 12-move forfeit threshold BEFORE finalizeGame — otherwise a
            // round transition can wipe out an AFK player's tally before the
            // whole-match-ending forfeit is ever evaluated (see checkAndForfeit).
            if (await this.checkAndForfeit(gameId, playerId, state)) return;
            await this.finalizeGame(gameId, state);
            return { playerId, autoAction: 'DRAW_THEN_FINALIZE', card: drawnCard };
          }
        }
      }
    }

    if (drawnCard) {
      const drawMove = { type: 'TIMEOUT_DRAW', playerId, cardId: drawnCard.id, isAuto: true };
      this.socketService.emitToRoom(`game:${gameId}`, 'game:move_played', drawMove);
      await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
        lastMove: drawMove,
        ...this.buildClientView(state, uid),
      }));
      await this.paceAutoMove();
    }

    // Smart play: lay down melds and extensions between draw and discard. Each is emitted
    // as its own PACED state (see aiApplyMeldsAndExtensions) so the client animates them
    // one at a time smoothly, without bursting the socket.
    if (useSmartPlay) {
      await this.aiApplyMeldsAndExtensions(state, gameId, playerId);
    }

    // 75-rule: this turn is about to end (discard or a no-legal-discard advance below) —
    // resolve any still-open opening attempt now rather than let it carry into this
    // player's next turn. See autoResolveSeventyFiveRuleOnTurnEnd. An AFK/timeout turn
    // carries the SAME autoCancelled75 + returnedCardIds payload as a manual discard, so
    // the client animates the return identically whoever triggered the turn end.
    const autoCancelRollback = this.autoResolveSeventyFiveRuleOnTurnEnd(state, playerId);
    const seventyFiveFields = autoCancelRollback
      ? { autoCancelled75: true, ...autoCancelRollback }
      : {};

    const discardIdx = useSmartPlay
      ? this.aiPickDiscardIndex(state, playerId, hand)
      : this.pickLegalDiscardIndex(state, playerId, hand);

    if (discardIdx === -1 || hand.length === 0) {
      this.logger.warn(`Timeout: no legal discard for ${playerId} (hand=${hand.length}), advancing turn`);
      state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
      state.turnStartedAt    = Date.now();
      state.turnPhase        = 'MUST_DRAW';
      await this.redis.setJson(this.stateKey(gameId), state, 86400);
      // Emit when there was no draw to piggy-back on, AND whenever a 75-rule rollback
      // happened: the draw's own emit went out BEFORE the rollback, so skipping here would
      // leave the returned cards sitting on every phone's table until the next event.
      if (!drawnCard || autoCancelRollback) {
        await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
          lastMove: { type: 'TIMEOUT_ADVANCE', playerId, isAuto: true, ...seventyFiveFields },
          ...this.buildClientView(state, uid),
        }));
      }
      if (await this.checkAndForfeit(gameId, playerId, state)) return;
      return { playerId, autoAction: 'ADVANCE_NO_DISCARD' };
    }

    const [discardedCard] = hand.splice(discardIdx, 1);
    state.discardPile.push(discardedCard);

    if (hand.length === 0) {
      const potAward = this.tryAwardPot(state, playerId, 'DISCARD');
      if (potAward) {
        state.moveCount++;
        await this.redis.setJson(this.stateKey(gameId), state, 86400);
        await this.prisma.gameMove.create({
          data: { gameId, playerId, turnNumber: state.moveCount, moveType: MoveType.DISCARD, cardData: { auto: true, card: discardedCard as any, potAwarded: potAward }, isValid: true },
        });
        const discardMove = { type: 'TIMEOUT_DISCARD', playerId, cardId: discardedCard.id, potAwarded: potAward, isAuto: true, ...seventyFiveFields };
        this.socketService.emitToRoom(`game:${gameId}`, 'game:move_played', discardMove);
        await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
          lastMove: discardMove,
          ...this.buildClientView(state, uid),
        }));
        if (await this.checkAndForfeit(gameId, playerId, state)) return;
        return { playerId, autoAction: drawnCard ? 'DRAW_THEN_DISCARD' : 'DISCARD', card: discardedCard };
      }

      // No pot — this can only legally end the round by CLOSING. Re-validate exactly like
      // processMove's manual DISCARD does (Buraco + full required pot count, never a
      // Classic wild, never Professional Direct). pickLegalDiscardIndex/aiPickDiscardIndex
      // should already keep us from reaching here illegally, but finalizeGame answers to
      // this same authority for a human close, so the AI/timeout path must too — otherwise
      // a stale/foreign discardIdx can still end a round nobody actually won.
      const playerTeamId  = state.players.find(p => p.userId === playerId)?.teamId ?? 1;
      const isClassic     = state.mode === GameMode.CLASSIC;
      const teamPlayerIds = state.players.filter(p => p.teamId === playerTeamId).map(p => p.userId);
      const teamHasBuraco = teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || []));
      const teamPotCount  = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;
      const requiredPots  = isClassic ? 1 : 2;
      const legalClose = teamHasBuraco
        && teamPotCount >= requiredPots
        && !(isClassic && discardedCard.isWild)
        && !(state.mode === GameMode.PROFESSIONAL && state.endMode === 'DIRECT');

      if (!legalClose) {
        // Not a legal close — undo the discard and treat this exactly like "no legal
        // discard": keep the card in hand, advance the turn, TIMEOUT_ADVANCE.
        this.logger.warn(
          `Timeout: last-card discard for ${playerId} was not a legal pot-take or close, ` +
          `keeping card and advancing turn instead of finalizing`,
        );
        state.discardPile.pop();
        hand.push(discardedCard);
        state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
        state.turnStartedAt    = Date.now();
        state.turnPhase        = 'MUST_DRAW';
        await this.redis.setJson(this.stateKey(gameId), state, 86400);
        if (!drawnCard || autoCancelRollback) {
          await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
            lastMove: { type: 'TIMEOUT_ADVANCE', playerId, isAuto: true, ...seventyFiveFields },
            ...this.buildClientView(state, uid),
          }));
        }
        if (await this.checkAndForfeit(gameId, playerId, state)) return;
        return { playerId, autoAction: 'ADVANCE_NO_DISCARD' };
      }

      state.moveCount++;
      await this.redis.setJson(this.stateKey(gameId), state, 86400);
      await this.prisma.gameMove.create({
        data: { gameId, playerId, turnNumber: state.moveCount, moveType: MoveType.DISCARD, cardData: { auto: true, card: discardedCard as any }, isValid: true },
      });
      const discardMove = { type: 'TIMEOUT_DISCARD', playerId, cardId: discardedCard.id, isAuto: true, ...seventyFiveFields };
      this.socketService.emitToRoom(`game:${gameId}`, 'game:move_played', discardMove);
      await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
        lastMove: discardMove,
        ...this.buildClientView(state, uid),
      }));
      // Same as above: evaluate the forfeit threshold before finalizeGame can start a
      // new round and reset consecutiveMissedTurns out from under this check.
      if (await this.checkAndForfeit(gameId, playerId, state)) return;
      await this.finalizeGame(gameId, state, playerTeamId);
      return { playerId, autoAction: drawnCard ? 'DRAW_THEN_DISCARD' : 'DISCARD', card: discardedCard };
    }

    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
    state.turnStartedAt    = Date.now();
    state.turnPhase        = 'MUST_DRAW';
    state.moveCount++;
    await this.redis.setJson(this.stateKey(gameId), state, 86400);
    await this.prisma.gameMove.create({
      data: { gameId, playerId, turnNumber: state.moveCount, moveType: MoveType.DISCARD, cardData: { auto: true, card: discardedCard as any }, isValid: true },
    });

    const discardMove = { type: 'TIMEOUT_DISCARD', playerId, cardId: discardedCard.id, isAuto: true, ...seventyFiveFields };
    this.socketService.emitToRoom(`game:${gameId}`, 'game:move_played', discardMove);
    await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
      lastMove: discardMove,
      ...this.buildClientView(state, uid),
    }));

    if (await this.checkAndForfeit(gameId, playerId, state)) return;
    return { playerId, autoAction: drawnCard ? 'DRAW_THEN_DISCARD' : 'DISCARD', card: discardedCard };
  }

  private pickLegalDiscardIndex(state: GameState, playerId: string, hand: Card[]): number {
    if (hand.length === 0) return -1;

    if (hand.length > 1) return Math.floor(Math.random() * hand.length);

    // hand.length === 1 — discarding it empties the hand, so it's only legal if it either
    // takes an awardable pot or legally closes the game. Must mirror processMove's manual
    // DISCARD case (and the tryAwardPot rules it defers to) exactly, or the AI/timeout path
    // can offer up a "legal" discard that would actually be rejected coming from a player.
    const isClassic     = state.mode === GameMode.CLASSIC;
    const playerTeamId  = state.players.find(p => p.userId === playerId)?.teamId ?? 1;
    const teamPlayerIds = state.players.filter(p => p.teamId === playerTeamId).map(p => p.userId);
    const teamHasBuraco = teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || []));
    const teamPotCount  = (state.potCollectedByTeam ?? []).filter(id => id === playerTeamId).length;

    // Professional Direct: closing by discard is never allowed, full stop — the team must
    // empty its hand on-the-fly via a meld/add-to-meld instead (same as processMove).
    if (!isClassic && state.endMode === 'DIRECT') return -1;

    // Would this discard take the (first) pot rather than close the game? Mirrors
    // tryAwardPot's own DISCARD-path rules: only the first pot (a second pot is
    // never awarded via discard), and in Professional only once the team already
    // has a Buraco.
    const wouldAwardPot = teamPotCount === 0
      && (isClassic || teamHasBuraco)
      && state.potPiles.some(p => p.length > 0);
    if (wouldAwardPot) return 0;

    // No pot to take — this discard would have to legally CLOSE the game instead.
    const card = hand[0];
    if (isClassic && card.isWild) return -1;
    if (!teamHasBuraco) return -1;

    const requiredPots = isClassic ? 1 : 2;
    if (teamPotCount < requiredPots) return -1;

    return 0;
  }

  // ── Auto-play AI ──────────────────────────────────────────────────────────

  /** Returns true when the discard-pile top card can immediately form or extend a meld. */
  private aiShouldTakeDiscard(state: GameState, hand: Card[]): boolean {
    if (state.discardPile.length === 0) return false;
    const top = state.discardPile[state.discardPile.length - 1];
    return canPickupDiscardPile(top, hand);
  }

  /**
   * Applies the best available new melds and meld extensions from the player's hand,
   * emitting a separate game:state_updated per sub-move so the client can animate each
   * step individually (spec §9 emission requirements).  Keeps ≥1 card for the discard.
   */
  private async aiApplyMeldsAndExtensions(state: GameState, gameId: string, playerId: string): Promise<void> {
    const hand    = state.hands[playerId];
    const teamId  = state.players.find(p => p.userId === playerId)?.teamId ?? 1;
    const teamIds = state.players.filter(p => p.teamId === teamId).map(p => p.userId);
    const mode    = state.mode as string;

    const teamMelds = () => teamIds.flatMap(uid => state.melds[uid] || []);

    // Emit each meld/extension as its own state — but PACED (~one animation apart, see
    // paceAutoMove) so the client animates each smoothly and the burst doesn't bury the
    // socket heartbeat pong. Paced, not coalesced: sending only the final board made melds snap.
    const emitMeldMove = async (lastMove: Record<string, unknown>) => {
      this.socketService.emitToRoom(`game:${gameId}`, 'game:move_played', lastMove);
      await this.socketService.emitPerPlayer(`game:${gameId}`, 'game:state_updated', async (uid) => ({
        lastMove,
        ...this.buildClientView(state, uid),
      }));
      await this.paceAutoMove();
    };

    // ── 75-rule gate ────────────────────────────────────────────────────────────
    // The AI plays this turn on an absent player's behalf, so it is bound by the same
    // opening requirement they are. It previously pushed melds straight onto the board
    // without touching seventyFiveRule at all, which both bypassed the rule (a 15-point
    // opening stuck while the player was away) and left the two phones disagreeing about
    // that seat's progress.
    //
    // Policy: attempt the opening ONLY if what it can lay down this turn actually reaches
    // the requirement. A short attempt would be rolled straight back at turn end and cost
    // the absent player +20 every turn, plus a meld that appears and vanishes on both
    // screens — so when it cannot reach the bar, the AI simply melds nothing and discards.
    const rule = state.seventyFiveRule?.[playerId];
    const isPro = state.mode === GameMode.PROFESSIONAL;
    const openingPending = !!rule?.active && !rule.satisfied;

    const newMelds = this.aiFindBestMeldsFromHand(hand, mode);
    if (openingPending) {
      // Mirror the loop below exactly — same skip condition, same shrinking hand — so the
      // decision is made on what will really be played, not an optimistic upper bound.
      let simHandSize = hand.length;
      let reachable   = 0;
      for (const m of newMelds) {
        if (simHandSize - m.length < 1) continue;
        if (!validateMeld(m, mode).valid) continue;
        simHandSize -= m.length;
        reachable   += m.reduce((s, c) => s + cardValue(c, isPro), 0);
      }
      if (reachable < rule!.requirement) return; // no melds, no extensions — just discard
    }

    /**
     * Records cards the AI just committed to the board against the 75-rule, exactly like the
     * blocks in processMove's PLAY_MELD / ADD_TO_MELD do. Must be called BEFORE the cards
     * leave the hand and land in a meld, since seventyFiveTurnPoints reads the board.
     */
    const trackSeventyFive = (cards: Card[]) => {
      if (!rule?.active || rule.satisfied) return;
      const priorPts = this.seventyFiveTurnPoints(state, playerId);
      const newPts   = cards.reduce((s, c) => s + cardValue(c, isPro), 0);
      if (!rule.pendingCardIds) rule.pendingCardIds = [];
      rule.pendingCardIds.push(...cards.map(c => c.id));
      if (priorPts + newPts >= rule.requirement) {
        rule.satisfied = true;
        rule.pendingCardIds = [];
      }
    };

    // 1 — Play new melds from hand (leave at least 1 card to discard).
    for (const meldCards of newMelds) {
      if (hand.length - meldCards.length < 1) continue;
      const validation = validateMeld(meldCards, mode);
      if (!validation.valid) continue;

      const type        = validation.type!;
      const allMelds    = teamMelds();
      const mergeTarget = tryFindMergeTarget(meldCards, type, allMelds, mode);
      const sorted      = sortMeldCards(meldCards, type);

      trackSeventyFive(meldCards);
      meldCards.forEach(c => { const i = hand.findIndex(x => x.id === c.id); if (i >= 0) hand.splice(i, 1); });

      let affectedMeldId: string;
      if (mergeTarget) {
        mergeTarget.cards     = sortMeldCards([...mergeTarget.cards, ...sorted], type);
        mergeTarget.isCanasta = mergeTarget.cards.length >= 7;
        mergeTarget.isNatural = mergeTarget.cards.every(c => !c.isWild);
        const dirty           = computeMeldHasActingWild(mergeTarget.cards, type);
        mergeTarget.everDirty = state.mode === GameMode.PROFESSIONAL ? (mergeTarget.everDirty || dirty) : dirty;
        affectedMeldId        = mergeTarget.id;
      } else {
        if (!state.melds[playerId]) state.melds[playerId] = [];
        const dirty   = computeMeldHasActingWild(sorted, type);
        const newMeld = {
          id: uuidv4(), teamId, type, cards: sorted,
          isNatural: sorted.every(c => !c.isWild), isCanasta: sorted.length >= 7, everDirty: dirty,
        };
        state.melds[playerId].push(newMeld);
        affectedMeldId = newMeld.id;
      }

      await emitMeldMove({
        type: mergeTarget ? 'TIMEOUT_ADD_TO_MELD' : 'TIMEOUT_MELD',
        playerId,
        isAuto: true,
        meldId:  affectedMeldId,
        cardIds: meldCards.map(c => c.id),
      });
    }

    // 2 — Extend existing team melds (keep ≥1 card).
    let improved = true;
    while (improved && hand.length > 1) {
      improved = false;
      for (const meld of teamMelds()) {
        for (let i = 0; i < hand.length; i++) {
          if (hand.length <= 1) break;
          if (!canAddToMeld(meld, [hand[i]], mode)) continue;
          trackSeventyFive([hand[i]]);
          const [card]   = hand.splice(i, 1);
          meld.cards     = sortMeldCards([...meld.cards, card], meld.type);
          meld.isCanasta = meld.cards.length >= 7;
          meld.isNatural = meld.cards.every(c => !c.isWild);
          const dirty    = computeMeldHasActingWild(meld.cards, meld.type);
          meld.everDirty = state.mode === GameMode.PROFESSIONAL ? (meld.everDirty || dirty) : dirty;
          improved       = true;

          await emitMeldMove({
            type: 'TIMEOUT_ADD_TO_MELD',
            playerId,
            isAuto: true,
            meldId:  meld.id,
            cardIds: [card.id],
          });
          break;
        }
      }
    }
  }

  /**
   * Finds the best set of non-overlapping melds playable from `hand`.
   * Returns an array of card groups; each group is a valid meld.
   */
  private aiFindBestMeldsFromHand(hand: Card[], mode: string): Card[][] {
    const result:    Card[][] = [];
    const available: Card[]   = [...hand];

    let found = true;
    while (found && available.length >= 3) {
      found      = false;
      const meld = this.aiPickOneMeld(available, mode);
      if (meld) {
        result.push(meld);
        meld.forEach(c => { const i = available.findIndex(x => x.id === c.id); if (i >= 0) available.splice(i, 1); });
        found = true;
      }
    }
    return result;
  }

  /**
   * Picks the single highest-scoring valid meld that can be formed from `available`.
   * Tries sets (same rank) and runs (consecutive same-suit), with up to one wild.
   */
  private aiPickOneMeld(available: Card[], mode: string): Card[] | null {
    let best: Card[] | null = null;
    const consider = (candidate: Card[]) => {
      if (candidate.length < 3) return;
      if (validateMeld(candidate, mode).valid && (!best || candidate.length > best.length)) best = candidate;
    };

    const naturals = available.filter(c => !c.isWild);
    const wilds    = available.filter(c => c.isWild);

    // Sets: group naturals by rank.
    const byRank = new Map<string, Card[]>();
    for (const c of naturals) { byRank.set(c.rank, [...(byRank.get(c.rank) ?? []), c]); }
    for (const grp of byRank.values()) {
      consider(grp);
      if (grp.length >= 2 && wilds.length > 0) consider([grp[0], grp[1], wilds[0]]);
    }

    // Runs: group naturals by suit.
    const bySuit = new Map<string, Card[]>();
    for (const c of naturals) { bySuit.set(c.suit, [...(bySuit.get(c.suit) ?? []), c]); }

    for (const grp of bySuit.values()) {
      for (const aceHigh of [false, true]) {
        const toR   = (c: Card) => aceHigh && c.rank === 'A' ? 14 : rankOrder(c.rank);
        const sorted = [...grp].sort((a, b) => toR(a) - toR(b));
        // Skip Ace-high pass if no Ace in group.
        if (aceHigh && !grp.some(c => c.rank === 'A')) continue;

        for (let i = 0; i < sorted.length; i++) {
          const seq: Card[] = [sorted[i]];
          for (let j = i + 1; j < sorted.length; j++) {
            if (toR(sorted[j]) - toR(seq[seq.length - 1]) === 1) seq.push(sorted[j]);
            else break;
          }
          consider(seq);
          if (wilds.length > 0) {
            // Wild extends the sequence.
            consider([...seq, wilds[0]]);
            // Wild fills a 1-card gap to the next sorted card.
            const nextIdx = i + seq.length;
            if (nextIdx < sorted.length && toR(sorted[nextIdx]) - toR(seq[seq.length - 1]) === 2) {
              consider([...seq, wilds[0], sorted[nextIdx]]);
            }
          }
        }
      }
    }

    return best;
  }

  /**
   * Returns the hand index of the card the AI should discard — the least
   * useful card that passes the legal-discard check.
   */
  private aiPickDiscardIndex(state: GameState, playerId: string, hand: Card[]): number {
    if (hand.length === 0) return -1;
    if (hand.length === 1) return this.pickLegalDiscardIndex(state, playerId, hand);

    const teamId    = state.players.find(p => p.userId === playerId)?.teamId ?? 1;
    const teamIds   = state.players.filter(p => p.teamId === teamId).map(p => p.userId);
    const teamMelds = teamIds.flatMap(uid => state.melds[uid] || []);
    const mode      = state.mode as string;

    // Score each card — higher score = more useful = keep it.
    const scores = hand.map((card, idx) => {
      if (card.rank === 'JOKER') return { idx, score: 1000 };
      if (card.rank === '2')     return { idx, score: 900 };

      let score = 0;

      // Extends an existing team meld.
      if (teamMelds.some(m => canAddToMeld(m, [card], mode))) score += 500;

      // Near-set: same-rank cards in hand.
      const sameRank = hand.filter((c, i) => i !== idx && c.rank === card.rank && !c.isWild).length;
      score += sameRank * 200;

      // Near-run: a card within 2 ranks and same suit exists in hand.
      const r = rankOrder(card.rank);
      const nearRun = hand.some((c, i) => i !== idx && c.suit === card.suit && !c.isWild && Math.abs(rankOrder(c.rank) - r) <= 2);
      if (nearRun) score += 150;

      // Prefer discarding high-value isolated cards.
      const pts = card.rank === 'A' ? 15
                : ['K', 'Q', 'J', '10', '9', '8'].includes(card.rank) ? 10 : 5;
      score -= pts;

      return { idx, score };
    });

    // Sort ascending so the least useful (lowest score) comes first.
    scores.sort((a, b) => a.score - b.score);

    // Return the first candidate that passes the legal-discard guard.
    for (const { idx } of scores) {
      const single = [hand[idx]];
      if (hand.length > 1) return idx; // multi-card hand: any card is legal to discard
      // Length-1 case handled above via pickLegalDiscardIndex.
    }
    return scores[0].idx;
  }

  // ── Toss ───────────────────────────────────────────────────────────────────

  private runToss(playerIds: string[], seatMap: Record<string, number>): TossResult {
    // Include jokers: Joker is the highest toss card (15 > Ace=14 > King=13 > … > 2=2)
    let tossDeck = shuffle(generateDeck(true));
    const rounds: TossRound[] = [];
    let winnerPlayerId: string | null = null;
    let winnerSeatIndex = 0;
    let roundNum = 0;

    while (!winnerPlayerId) {
      roundNum++;
      const entries: TossEntry[] = [];

      for (const pid of playerIds) {
        if (tossDeck.length === 0) tossDeck = shuffle(generateDeck(true));
        const card = tossDeck.pop()!;
        entries.push({ playerId: pid, seatIndex: seatMap[pid], card, rankValue: tossRankValue(card.rank) });
      }

      const maxRank = Math.max(...entries.map(e => e.rankValue));
      const winners = entries.filter(e => e.rankValue === maxRank);
      const isTie   = winners.length > 1;

      const round: TossRound = { round: roundNum, isTie, players: entries };
      if (!isTie) {
        round.winnerPlayerId  = winners[0].playerId;
        round.winnerSeatIndex = winners[0].seatIndex;
        round.reason          = 'HIGH_CARD';
        winnerPlayerId  = winners[0].playerId;
        winnerSeatIndex = winners[0].seatIndex;
      }
      rounds.push(round);
    }

    const finalRound = rounds[rounds.length - 1];
    return {
      rounds,
      winnerPlayerId,
      winnerSeatIndex,
      players: [...finalRound.players].sort((a, b) => a.seatIndex - b.seatIndex),
      reason: 'HIGH_CARD',
    };
  }

  /**
   * Awards a pot to the player whose hand just became empty.
   *
   * Classic:
   *   - Max 1 pot per team.
   *   - DISCARD path: pot taken, turn ends (advance turn).
   *   - PLAY_MELD / ADD_TO_MELD path: pot taken, turn continues (same phase).
   *
   * Professional:
   *   - Max 2 pots per team.
   *   - Must have at least 1 Buraco before taking the FIRST pot.
   *   - Direct mode: first pot only on-the-fly (PLAY_MELD / ADD_TO_MELD), not DISCARD.
   *   - Second pot: only on-the-fly (PLAY_MELD / ADD_TO_MELD), not DISCARD.
   */
  private tryAwardPot(
    state: GameState,
    playerId: string,
    moveType: 'PLAY_MELD' | 'ADD_TO_MELD' | 'DISCARD',
  ): { playerId: string; teamId: number; potIndex: number; cardCount: number; cardIds: string[] } | null {
    const hand = state.hands[playerId];
    if (hand.length !== 0) return null;

    const teamId      = state.players.find(p => p.userId === playerId)?.teamId ?? 1;
    const teamPotCount = (state.potCollectedByTeam ?? []).filter(id => id === teamId).length;
    const isClassic    = state.mode === GameMode.CLASSIC;
    const maxPots      = isClassic ? 1 : 2;
    if (teamPotCount >= maxPots) return null;

    const isSecondPot = teamPotCount >= 1;

    // Second pot: only on-the-fly
    if (isSecondPot && moveType === 'DISCARD') return null;

    // Professional restrictions
    if (!isClassic) {
      const teamPlayerIds = state.players.filter(p => p.teamId === teamId).map(p => p.userId);
      const teamHasBuraco = teamPlayerIds.some(uid => hasBuraco(state.melds[uid] || []));

      // Must have Buraco before first pot
      if (!isSecondPot && !teamHasBuraco) return null;

      // Direct mode: first pot only on-the-fly
      if (!isSecondPot && state.endMode === 'DIRECT' && moveType === 'DISCARD') return null;
    }

    const potIndex = state.potPiles.findIndex(p => p.length > 0);
    if (potIndex === -1) return null;

    const potCards = [...state.potPiles[potIndex]];
    hand.push(...potCards);
    state.potPiles[potIndex] = [];
    if (!state.potCollectedByTeam) state.potCollectedByTeam = [];
    state.potCollectedByTeam.push(teamId);

    if (moveType === 'DISCARD') {
      state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
      state.turnStartedAt    = Date.now();
      state.turnPhase        = 'MUST_DRAW';
    } else {
      // On-the-fly pot pickup (PLAY_MELD / ADD_TO_MELD): player continues their turn
      // with a fresh hand — reset the turn timer so they have the full duration.
      state.turnStartedAt = Date.now();
    }

    return { playerId, teamId, potIndex, cardCount: potCards.length, cardIds: potCards.map(c => c.id) };
  }

  /**
   * On every game end path (normal finish, forfeit, resign), reset the room so
   * the lobby shows it as joinable again and players are fully released.
   */
  private async resetRoomAfterGame(gameId: string, playerIds: string[]): Promise<void> {
    // Clear activeGame for all participants regardless of connection status, but leave a
    // `lastGame` breadcrumb behind. Clearing activeGame alone meant a player who was away
    // when the match ended had nothing on the server pointing at the match they just
    // played — GET /game/active reads this so they can still be shown the final result.
    await Promise.all(playerIds.flatMap(id => [
      this.redis.del(`user:${id}:activeGame`),
      this.redis.set(`user:${id}:lastGame`, gameId, 604800), // 7 days
    ]));

    // Update the room row back to EMPTY so it no longer lingers as IN_PROGRESS.
    try {
      const session = await this.prisma.gameSession.findUnique({
        where: { id: gameId },
        select: { roomId: true },
      });
      if (session?.roomId) {
        // The seat hash itself is dropped when the room goes IN_PROGRESS
        // (RoomsService.transitionToInProgress); this clears the leftover per-user
        // pointer to it so neither player is still "seated" at the finished table.
        await Promise.all([
          this.redis.del(`room:${session.roomId}:seats`),
          ...playerIds.map(id => this.redis.del(`user:${id}:seatRoom`)),
        ]);
        await this.prisma.room.update({
          where: { id: session.roomId },
          data: { status: RoomStatus.EMPTY, currentPlayers: 0, gameId: null },
        });
        this.socketService.emitToRoom('room_lobby', 'room:list_updated', {
          roomId: session.roomId,
          status: 'EMPTY',
          currentPlayers: 0,
          seatList: [],
        });
      }
    } catch {
      // Room may have already been cleaned up; non-fatal
    }
  }

  private resolveCards(hand: Card[], cardIds: string[]): Card[] {
    return cardIds.map(id => {
      const card = hand.find(c => c.id === id);
      if (!card) throw new BadRequestException(`Card ${id} not in hand`);
      return card;
    });
  }
}
