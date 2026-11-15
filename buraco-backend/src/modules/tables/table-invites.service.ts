import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { GameVariant, NotificationType, RoomStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SocketService } from '../../common/socket/socket.service';
import { FriendsService } from '../friends/friends.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RoomsService } from '../rooms/rooms.service';

/** An invite stays open this long; the friend's popup counts down from it. */
export const ROOM_INVITE_TTL_SECONDS = 120;

export interface RoomInvite {
  id: string;
  roomId: string;
  fromUserId: string;
  fromUsername: string;
  fromAvatarUrl: string | null;
  toUserId: string;
  /** The chair the inviter tapped; null = any free chair. */
  seatIndex: number | null;
  mode: string;
  variant: string;
  tableLabel: string | null;
  entryFeeCoins: number;
  createdAt: string;
  expiresAt: string;
}

const LOBBY_STATUSES: RoomStatus[] = [RoomStatus.EMPTY, RoomStatus.WAITING, RoomStatus.READY];

/**
 * "Tap an empty chair, invite a friend". The invite lives only in Redis (it means nothing
 * after two minutes), reaches the friend as a live `room:invite` event plus a MATCH_INVITE
 * notification, and accepting it is an ordinary joinRoom on that chair.
 */
@Injectable()
export class TableInvitesService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private socket: SocketService,
    private rooms: RoomsService,
    private friends: FriendsService,
    private notifications: NotificationsService,
  ) {}

  private inviteKey(id: string) { return `room:invite:${id}`; }
  private inboxKey(userId: string) { return `room:invites:to:${userId}`; }
  private pairKey(from: string, to: string, roomId: string) { return `room:invite:pair:${roomId}:${from}:${to}`; }

  private seatedUsers(hash: Record<string, string>): Map<number, string> {
    const out = new Map<number, string>();
    for (const [f, uid] of Object.entries(hash)) if (!f.includes(':')) out.set(parseInt(f, 10), uid);
    return out;
  }

  async sendInvite(fromUserId: string, body: { roomId?: string; friendId?: string; seatIndex?: number | null }) {
    const roomId = body?.roomId;
    const toUserId = body?.friendId;
    if (!roomId || !toUserId) throw new BadRequestException('roomId and friendId are required');
    if (toUserId === fromUserId) throw new BadRequestException('CANNOT_INVITE_SELF');

    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (!LOBBY_STATUSES.includes(room.status)) throw new BadRequestException('ROOM_NOT_WAITING');

    const seated = this.seatedUsers(await this.rooms.getRoomSeats(roomId));
    const seatedIds = [...seated.values()];
    if (!seatedIds.includes(fromUserId)) throw new ForbiddenException('NOT_IN_ROOM');
    if (seatedIds.includes(toUserId)) throw new BadRequestException('ALREADY_IN_ROOM');
    if (seated.size >= room.maxPlayers) throw new BadRequestException('ROOM_FULL');

    const maxSeat = room.variant === GameVariant.TWO_VS_TWO ? 3 : 1;
    let seatIndex: number | null = null;
    if (body.seatIndex !== undefined && body.seatIndex !== null) {
      seatIndex = Number(body.seatIndex);
      if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > maxSeat) throw new BadRequestException('INVALID_SEAT_INDEX');
      if (seated.has(seatIndex)) throw new BadRequestException('SEAT_TAKEN');
    }

    if (!(await this.friends.isFriend(fromUserId, toUserId))) throw new ForbiddenException('NOT_FRIENDS');
    if (await this.friends.isBlocked(fromUserId, toUserId)) throw new ForbiddenException('USER_BLOCKED');

    // One open invite per friend per table: tapping the chair again does not spam them.
    const pair = this.pairKey(fromUserId, toUserId, roomId);
    if (await this.redis.get(pair)) throw new BadRequestException('INVITE_ALREADY_SENT');

    const from = await this.prisma.user.findUnique({ where: { id: fromUserId }, select: { username: true, avatarUrl: true } });
    const now = Date.now();
    const invite: RoomInvite = {
      id: uuidv4(),
      roomId,
      fromUserId,
      fromUsername: from?.username ?? '',
      fromAvatarUrl: from?.avatarUrl ?? null,
      toUserId,
      seatIndex,
      mode: room.mode,
      variant: room.variant,
      tableLabel: room.tableLabel ?? null,
      entryFeeCoins: room.entryFeeCoins,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ROOM_INVITE_TTL_SECONDS * 1000).toISOString(),
    };

    await this.redis.setJson(this.inviteKey(invite.id), invite, ROOM_INVITE_TTL_SECONDS);
    await this.redis.set(pair, invite.id, ROOM_INVITE_TTL_SECONDS);
    await this.redis.sadd(this.inboxKey(toUserId), invite.id);
    await this.redis.expire(this.inboxKey(toUserId), ROOM_INVITE_TTL_SECONDS);

    this.socket.emitToUsers([toUserId], 'room:invite', invite);
    await this.notifications.notifySafely(toUserId, NotificationType.MATCH_INVITE, 'Table invite',
      `${invite.fromUsername || 'A friend'} invites you to their table`,
      { inviteId: invite.id, roomId, seatIndex, fromUserId, fromUsername: invite.fromUsername,
        fromAvatarUrl: invite.fromAvatarUrl, expiresAt: invite.expiresAt });

    return invite;
  }

  /** Open invites for this player (expired ones drop out on their own). */
  async getMyInvites(userId: string): Promise<RoomInvite[]> {
    const ids = await this.redis.smembers(this.inboxKey(userId));
    const out: RoomInvite[] = [];
    for (const id of ids) {
      const inv = await this.redis.getJson<RoomInvite>(this.inviteKey(id));
      if (inv && Date.parse(inv.expiresAt) > Date.now()) out.push(inv);
      else await this.redis.srem(this.inboxKey(userId), id);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async takeInvite(userId: string, inviteId: string): Promise<RoomInvite> {
    const inv = await this.redis.getJson<RoomInvite>(this.inviteKey(inviteId));
    if (!inv) throw new NotFoundException('INVITE_EXPIRED');
    if (inv.toUserId !== userId) throw new ForbiddenException('NOT_YOUR_INVITE');
    await this.redis.del(this.inviteKey(inviteId));
    await this.redis.del(this.pairKey(inv.fromUserId, inv.toUserId, inv.roomId));
    await this.redis.srem(this.inboxKey(userId), inviteId);
    return inv;
  }

  private async answer(inv: RoomInvite, accepted: boolean, reason?: string) {
    const me = await this.prisma.user.findUnique({ where: { id: inv.toUserId }, select: { username: true } });
    this.socket.emitToUsers([inv.fromUserId], 'room:invite_answer', {
      inviteId: inv.id, roomId: inv.roomId, toUserId: inv.toUserId, toUsername: me?.username ?? '',
      accepted, ...(reason ? { reason } : {}),
    });
  }

  /** Sit down on the invited chair (or any free one if it was taken meanwhile). */
  async accept(userId: string, inviteId: string) {
    const inv = await this.takeInvite(userId, inviteId);
    try {
      let joined: any;
      try {
        joined = await this.rooms.joinRoom(userId, inv.roomId, inv.seatIndex ?? undefined);
      } catch (err) {
        if (inv.seatIndex === null || (err as Error).message !== 'SEAT_TAKEN') throw err;
        joined = await this.rooms.joinRoom(userId, inv.roomId);
      }
      await this.answer(inv, true);
      return joined;
    } catch (err) {
      await this.answer(inv, false, (err as Error).message);
      throw err;
    }
  }

  async decline(userId: string, inviteId: string) {
    const inv = await this.takeInvite(userId, inviteId);
    await this.answer(inv, false, 'DECLINED');
    return { success: true };
  }
}
