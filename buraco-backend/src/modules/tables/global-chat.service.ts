import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SocketService } from '../../common/socket/socket.service';
import { SlidingWindowLimiter } from '../../common/rate-limit/sliding-window';

export const GLOBAL_CHAT_MAX_TEXT = 200;
/** How many messages are kept (and shown when the chat opens). */
export const GLOBAL_CHAT_HISTORY = 50;
/** Socket room of the table list: clients join it with `room:subscribe`. */
export const GLOBAL_CHAT_ROOM = 'room_lobby';
const KEY = 'lobby:chat';
const REPORT_REASONS = ['SPAM', 'ABUSE', 'INAPPROPRIATE', 'CHEATING', 'OTHER'];

export interface GlobalChatMessage {
  id: string;
  senderId: string;
  username: string;
  avatarUrl: string | null;
  kind: 'TEXT' | 'EMOJI';
  text: string;
  sentAt: string;
}

/**
 * Global Chat on the table list (Figma "When click Chat button"): one public room for every
 * player looking at the tables. The last 50 messages live in Redis and new ones go to the
 * table-list socket room as `lobby:chat:message`. "Clear" hides the history for me only;
 * players I blocked are hidden from my history (the app hides their live messages too).
 */
@Injectable()
export class GlobalChatService {
  private readonly limiter = new SlidingWindowLimiter(
    parseInt(process.env.THROTTLE_GLOBAL_CHAT_PER_10S ?? '5', 10) || 5,
    10_000,
  );

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private socket: SocketService,
  ) {}

  private clearedKey(userId: string) { return `lobby:chat:cleared:${userId}`; }

  async send(userId: string, body: { kind?: string; text?: string }) {
    const kind = (body?.kind ?? 'TEXT').toUpperCase();
    if (kind !== 'TEXT' && kind !== 'EMOJI') throw new BadRequestException('INVALID_KIND');
    const text = (body?.text ?? '').trim();
    if (!text) throw new BadRequestException('EMPTY_MESSAGE');
    if (text.length > (kind === 'TEXT' ? GLOBAL_CHAT_MAX_TEXT : 40)) throw new BadRequestException('MESSAGE_TOO_LONG');
    if (!this.limiter.tryAcquire(userId)) throw new HttpException('CHAT_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true, avatarUrl: true } });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    const msg: GlobalChatMessage = {
      id: uuidv4(), senderId: userId, username: user.username, avatarUrl: user.avatarUrl ?? null,
      kind: kind as GlobalChatMessage['kind'], text, sentAt: new Date().toISOString(),
    };
    const list = (await this.redis.getJson<GlobalChatMessage[]>(KEY)) ?? [];
    list.push(msg);
    await this.redis.setJson(KEY, list.slice(-GLOBAL_CHAT_HISTORY), 7 * 86400);
    this.socket.emitToRoom(GLOBAL_CHAT_ROOM, 'lobby:chat:message', msg);
    return msg;
  }

  async history(userId: string) {
    const list = (await this.redis.getJson<GlobalChatMessage[]>(KEY)) ?? [];
    const cleared = await this.redis.get(this.clearedKey(userId));
    const blocks = await this.prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } });
    const hidden = new Set(blocks.map((b) => b.blockedId));
    const messages = list.filter((m) => !hidden.has(m.senderId) && (!cleared || m.sentAt > cleared));
    return { messages, blockedIds: [...hidden] };
  }

  /** "Clear": hide everything sent until now, for me only. */
  async clear(userId: string) {
    await this.redis.set(this.clearedKey(userId), new Date().toISOString(), 7 * 86400);
    return { success: true };
  }

  /** Report a player for what they wrote in Global Chat (saved with their recent messages). */
  async report(userId: string, body: { userId?: string; reason?: string }) {
    const reportedUserId = body?.userId;
    const reason = (body?.reason ?? 'ABUSE').toUpperCase();
    if (!reportedUserId) throw new BadRequestException('userId is required');
    if (reportedUserId === userId) throw new BadRequestException('CANNOT_REPORT_SELF');
    if (!REPORT_REASONS.includes(reason)) throw new BadRequestException('INVALID_REASON');

    const list = (await this.redis.getJson<GlobalChatMessage[]>(KEY)) ?? [];
    const theirs = list.filter((m) => m.senderId === reportedUserId).slice(-10).map((m) => m.text);
    if (theirs.length === 0) throw new BadRequestException('NO_MESSAGES_FROM_USER');
    const details = `Global chat:\n${theirs.join('\n')}`.slice(0, 2000);
    await this.prisma.report.create({ data: { reporterId: userId, reportedUserId, reason: reason as any, details } });
    return { success: true };
  }
}
