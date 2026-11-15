import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GameStatus, RoomStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SocketService } from '../../common/socket/socket.service';
import { GameEngineService, GameState } from '../game-engine/game-engine.service';
import { RoomsService } from '../rooms/rooms.service';

/** Everyone has this long after the first "Rematch" tap to tap it too. */
export const REMATCH_WINDOW_SECONDS = 60;

export type RematchStatus = 'OPEN' | 'STARTING' | 'STARTED' | 'CANCELLED';

export interface RematchInfo {
  gameId: string;
  status: RematchStatus;
  acceptedUserIds: string[];
  neededCount: number;
  expiresAt: string;
  /** Set when STARTED: the new table and match the players move to. */
  roomId?: string;
  newGameId?: string;
  /** Set when CANCELLED: DECLINED, EXPIRED, or the join error (e.g. not enough coins). */
  reason?: string;
  cancelledBy?: string;
}

/**
 * "Rematch" on the score board. Each player of the finished match taps it; when all of
 * them have, the server opens a new table with the same settings, seats everyone on the
 * same chair and deals. Events go to the old `game:<id>` room, where every client still is:
 * `game:rematch:update`, `game:rematch:start` ({ roomId, newGameId }), `game:rematch:cancelled`.
 */
@Injectable()
export class RematchService {
  private readonly logger = new Logger(RematchService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private socket: SocketService,
    private gameEngine: GameEngineService,
    private rooms: RoomsService,
  ) {}

  private metaKey(gameId: string) { return `game:${gameId}:rematch`; }
  private votesKey(gameId: string) { return `game:${gameId}:rematch:votes`; }
  private lockKey(gameId: string) { return `game:${gameId}:rematch:lock`; }

  private async finishedState(gameId: string, userId: string): Promise<GameState> {
    const state = await this.redis.getJson<GameState>(this.gameEngine.stateKey(gameId));
    if (!state) throw new NotFoundException('GAME_NOT_FOUND');
    if (!state.players.some((p) => p.userId === userId)) throw new ForbiddenException('NOT_AT_TABLE');
    if (state.status !== GameStatus.COMPLETED) throw new BadRequestException('GAME_NOT_FINISHED');
    return state;
  }

  private async meta(gameId: string) {
    return this.redis.getJson<Omit<RematchInfo, 'acceptedUserIds' | 'neededCount'>>(this.metaKey(gameId));
  }

  private async info(gameId: string, state: GameState): Promise<RematchInfo | null> {
    const meta = await this.meta(gameId);
    if (!meta) return null;
    const accepted = await this.redis.smembers(this.votesKey(gameId));
    const expired = meta.status === 'OPEN' && Date.parse(meta.expiresAt) <= Date.now();
    return {
      ...meta,
      ...(expired ? { status: 'CANCELLED' as const, reason: 'EXPIRED' } : {}),
      acceptedUserIds: accepted,
      neededCount: state.players.length,
    };
  }

  async get(gameId: string, userId: string) {
    const state = await this.finishedState(gameId, userId);
    return (await this.info(gameId, state)) ?? {
      gameId, status: 'OPEN', acceptedUserIds: [], neededCount: state.players.length, expiresAt: null,
    };
  }

  async request(gameId: string, userId: string): Promise<RematchInfo> {
    const state = await this.finishedState(gameId, userId);

    let current = await this.info(gameId, state);
    if (current && current.status !== 'OPEN' && !(current.status === 'CANCELLED' && current.reason === 'EXPIRED')) {
      if (current.status === 'CANCELLED') throw new BadRequestException('REMATCH_CANCELLED');
      return current; // already starting / started: nothing to add
    }
    if (!current || current.status === 'CANCELLED') {
      // First tap (or the last window ran out): open a fresh window.
      await this.redis.del(this.votesKey(gameId));
      await this.redis.setJson(this.metaKey(gameId), {
        gameId, status: 'OPEN', expiresAt: new Date(Date.now() + REMATCH_WINDOW_SECONDS * 1000).toISOString(),
      }, 600);
    }

    await this.redis.sadd(this.votesKey(gameId), userId);
    await this.redis.expire(this.votesKey(gameId), 600);
    current = (await this.info(gameId, state))!;

    this.socket.emitToRoom(`game:${gameId}`, 'game:rematch:update', {
      ...current, requestedBy: userId, requestedByUsername: state.usernames?.[userId] ?? '',
    });

    const everyone = state.players.every((p) => current!.acceptedUserIds.includes(p.userId));
    if (everyone && (await this.redis.setNx(this.lockKey(gameId), '1', 60))) {
      return this.start(gameId, state, current);
    }
    return current;
  }

  async decline(gameId: string, userId: string) {
    const state = await this.finishedState(gameId, userId);
    const current = await this.info(gameId, state);
    if (current && (current.status === 'STARTING' || current.status === 'STARTED')) return current;
    return this.cancel(gameId, state, 'DECLINED', userId);
  }

  private async cancel(gameId: string, state: GameState, reason: string, userId?: string): Promise<RematchInfo> {
    const prev = await this.meta(gameId);
    await this.redis.setJson(this.metaKey(gameId), {
      gameId, status: 'CANCELLED', reason, cancelledBy: userId,
      expiresAt: prev?.expiresAt ?? new Date().toISOString(),
    }, 600);
    const info = (await this.info(gameId, state))!;
    this.socket.emitToRoom(`game:${gameId}`, 'game:rematch:cancelled', {
      ...info, cancelledByUsername: userId ? state.usernames?.[userId] ?? '' : undefined,
    });
    return info;
  }

  /** Same table settings, same chairs; the last join deals (RoomsService.joinRoom). */
  private async start(gameId: string, state: GameState, current: RematchInfo): Promise<RematchInfo> {
    await this.redis.setJson(this.metaKey(gameId), { gameId, status: 'STARTING', expiresAt: current.expiresAt }, 600);

    const oldRoom = await this.prisma.room.findFirst({ where: { gameId } });
    const room = await this.prisma.room.create({
      data: {
        mode: state.mode,
        variant: state.variant,
        maxPlayers: state.players.length,
        turnDuration: state.turnDuration ?? 30,
        entryFeeCoins: oldRoom?.entryFeeCoins ?? 0,
        status: RoomStatus.EMPTY,
        currentPlayers: 0,
        isDefaultTable: false,
        endMode: oldRoom?.endMode ?? (state.mode === 'PROFESSIONAL' ? state.endMode : null),
        makart: state.makart ?? false,
        targetScore: state.targetScore ?? 0,
        // Same private table: keep the password and the chat switches.
        passwordHash: oldRoom?.passwordHash ?? null,
        textChat: oldRoom?.textChat ?? true,
        voiceChat: oldRoom?.voiceChat ?? true,
      } as any,
    });

    const seatOrder = [...state.players].sort(
      (a, b) => (state.seatMap?.[a.userId] ?? 0) - (state.seatMap?.[b.userId] ?? 0),
    );
    const seated: string[] = [];
    try {
      for (const p of seatOrder) {
        await this.rooms.joinRoom(p.userId, room.id, state.seatMap?.[p.userId], { trusted: true });
        seated.push(p.userId);
      }
    } catch (err) {
      const reason = (err as Error).message || 'REMATCH_FAILED';
      const failedUser = seatOrder[seated.length]?.userId;
      this.logger.warn(`Rematch of ${gameId} failed at ${failedUser}: ${reason}`);
      for (const uid of seated) await this.rooms.leaveRoom(uid, room.id).catch(() => undefined);
      await this.redis.del(this.lockKey(gameId));
      return this.cancel(gameId, state, reason, failedUser);
    }

    const fresh = await this.prisma.room.findUnique({ where: { id: room.id } });
    const newGameId = fresh?.gameId ?? undefined;
    await this.redis.setJson(this.metaKey(gameId), {
      gameId, status: 'STARTED', expiresAt: current.expiresAt, roomId: room.id, newGameId,
    }, 600);
    const info = (await this.info(gameId, state))!;
    this.socket.emitToRoom(`game:${gameId}`, 'game:rematch:start', info);
    return info;
  }
}
