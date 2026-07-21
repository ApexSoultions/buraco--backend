import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GameMode, GameVariant, RoomStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EconomyService } from '../economy/economy.service';
import { GameEngineService } from '../game-engine/game-engine.service';
import { RedisService } from '../../common/redis/redis.service';
import { SocketService } from '../../common/socket/socket.service';

interface CreateRoomOptions {
  mode: GameMode;
  variant: GameVariant;
  turnDuration?: number;
  entryFeeCoins?: number;
  minLevel?: number;
  minPoints?: number;
  endMode?: string;
  makart?: boolean;
  targetScore?: number;
}

interface SeatEntry {
  seatIndex: number;
  teamId: number;
  userId: string;
  username: string;
  isConnected: boolean;
}

const DEFAULT_TABLES = [
  { mode: GameMode.CLASSIC,      variant: GameVariant.ONE_VS_ONE, label: 'Classic 1v1',       endMode: null,     makart: false },
  { mode: GameMode.PROFESSIONAL, variant: GameVariant.ONE_VS_ONE, label: 'Professional 1v1',  endMode: 'DIRECT', makart: false },
  { mode: GameMode.CLASSIC,      variant: GameVariant.TWO_VS_TWO, label: 'Classic 2v2',       endMode: null,     makart: false },
  { mode: GameMode.PROFESSIONAL, variant: GameVariant.TWO_VS_TWO, label: 'Professional 2v2',  endMode: 'DIRECT', makart: false },
];

@Injectable()
export class RoomsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private economyService: EconomyService,
    private gameEngine: GameEngineService,
    private redis: RedisService,
    private socketService: SocketService,
  ) {}

  async onModuleInit() {
    await this.purgeStaleCustomRooms();
    await this.purgeStaleSeats();
    await this.ensureDefaultTables();
  }

  // ── Redis key helpers ──────────────────────────────────────────────────────

  private seatsKey(roomId: string) {
    return `room:${roomId}:seats`;
  }

  private defaultTableKey(mode: GameMode, variant: GameVariant) {
    return `default:table:${mode}:${variant}`;
  }

  // ── Stale room cleanup ─────────────────────────────────────────────────────

  private async purgeStaleCustomRooms() {
    await this.prisma.room.deleteMany({
      where: {
        isDefaultTable: false,
        status: RoomStatus.EMPTY,
        currentPlayers: 0,
      },
    });
  }

  // On startup all WebSocket connections are gone, so every lobby seat hash is stale.
  private async purgeStaleSeats() {
    const lobbyRooms = await this.prisma.room.findMany({
      where: { status: { in: [RoomStatus.EMPTY, RoomStatus.WAITING, RoomStatus.READY, RoomStatus.FULL] } },
    });
    await Promise.all(
      lobbyRooms.map(async (room) => {
        await this.redis.del(this.seatsKey(room.id));
        await this.prisma.room.update({
          where: { id: room.id },
          data: { currentPlayers: 0, status: RoomStatus.EMPTY, tableOwnerUserId: null, tableOwnerUsername: null },
        });
      }),
    );
  }

  // ── Default table management ───────────────────────────────────────────────

  private async ensureDefaultTables() {
    // One instance wins the lock per 30 s to avoid stampede on multi-instance restart
    const locked = await this.redis.setNx('default:tables:init:lock', '1', 30);
    if (!locked) return;

    for (const t of DEFAULT_TABLES) {
      await this.seedDefaultTableIfMissing(t.mode, t.variant, t.label, t.endMode, t.makart);
    }
  }

  private async seedDefaultTableIfMissing(mode: GameMode, variant: GameVariant, label: string, endMode?: string | null, makart?: boolean) {
    const key = this.defaultTableKey(mode, variant);
    const existingId = await this.redis.get(key);

    if (existingId) {
      const room = await this.prisma.room.findUnique({ where: { id: existingId } });
      if (room) return;
    }

    const maxPlayers = variant === GameVariant.ONE_VS_ONE ? 2 : 4;
    const room = await this.prisma.room.create({
      data: {
        mode,
        variant,
        maxPlayers,
        turnDuration: 30,
        entryFeeCoins: 0,
        status: RoomStatus.EMPTY,
        currentPlayers: 0,
        isDefaultTable: true,
        tableLabel: label,
        endMode: endMode ?? null,
        makart: makart ?? false,
      },
    });

    await this.redis.set(key, room.id);
  }

  private async getDefaultTableIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const t of DEFAULT_TABLES) {
      const id = await this.redis.get(this.defaultTableKey(t.mode, t.variant));
      if (id) ids.push(id);
    }
    return ids;
  }

  // ── Seat count sync ────────────────────────────────────────────────────────
  // Single source of truth: count actual numeric fields in Redis seats hash.
  // This eliminates counter drift entirely — no increment/decrement anywhere.

  private async recalculateAndSyncRoom(room: any): Promise<any | null> {
    const seatsKey = this.seatsKey(room.id);
    const hash = (await this.redis.hgetall(seatsKey)) ?? {};
    const actualCount = Object.keys(hash).filter((f) => !f.includes(':')).length;

    if (actualCount === 0 && !room.isDefaultTable) {
      try {
        await this.prisma.room.delete({ where: { id: room.id } });
      } catch {
        // Already deleted concurrently
        return null;
      }
      this.socketService.emitToRoom('room_lobby', 'room:removed', { roomId: room.id });
      return null;
    }

    const newStatus =
      actualCount === 0              ? RoomStatus.EMPTY :
      actualCount >= room.maxPlayers ? RoomStatus.FULL  :
                                       RoomStatus.WAITING;

    // Ownership transfer / reset
    let ownerUpdate: {
      tableOwnerUserId: string | null;
      tableOwnerUsername: string | null;
      tableLabel: string | null;
    } | undefined;

    if (actualCount === 0 && room.isDefaultTable) {
      // Last player left a default table — reset to canonical label
      const tableConfig = DEFAULT_TABLES.find((t) => t.mode === room.mode && t.variant === room.variant);
      ownerUpdate = {
        tableOwnerUserId: null,
        tableOwnerUsername: null,
        tableLabel: tableConfig?.label ?? room.tableLabel,
      };
    } else if (actualCount > 0 && room.tableOwnerUserId) {
      // Owner may have left — check if still seated
      const ownerStillSeated = Object.entries(hash).some(
        ([f, uid]) => !f.includes(':') && uid === room.tableOwnerUserId,
      );
      if (!ownerStillSeated) {
        // Assign earliest-seated remaining player as new owner
        const remaining = Object.entries(hash)
          .filter(([f]) => !f.includes(':'))
          .sort(([a], [b]) => parseInt(a) - parseInt(b));
        if (remaining.length > 0) {
          const [newSeat, newOwnerId] = remaining[0];
          const newOwnerUsername = hash[`${newSeat}:u`] ?? '';
          ownerUpdate = {
            tableOwnerUserId: newOwnerId,
            tableOwnerUsername: newOwnerUsername,
            tableLabel: `Table of ${newOwnerUsername}`,
          };
        }
      }
    }

    let updatedRoom: any;
    try {
      updatedRoom = await this.prisma.room.update({
        where: { id: room.id },
        data: { currentPlayers: actualCount, status: newStatus, ...(ownerUpdate ?? {}) },
      });
    } catch {
      return null; // deleted concurrently
    }

    const enriched = await this.enrichRoomWithSeats(updatedRoom);
    this.socketService.emitToRoom(`room:${room.id}`, 'room:update', enriched);
    this.socketService.emitToRoom('room_lobby', 'room:list_updated', enriched);
    return updatedRoom;
  }

  // ── One-seat-per-user enforcement ──────────────────────────────────────────
  // Remove this user from every lobby room except `exceptRoomId`.
  // Called before joinRoom and switchSeat to guarantee one seat globally.

  private async evictFromAllLobbyRooms(userId: string, exceptRoomId?: string) {
    const lobbyRooms = await this.prisma.room.findMany({
      where: {
        gameId: null,
        status: { in: [RoomStatus.EMPTY, RoomStatus.WAITING, RoomStatus.READY, RoomStatus.FULL] },
        ...(exceptRoomId ? { id: { not: exceptRoomId } } : {}),
      },
    });

    for (const room of lobbyRooms) {
      const seatsKey = this.seatsKey(room.id);
      const hash = (await this.redis.hgetall(seatsKey)) ?? {};
      const userSeat = Object.entries(hash).find(([f, uid]) => !f.includes(':') && uid === userId)?.[0];
      if (!userSeat) continue;

      if (room.entryFeeCoins > 0) {
        try {
          await this.economyService.refundEntryFee(userId, room.id, room.entryFeeCoins);
        } catch { /* don't block eviction on refund failure */ }
      }

      await this.redis.hdel(seatsKey, userSeat, `${userSeat}:u`);
      await this.recalculateAndSyncRoom(room);
    }

    await this.redis.del(`user:${userId}:seatRoom`);
  }

  // ── Seat enrichment ────────────────────────────────────────────────────────

  async enrichRoomWithSeats(room: any) {
    const hash = (await this.redis.hgetall(this.seatsKey(room.id))) ?? {};

    const seatFields = Object.entries(hash).filter(([f]) => !f.includes(':'));

    // Batched lookup — a single MGET instead of one GET per occupied seat.
    const onlineFlags = await this.redis.mget(seatFields.map(([, userId]) => `online:${userId}`));

    const seats: Record<string, { userId: string; username: string; teamId: number; isConnected: boolean }> = {};
    const seatList: SeatEntry[] = [];

    seatFields.forEach(([field, userId], i) => {
      const seatIndex = parseInt(field, 10);
      const username = hash[`${field}:u`] ?? '';
      const isConnected = !!onlineFlags[i];
      const teamId = seatIndex % 2 === 0 ? 1 : 2;

      // Disconnected lobby seats are cleaned up by the periodic sweepStaleLobbySeats
      // cron job, not here — scheduling eviction from this read path caused unbounded
      // work to compound as more clients polled the room list over time.
      seats[String(seatIndex)] = { userId, username, teamId, isConnected };
      seatList.push({ seatIndex, teamId, userId, username, isConnected });
    });

    seatList.sort((a, b) => a.seatIndex - b.seatIndex);
    return { ...room, seats, seatList };
  }

  // Single instance-wide sweep for lobby seats left behind by a disconnect that
  // never triggered the gateway's grace-period eviction (e.g. server restart,
  // ungraceful crash). Runs on a fixed cadence instead of being scheduled per
  // room-list read, so cost stays bounded regardless of client polling.
  @Cron(CronExpression.EVERY_30_SECONDS)
  private async sweepStaleLobbySeats() {
    const lobbyRooms = await this.prisma.room.findMany({
      where: { status: { in: [RoomStatus.EMPTY, RoomStatus.WAITING, RoomStatus.READY, RoomStatus.FULL] } },
    });

    const staleUserIds = new Set<string>();
    for (const room of lobbyRooms) {
      const hash = (await this.redis.hgetall(this.seatsKey(room.id))) ?? {};
      const seatFields = Object.entries(hash).filter(([f]) => !f.includes(':'));
      if (seatFields.length === 0) continue;

      const onlineFlags = await this.redis.mget(seatFields.map(([, userId]) => `online:${userId}`));
      seatFields.forEach(([, userId], i) => {
        if (!onlineFlags[i]) staleUserIds.add(userId);
      });
    }

    for (const userId of staleUserIds) {
      await this.evictFromAllLobbyRooms(userId);
    }
  }

  async getRoomSeats(roomId: string): Promise<Record<string, string>> {
    return (await this.redis.hgetall(this.seatsKey(roomId))) ?? {};
  }

  // Starts the game when a room is FULL. Uses a Redis lock so only one caller wins.
  // Called from joinRoom (HTTP path) and gateway handleRoomJoin (WS path) — both are safe.
  private async maybeStartGame(room: any): Promise<string | null> {
    const lockKey = `game:starting:${room.id}`;
    const locked = await this.redis.setNx(lockKey, '1', 30);
    if (!locked) return null;

    try {
      const hash = (await this.redis.hgetall(this.seatsKey(room.id))) ?? {};
      const seatOrderedIds = Object.entries(hash)
        .filter(([f]) => !f.includes(':'))
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([, uid]) => uid)
        .filter(Boolean);

      if (seatOrderedIds.length < room.maxPlayers) {
        await this.redis.del(lockKey);
        return null;
      }

      const gameState = await this.gameEngine.startGame(room.id, room.mode, room.variant, seatOrderedIds, room.endMode, room.makart, room.turnDuration, (room as any).targetScore ?? 0);
      await this.transitionToInProgress(room.id, gameState.gameId);

      this.socketService.emitToRoom(`room:${room.id}`, 'room:update', {
        roomId: room.id,
        gameId: gameState.gameId,
        status: 'IN_PROGRESS',
      });

      return gameState.gameId;
    } catch (err) {
      await this.redis.del(lockKey);
      throw err;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async getRoomList() {
    const defaultIds = await this.getDefaultTableIds();

    const [defaultRooms, customRooms] = await Promise.all([
      this.prisma.room.findMany({ where: { id: { in: defaultIds } } }),
      this.prisma.room.findMany({
        where: {
          isDefaultTable: false,
          status: { in: [RoomStatus.WAITING, RoomStatus.FULL, RoomStatus.READY, RoomStatus.IN_PROGRESS] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const sortedDefaults = DEFAULT_TABLES
      .map((t) => defaultRooms.find((r) => r.mode === t.mode && r.variant === t.variant))
      .filter((r): r is NonNullable<typeof r> => !!r);

    return Promise.all([...sortedDefaults, ...customRooms].map((r) => this.enrichRoomWithSeats(r)));
  }

  async getRoom(roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    return this.enrichRoomWithSeats(room);
  }

  async createRoom(userId: string, opts: CreateRoomOptions) {
    const maxPlayers = opts.variant === GameVariant.ONE_VS_ONE ? 2 : 4;
    const isProfessional = opts.mode === GameMode.PROFESSIONAL;
    const room = await this.prisma.room.create({
      data: {
        mode: opts.mode,
        variant: opts.variant,
        maxPlayers,
        turnDuration: opts.turnDuration ?? 30,
        entryFeeCoins: opts.entryFeeCoins ?? 0,
        minLevel: opts.minLevel,
        minPoints: opts.minPoints,
        status: RoomStatus.EMPTY,
        currentPlayers: 0,
        isDefaultTable: false,
        endMode: isProfessional ? (opts.endMode ?? null) : null,
        makart: isProfessional ? (opts.makart ?? false) : false,
        targetScore: opts.targetScore ?? 0,
      } as any,
    });
    // Creator always gets seat 0 (team 1)
    return this.joinRoom(userId, room.id, 0);
  }

  async joinRoom(userId: string, roomId: string, requestedSeatIndex?: number) {
    // Enforce one lobby seat per user — remove any ghost seats in other rooms first
    await this.evictFromAllLobbyRooms(userId, roomId);

    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.status === RoomStatus.IN_PROGRESS) throw new BadRequestException('ROOM_NOT_WAITING');
    if (room.status === RoomStatus.FULL) throw new BadRequestException('ROOM_FULL');

    // Level / points gate
    if (room.minLevel || room.minPoints) {
      const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
      if (stats && room.minLevel && stats.level < room.minLevel) throw new ForbiddenException('LEVEL_REQUIREMENT_NOT_MET');
      if (stats && room.minPoints && stats.points < room.minPoints) throw new ForbiddenException('POINTS_REQUIREMENT_NOT_MET');
    }

    if (room.entryFeeCoins > 0) {
      await this.economyService.deductEntryFee(userId, roomId, room.entryFeeCoins);
    }

    // ── Seat assignment ──────────────────────────────────────────────────────
    const seatsKey = this.seatsKey(roomId);
    const hash = (await this.redis.hgetall(seatsKey)) ?? {};

    const occupiedEntries = Object.entries(hash).filter(([f]) => !f.includes(':'));
    const occupiedUserIds = occupiedEntries.map(([, uid]) => uid);
    const occupiedSeats = new Set(occupiedEntries.map(([f]) => parseInt(f, 10)));

    if (occupiedUserIds.includes(userId)) throw new BadRequestException('ALREADY_IN_ROOM');

    const maxSeat = room.variant === GameVariant.TWO_VS_TWO ? 3 : 1;
    const allSeats = Array.from({ length: maxSeat + 1 }, (_, i) => i);

    let assignedSeat: number;

    if (requestedSeatIndex !== undefined) {
      if (requestedSeatIndex < 0 || requestedSeatIndex > maxSeat) throw new BadRequestException('INVALID_SEAT_INDEX');
      if (occupiedSeats.has(requestedSeatIndex)) throw new BadRequestException('SEAT_TAKEN');
      assignedSeat = requestedSeatIndex;
    } else {
      const available = allSeats.find((s) => !occupiedSeats.has(s));
      if (available === undefined) throw new BadRequestException('ROOM_FULL');
      assignedSeat = available;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    const username = user?.username ?? '';

    await this.redis.hset(seatsKey, String(assignedSeat), userId);
    await this.redis.hset(seatsKey, `${assignedSeat}:u`, username);
    await this.redis.expire(seatsKey, 86400);

    // Mark user online now so isConnected=true is returned immediately on HTTP join,
    // even before the WebSocket room:join event fires. WS ping refreshes this every 30 s.
    await this.redis.set(`online:${userId}`, '1', 60);

    // Track which room this user is seated in (used for disconnect cleanup)
    await this.redis.set(`user:${userId}:seatRoom`, roomId, 86400);

    // First player to sit becomes the table owner
    if (occupiedEntries.length === 0) {
      await this.prisma.room.update({
        where: { id: roomId },
        data: {
          tableOwnerUserId: userId,
          tableOwnerUsername: username,
          tableLabel: `Table of ${username}`,
        },
      });
    }

    // Sync DB count from actual seat state
    const updatedRoom = await this.recalculateAndSyncRoom(room) ?? room;

    // Auto-start game when the last seat is filled — no WS event required
    if (updatedRoom.status === RoomStatus.FULL) {
      await this.maybeStartGame(updatedRoom).catch(() => {});
    }

    // Re-fetch so the HTTP response reflects gameId + IN_PROGRESS when game just started
    const finalRoom = await this.prisma.room.findUnique({ where: { id: roomId } }) ?? updatedRoom;
    const teamId = assignedSeat % 2 === 0 ? 1 : 2;
    return { ...finalRoom, seatIndex: assignedSeat, teamId };
  }

  async switchSeat(userId: string, roomId: string, requestedSeatIndex: number) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.status === RoomStatus.IN_PROGRESS) throw new BadRequestException('ROOM_NOT_WAITING');

    const seatsKey = this.seatsKey(roomId);
    const hash = (await this.redis.hgetall(seatsKey)) ?? {};

    const occupiedEntries = Object.entries(hash).filter(([f]) => !f.includes(':'));
    const currentSeatEntry = occupiedEntries.find(([, uid]) => uid === userId);
    if (!currentSeatEntry) throw new BadRequestException('NOT_IN_ROOM');

    const currentSeat = currentSeatEntry[0];
    const maxSeat = room.variant === GameVariant.TWO_VS_TWO ? 3 : 1;

    if (requestedSeatIndex < 0 || requestedSeatIndex > maxSeat) throw new BadRequestException('INVALID_SEAT_INDEX');
    if (String(requestedSeatIndex) === currentSeat) throw new BadRequestException('ALREADY_IN_SEAT');

    const occupiedSeats = new Set(occupiedEntries.map(([f]) => parseInt(f, 10)));
    if (occupiedSeats.has(requestedSeatIndex)) throw new BadRequestException('SEAT_TAKEN');

    // Clean up any ghost seats in other rooms
    await this.evictFromAllLobbyRooms(userId, roomId);

    const username = hash[`${currentSeat}:u`] ?? '';

    // Remove old seat, write new seat (Redis is single-threaded — effectively atomic)
    await this.redis.hdel(seatsKey, currentSeat, `${currentSeat}:u`);
    await this.redis.hset(seatsKey, String(requestedSeatIndex), userId);
    await this.redis.hset(seatsKey, `${requestedSeatIndex}:u`, username);
    await this.redis.expire(seatsKey, 86400);

    const enriched = await this.enrichRoomWithSeats(room);
    this.socketService.emitToRoom(`room:${roomId}`, 'room:update', enriched);
    this.socketService.emitToRoom('room_lobby', 'room:list_updated', enriched);

    const teamId = requestedSeatIndex % 2 === 0 ? 1 : 2;
    return { ...enriched, seatIndex: requestedSeatIndex, teamId };
  }

  async leaveRoom(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    if (room.entryFeeCoins > 0 && room.status !== RoomStatus.IN_PROGRESS) {
      await this.economyService.refundEntryFee(userId, roomId, room.entryFeeCoins);
    }

    const seatsKey = this.seatsKey(roomId);
    const hash = (await this.redis.hgetall(seatsKey)) ?? {};
    const userSeat = Object.entries(hash).find(([f, uid]) => !f.includes(':') && uid === userId)?.[0];
    if (userSeat) {
      await this.redis.hdel(seatsKey, userSeat, `${userSeat}:u`);
    }

    await this.redis.del(`user:${userId}:seatRoom`);

    // Recalculate from actual seat count — no drift possible
    const updatedRoom = await this.recalculateAndSyncRoom(room);
    return updatedRoom ?? { ...room, currentPlayers: 0, status: RoomStatus.EMPTY };
  }

  async leaveAllLobby(userId: string) {
    await this.evictFromAllLobbyRooms(userId);
    return { success: true };
  }

  // Called by the gateway after a disconnect grace period
  async handleDisconnectSeat(userId: string) {
    // evictFromAllLobbyRooms scans every pre-game room so no room is missed
    await this.evictFromAllLobbyRooms(userId);
  }

  async transitionToInProgress(roomId: string, gameId: string) {
    await this.redis.del(this.seatsKey(roomId));

    const updatedRoom = await this.prisma.room.update({
      where: { id: roomId },
      data: { status: RoomStatus.IN_PROGRESS, gameId },
    });

    if (updatedRoom.isDefaultTable) {
      const tableConfig = DEFAULT_TABLES.find(
        (t) => t.mode === updatedRoom.mode && t.variant === updatedRoom.variant,
      );
      const label = tableConfig?.label ?? updatedRoom.tableLabel ?? '';
      await this.redis.del(this.defaultTableKey(updatedRoom.mode, updatedRoom.variant));
      await this.seedDefaultTableIfMissing(updatedRoom.mode, updatedRoom.variant, label, tableConfig?.endMode, tableConfig?.makart);
    }

    const enriched = await this.enrichRoomWithSeats(updatedRoom);
    this.socketService.emitToRoom('room_lobby', 'room:list_updated', enriched);

    return updatedRoom;
  }

  async resetRoom(roomId: string) {
    return this.prisma.room.update({
      where: { id: roomId },
      data: { status: RoomStatus.EMPTY, currentPlayers: 0, gameId: null },
    });
  }
}
