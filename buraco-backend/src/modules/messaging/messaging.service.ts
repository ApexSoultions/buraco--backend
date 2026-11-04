import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MissionRequirement } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { S3Service } from '../../common/s3/s3.service';
import { SocketService } from '../../common/socket/socket.service';
import { FriendsService } from '../friends/friends.service';
import { MissionsService } from '../missions/missions.service';

export const MAX_TEXT_LENGTH = 1000;
export const MAX_VOICE_SECONDS = 120;

const SENDER_SELECT = { id: true, username: true, avatarUrl: true } as const;

@Injectable()
export class MessagingService {
  constructor(
    private prisma: PrismaService,
    private friendsService: FriendsService,
    private socketService: SocketService,
    private s3: S3Service,
    private missions: MissionsService,
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

    const other = await this.prisma.user.findUnique({ where: { id: otherUserId }, select: SENDER_SELECT });
    if (!other) throw new NotFoundException('User not found');

    const conv = await this.getOrCreateDirectConversation(userId, otherUserId);
    const [lastMessage, unreadCount] = await Promise.all([
      this.prisma.message.findFirst({ where: { conversationId: conv.id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.message.count({ where: { conversationId: conv.id, isRead: false, senderId: { not: userId } } }),
    ]);

    const [signed] = await this.withVoiceLinks([lastMessage]);
    return { id: conv.id, type: conv.type, participant: other, club: null, lastMessage: signed, unreadCount };
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
          include: { user: { select: { id: true, username: true, avatarUrl: true } } },
          take: 1,
        },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        club: { select: { id: true, name: true, iconUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const unreadCounts = await Promise.all(conversations.map((c) =>
      this.prisma.message.count({ where: { conversationId: c.id, isRead: false, senderId: { not: userId } } }),
    ));

    const lastMessages = await this.withVoiceLinks(conversations.map((c) => c.messages[0] || null));

    return conversations.map((c, idx) => ({
      id: c.id,
      type: c.type,
      participant: c.type === 'DIRECT' ? c.members[0]?.user : null,
      club: c.club,
      lastMessage: lastMessages[idx],
      unreadCount: unreadCounts[idx],
    }));
  }

  async getHistory(conversationId: string, userId: string, page = 1, limit = 50) {
    await this.assertMember(conversationId, userId);

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        include: { sender: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.message.count({ where: { conversationId } }),
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
