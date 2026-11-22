import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SocketService } from '../../common/socket/socket.service';
import { S3Service } from '../../common/s3/s3.service';
import { isVoiceChatActive } from '../../common/premium/premium';
import { SlidingWindowLimiter } from '../../common/rate-limit/sliding-window';
import { GameEngineService, GameState } from '../game-engine/game-engine.service';

export type TableChatKind = 'TEXT' | 'EMOJI' | 'QUICK' | 'VOICE';
const KINDS: TableChatKind[] = ['TEXT', 'EMOJI', 'QUICK'];

export const TABLE_CHAT_MAX_TEXT = 200;
/** How many messages a player sees when they open (or reopen) the chat. */
export const TABLE_CHAT_HISTORY = 50;
export const TABLE_CHAT_MAX_VOICE_SECONDS = 30;
const REPORT_REASONS = ['SPAM', 'ABUSE', 'INAPPROPRIATE', 'CHEATING', 'OTHER'];

export interface TableChatMessage {
  id: string;
  gameId: string;
  senderId: string;
  username: string;
  teamId: number;
  kind: TableChatKind;
  /** Text, or the emoji / quick-phrase code for EMOJI and QUICK. Empty for VOICE. */
  text: string;
  /** VOICE only: stored as the private S3 key; readers get a signed link. */
  voiceUrl?: string | null;
  duration?: number | null;
  sentAt: string;
}

/**
 * Chat for the players of one match. It lives as long as the match does in Redis (and the
 * two hours after it ends, so players can talk on the score board), sent to the
 * `game:<id>` socket room as `table:chat:message`. Voice clips need the Voice chat
 * subscription.
 */
@Injectable()
export class TableChatService {
  private readonly limiter = new SlidingWindowLimiter(
    parseInt(process.env.THROTTLE_CHAT_PER_10S ?? '10', 10) || 10,
    10_000,
  );

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private socket: SocketService,
    private s3: S3Service,
    private gameEngine: GameEngineService,
  ) {}

  private chatKey(gameId: string) { return `game:${gameId}:chat`; }

  /** The match state, and the asking player's seat in it; throws for strangers. */
  private async seatOf(gameId: string, userId: string): Promise<{ state: GameState; teamId: number }> {
    if (!gameId) throw new BadRequestException('gameId is required');
    const state = await this.redis.getJson<GameState>(this.gameEngine.stateKey(gameId));
    if (!state) throw new NotFoundException('GAME_NOT_FOUND');
    const me = state.players.find((p) => p.userId === userId);
    if (!me) throw new ForbiddenException('NOT_AT_TABLE');
    return { state, teamId: me.teamId };
  }

  /** The Create Table "Text Chat" / "Voice Chat" switches of the table this match is at. */
  async chatSwitches(gameId: string): Promise<{ textChat: boolean; voiceChat: boolean }> {
    const room = await this.prisma.room.findFirst({ where: { gameId }, select: { textChat: true, voiceChat: true } });
    return { textChat: room?.textChat ?? true, voiceChat: room?.voiceChat ?? true };
  }

  private async append(msg: TableChatMessage) {
    const key = this.chatKey(msg.gameId);
    const list = (await this.redis.getJson<TableChatMessage[]>(key)) ?? [];
    list.push(msg);
    await this.redis.setJson(key, list.slice(-TABLE_CHAT_HISTORY), 86400);
    const [out] = await this.withVoiceLinks([msg]);
    this.socket.emitToRoom(`game:${msg.gameId}`, 'table:chat:message', out);
    return out;
  }

  private rateLimit(userId: string) {
    if (!this.limiter.tryAcquire(userId)) throw new HttpException('CHAT_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
  }

  async send(gameId: string, userId: string, body: { kind?: string; text?: string }) {
    const kind = (body?.kind ?? 'TEXT').toUpperCase() as TableChatKind;
    if (!KINDS.includes(kind)) throw new BadRequestException('INVALID_KIND');
    const text = (body?.text ?? '').trim();
    if (!text) throw new BadRequestException('EMPTY_MESSAGE');
    if (text.length > (kind === 'TEXT' ? TABLE_CHAT_MAX_TEXT : 40)) throw new BadRequestException('MESSAGE_TOO_LONG');

    const { state, teamId } = await this.seatOf(gameId, userId);
    if (!(await this.chatSwitches(gameId)).textChat) throw new ForbiddenException('TEXT_CHAT_OFF');
    this.rateLimit(userId);
    return this.append({
      id: uuidv4(), gameId, senderId: userId, username: state.usernames?.[userId] ?? '', teamId,
      kind, text, voiceUrl: null, duration: null, sentAt: new Date().toISOString(),
    });
  }

  /** Called before the upload, so strangers and non-subscribers cannot fill the bucket. */
  async assertCanSendVoice(gameId: string, userId: string) {
    await this.seatOf(gameId, userId);
    if (!(await this.chatSwitches(gameId)).voiceChat) throw new ForbiddenException('VOICE_CHAT_OFF');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { voiceChatExpiry: true } });
    if (!isVoiceChatActive(user)) throw new ForbiddenException('VOICE_CHAT_REQUIRED');
    this.rateLimit(userId);
  }

  async sendVoice(gameId: string, userId: string, voiceKey: string, duration: number) {
    const { state, teamId } = await this.seatOf(gameId, userId);
    return this.append({
      id: uuidv4(), gameId, senderId: userId, username: state.usernames?.[userId] ?? '', teamId,
      kind: 'VOICE', text: '', voiceUrl: voiceKey, duration, sentAt: new Date().toISOString(),
    });
  }

  async history(gameId: string, userId: string) {
    await this.seatOf(gameId, userId);
    const list = (await this.redis.getJson<TableChatMessage[]>(this.chatKey(gameId))) ?? [];
    // The switches tell the client whether to show the chat / mic buttons at all.
    return { ...(await this.chatSwitches(gameId)), messages: await this.withVoiceLinks(list) };
  }

  /**
   * Report a player for what they wrote at this table. Saved as an ordinary player report
   * (admin "reports" list) with their recent table messages as the details.
   */
  async report(gameId: string, userId: string, body: { userId?: string; reason?: string }) {
    const reportedUserId = body?.userId;
    const reason = (body?.reason ?? 'ABUSE').toUpperCase();
    if (!reportedUserId) throw new BadRequestException('userId is required');
    if (reportedUserId === userId) throw new BadRequestException('CANNOT_REPORT_SELF');
    if (!REPORT_REASONS.includes(reason)) throw new BadRequestException('INVALID_REASON');
    const { state } = await this.seatOf(gameId, userId);
    if (!state.players.some((p) => p.userId === reportedUserId)) throw new BadRequestException('NOT_AT_TABLE');

    const list = (await this.redis.getJson<TableChatMessage[]>(this.chatKey(gameId))) ?? [];
    const theirs = list.filter((m) => m.senderId === reportedUserId).slice(-10)
      .map((m) => (m.kind === 'VOICE' ? `[voice ${m.duration ?? 0}s]` : m.text));
    const details = `Table chat, match ${gameId}:\n${theirs.join('\n') || '(no messages)'}`.slice(0, 2000);

    await this.prisma.report.create({
      data: { reporterId: userId, reportedUserId, reason: reason as any, details, source: 'TABLE_CHAT' },
    });
    return { success: true };
  }

  private async withVoiceLinks(messages: TableChatMessage[]): Promise<TableChatMessage[]> {
    const keys = messages.map((m) => m.voiceUrl).filter((v): v is string => !!v);
    if (keys.length === 0) return messages;
    const links = await this.s3.signUrls(keys);
    return messages.map((m) => (m.voiceUrl ? { ...m, voiceUrl: links.get(m.voiceUrl) ?? m.voiceUrl } : m));
  }
}
