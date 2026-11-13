import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MissionRequirement, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { onlineSet } from '../../common/presence/presence';
import { RedisService } from '../../common/redis/redis.service';
import { S3Service } from '../../common/s3/s3.service';
import { SocketService } from '../../common/socket/socket.service';
import { FriendsService } from '../friends/friends.service';
import { MissionsService } from '../missions/missions.service';
import { ReportChatDto } from './dto/report-chat.dto';

export const MAX_TEXT_LENGTH = 1000;
export const MAX_VOICE_SECONDS = 120;

const SENDER_SELECT = { id: true, username: true, avatarUrl: true } as const;
// The other player in a 1-to-1 chat: also when they were last seen (online is added from Redis).
const PARTICIPANT_SELECT = { ...SENDER_SELECT, lastSeenAt: true } as const;

@Injectable()
export class MessagingService {
  constructor(
    private prisma: PrismaService,
    private friendsService: FriendsService,
    private socketService: SocketService,
    private s3: S3Service,
    private missions: MissionsService,
    private redis?: RedisService,
  ) {}

  async getOrCreateDirectConversation(userId1: string, userId2: string) {
    const blocked = await this.friendsService.isBlocked(userId1, userId2);
    if (blocked) throw new ForbiddenException('USER_BLOCKED');

    const existing = await this.prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        members: { some: { userId: userId1 } },
        AND: [{ members: { some: { userId: userId2 } } }],
      },
    });

    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.create({ data: { type: 'DIRECT' } });
      await tx.conversationMember.createMany({
        data: [{ conversationId: conv.id, userId: userId1 }, { conversationId: conv.id, userId: userId2 }],
      });
      return conv;
    });
  }

  /** Open (or reuse) the 1-to-1 chat with another player, shaped like a getConversations() row. */
  async startDirectConversation(userId: string, otherUserId: string) {
    if (userId === otherUserId) throw new BadRequestException('Cannot start a chat with yourself');

    const other = await this.prisma.user.findUnique({ where: { id: otherUserId }, select: PARTICIPANT_SELECT });
    if (!other) throw new NotFoundException('User not found');

    const conv = await this.getOrCreateDirectConversation(userId, otherUserId);
    const visible = this.visibleSince(await this.clearedAt(conv.id, userId));
    const [lastMessage, unreadCount] = await Promise.all([
      this.prisma.message.findFirst({ where: { conversationId: conv.id, ...visible }, orderBy: { createdAt: 'desc' } }),
      this.prisma.message.count({ where: { conversationId: conv.id, ...visible, isRead: false, senderId: { not: userId } } }),
    ]);

    const [signed] = await this.withVoiceLinks([lastMessage]);
    const online = await onlineSet(this.redis, [other.id]);
    const participant = { ...other, online: online.has(other.id) };
    return { id: conv.id, type: conv.type, participant, club: null, lastMessage: signed, unreadCount };
  }

  async getClubConversation(clubId: string) {
    return this.prisma.conversation.findUnique({ where: { clubId } });
  }

  async getConversations(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where: { members: { some: { userId } } },
      include: {
        members: {
          where: { userId: { not: userId } },
          include: { user: { select: PARTICIPANT_SELECT } },
          take: 1,
        },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        club: { select: { id: true, name: true, iconUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // When this player cleared a chat, only messages after that count or show.
    const memberships = await this.prisma.conversationMember.findMany({
      where: { userId, conversationId: { in: conversations.map((c) => c.id) } },
      select: { conversationId: true, clearedAt: true },
    });
    const clearedAtOf = new Map(memberships.map((m) => [m.conversationId, m.clearedAt]));

    const unreadCounts = await Promise.all(conversations.map((c) =>
      this.prisma.message.count({
        where: { conversationId: c.id, ...this.visibleSince(clearedAtOf.get(c.id)), isRead: false, senderId: { not: userId } },
      }),
    ));

    const lastMessages = await this.withVoiceLinks(conversations.map((c) => {
      const last = c.messages[0] || null;
      const cleared = clearedAtOf.get(c.id);
      return last && cleared && last.createdAt <= cleared ? null : last;
    }));

    const online = await onlineSet(this.redis, conversations.map((c) => c.members[0]?.user?.id).filter((id): id is string => !!id));

    const rows = conversations.map((c, idx) => {
      const user = c.type === 'DIRECT' ? c.members[0]?.user : null;
      return {
        id: c.id,
        type: c.type,
        participant: user ? { ...user, online: online.has(user.id) } : null,
        club: c.club,
        lastMessage: lastMessages[idx],
        unreadCount: unreadCounts[idx],
      };
    });
    // Most recent chat first: by its latest visible message, else when it was opened.
    const activity = (idx: number) => new Date(lastMessages[idx]?.createdAt ?? conversations[idx].createdAt ?? 0).getTime();
    return rows
      .map((row, idx) => ({ row, at: activity(idx) }))
      .sort((a, b) => b.at - a.at)
      .map((x) => x.row);
  }

  async getHistory(conversationId: string, userId: string, page = 1, limit = 50) {
    await this.assertMember(conversationId, userId);
    const where = { conversationId, ...this.visibleSince(await this.clearedAt(conversationId, userId)) };

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: { sender: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.message.count({ where }),
    ]);

    const signed = await this.withVoiceLinks(data.reverse());
    return { data: signed, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Member ids of a conversation, after checking `userId` is one of them.
   * Throws 404 for an unknown conversation and 403 for a non-member.
   */
  async assertMember(conversationId: string, userId: string): Promise<string[]> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { members: { select: { userId: true } } },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const memberIds = conv.members.map((m) => m.userId);
    if (!memberIds.includes(userId)) throw new ForbiddenException('Not a member of this conversation');
    return memberIds;
  }

  /** Membership check plus, for a 1-to-1 chat, refusing to deliver across a block. */
  async assertCanSend(conversationId: string, senderId: string): Promise<string[]> {
    const memberIds = await this.assertMember(conversationId, senderId);
    const others = memberIds.filter((id) => id !== senderId);
    if (others.length === 1) {
      const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true } });
      if (conv?.type === 'DIRECT' && (await this.friendsService.isBlocked(senderId, others[0]))) {
        throw new ForbiddenException('USER_BLOCKED');
      }
    }
    return memberIds;
  }

  async sendMessage(conversationId: string, senderId: string, content: string) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) throw new BadRequestException('Message is empty');
    if (text.length > MAX_TEXT_LENGTH) throw new BadRequestException(`Message is longer than ${MAX_TEXT_LENGTH} characters`);

    const memberIds = await this.assertCanSend(conversationId, senderId);
    const message = await this.prisma.message.create({
      data: { conversationId, senderId, type: 'TEXT', content: text },
      include: { sender: { select: SENDER_SELECT } },
    });
    this.deliver(memberIds, message);
    await this.missions.updateProgressSafely(senderId, MissionRequirement.SEND_MESSAGES);
    return message;
  }

  /**
   * `voiceKey` is the private S3 object key (stored in `voiceUrl`); members only ever see a
   * short-lived signed link to it. `memberIds` comes from assertCanSend(), which the
   * controller runs before uploading.
   */
  async sendVoiceMessage(conversationId: string, senderId: string, voiceKey: string, duration: number, memberIds: string[]) {
    const created = await this.prisma.message.create({
      data: { conversationId, senderId, type: 'VOICE', voiceUrl: voiceKey, duration },
      include: { sender: { select: SENDER_SELECT } },
    });
    const [message] = await this.withVoiceLinks([created]);
    this.deliver(memberIds, message);
    await this.missions.updateProgressSafely(senderId, MissionRequirement.SEND_MESSAGES);
    return message;
  }

  /** Swap each stored voice key for a temporary signed download link. */
  async withVoiceLinks<T extends { voiceUrl?: string | null } | null>(messages: T[]): Promise<T[]> {
    const keys = messages.map((m) => m?.voiceUrl).filter((v): v is string => !!v);
    if (keys.length === 0) return messages;
    const links = await this.s3.signUrls(keys);
    return messages.map((m) => (m?.voiceUrl ? { ...m, voiceUrl: links.get(m.voiceUrl) ?? m.voiceUrl } : m));
  }

  async markAsRead(conversationId: string, userId: string) {
    const memberIds = await this.assertMember(conversationId, userId);
    const result = await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, isRead: false },
      data: { isRead: true },
    });
    this.socketService.emitToUsers(memberIds.filter((id) => id !== userId), 'chat:read_receipt', {
      conversationId,
      readByUserId: userId,
      readAt: new Date().toISOString(),
    });
    return result;
  }

  /**
   * "Clear chat" for one player: hides every message up to now from their own view only.
   * Messages are kept (the other members still see them, and reports can point at them).
   */
  async clearConversation(conversationId: string, userId: string) {
    await this.assertMember(conversationId, userId);
    const clearedAt = new Date();
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { clearedAt },
    });
    // The player's other open screens/devices empty the chat too.
    this.socketService.emitToUsers([userId], 'chat:cleared', { conversationId, clearedAt: clearedAt.toISOString() });
    return { conversationId, clearedAt };
  }

  /**
   * Report a player from a chat, for the admins to review. In a club chat a message must be
   * picked; in a 1-to-1 chat the other player is reported when no message is given.
   * Reporting the same thing again while the first report is still open returns that report.
   */
  async reportConversation(conversationId: string, reporterId: string, dto: ReportChatDto) {
    const memberIds = await this.assertMember(conversationId, reporterId);

    let reportedUserId: string;
    if (dto.messageId) {
      const message = await this.prisma.message.findUnique({
        where: { id: dto.messageId },
        select: { conversationId: true, senderId: true },
      });
      if (!message || message.conversationId !== conversationId) throw new NotFoundException('Message not found');
      if (message.senderId === reporterId) throw new BadRequestException('You cannot report your own message');
      reportedUserId = message.senderId;
    } else {
      const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true } });
      const others = memberIds.filter((id) => id !== reporterId);
      if (conv?.type !== 'DIRECT' || others.length !== 1) {
        throw new BadRequestException('Choose the message you want to report');
      }
      reportedUserId = others[0];
    }

    const target = { reporterId, reportedUserId, conversationId, messageId: dto.messageId ?? null };
    const existing = await this.prisma.report.findFirst({
      where: { ...target, status: 'OPEN' },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) return { ...existing, alreadyReported: true };

    const details = dto.details?.trim() || null;
    const report = await this.prisma.report.create({
      data: { ...target, reason: dto.reason, details },
      select: { id: true, status: true, createdAt: true },
    });
    return { ...report, alreadyReported: false };
  }

  private async clearedAt(conversationId: string, userId: string): Promise<Date | null> {
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { clearedAt: true },
    });
    return member?.clearedAt ?? null;
  }

  /** Message filter for a player who cleared the chat at `clearedAt` (no filter if never). */
  private visibleSince(clearedAt: Date | null | undefined): Prisma.MessageWhereInput {
    return clearedAt ? { createdAt: { gt: clearedAt } } : {};
  }

  async notifyTyping(conversationId: string, userId: string, isTyping: boolean) {
    const memberIds = await this.assertMember(conversationId, userId);
    this.socketService.emitToUsers(memberIds.filter((id) => id !== userId), 'chat:typing', {
      conversationId,
      userId,
      isTyping: !!isTyping,
    });
  }

  // Every member — the sender too, so their other screens stay in step — gets the
  // message through their personal `user:<id>` room, which each socket joins on connect.
  // Unlike per-conversation rooms, this needs no re-joining when a chat is created later.
  private deliver(memberIds: string[], message: unknown) {
    this.socketService.emitToUsers(memberIds, 'chat:message', message);
  }
}
