import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FriendshipStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class FriendsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async sendRequest(senderId: string, receiverId: string) {
    if (senderId === receiverId) throw new BadRequestException('Cannot send friend request to yourself');

    const blocked = await this.isBlocked(senderId, receiverId);
    if (blocked) throw new ForbiddenException('USER_BLOCKED');

    const existing = await this.prisma.friendship.findFirst({
      where: { OR: [{ senderId, receiverId }, { senderId: receiverId, receiverId: senderId }] },
    });
    if (existing?.status === FriendshipStatus.ACCEPTED) throw new ConflictException('ALREADY_FRIENDS');
    if (existing?.status === FriendshipStatus.PENDING) throw new ConflictException('REQUEST_ALREADY_SENT');

    const [sender, receiver] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: senderId }, select: { username: true, avatarUrl: true } }),
      this.prisma.user.findUnique({ where: { id: receiverId }, select: { id: true } }),
    ]);
    if (!receiver) throw new NotFoundException('User not found');

    // A declined request leaves its row behind; asking again reopens it instead of
    // hitting the unique (sender, receiver) constraint.
    const request = existing
      ? await this.prisma.friendship.update({
          where: { id: existing.id },
          data: { senderId, receiverId, status: FriendshipStatus.PENDING },
        })
      : await this.prisma.friendship.create({ data: { senderId, receiverId, status: FriendshipStatus.PENDING } });

    await this.notifications.notifySafely(receiverId, NotificationType.FRIEND_REQUEST, 'New friend request',
      `${sender?.username ?? 'A player'} wants to be your friend`,
      { requestId: request.id, fromUserId: senderId, fromUsername: sender?.username, fromAvatarUrl: sender?.avatarUrl ?? null });
    return request;
  }

  async acceptRequest(userId: string, requestId: string) {
    const request = await this.prisma.friendship.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== userId) throw new NotFoundException('Friend request not found');
    if (request.status !== FriendshipStatus.PENDING) throw new BadRequestException('Request is not pending');

    const accepted = await this.prisma.friendship.update({ where: { id: requestId }, data: { status: FriendshipStatus.ACCEPTED } });
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true, avatarUrl: true } });
    await this.notifications.notifySafely(request.senderId, NotificationType.FRIEND_ACCEPTED, 'Friend request accepted',
      `${me?.username ?? 'A player'} accepted your friend request`,
      { friendshipId: requestId, userId, username: me?.username, avatarUrl: me?.avatarUrl ?? null });
    return accepted;
  }

  async declineRequest(userId: string, requestId: string) {
    const request = await this.prisma.friendship.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== userId) throw new NotFoundException('Friend request not found');

    return this.prisma.friendship.update({ where: { id: requestId }, data: { status: FriendshipStatus.DECLINED } });
  }

  async removeFriend(userId: string, friendId: string) {
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        status: FriendshipStatus.ACCEPTED,
        OR: [{ senderId: userId, receiverId: friendId }, { senderId: friendId, receiverId: userId }],
      },
    });
    if (!friendship) throw new NotFoundException('Friendship not found');
    return this.prisma.friendship.delete({ where: { id: friendship.id } });
  }

  async blockUser(userId: string, targetId: string) {
    if (userId === targetId) throw new BadRequestException('Cannot block yourself');

    await this.prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } },
      create: { blockerId: userId, blockedId: targetId },
      update: {},
    });

    // Remove friendship if exists
    await this.prisma.friendship.deleteMany({
      where: { OR: [{ senderId: userId, receiverId: targetId }, { senderId: targetId, receiverId: userId }] },
    });
  }

  async unblockUser(userId: string, targetId: string) {
    await this.prisma.block.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
  }

  async getFriends(userId: string) {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.ACCEPTED,
        OR: [{ senderId: userId }, { receiverId: userId }],
      },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true } } } },
        receiver: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true } } } },
      },
    });

    return friendships.map((f) => ({
      friendshipId: f.id,
      user: f.senderId === userId ? f.receiver : f.sender,
    }));
  }

  async getPendingRequests(userId: string) {
    return this.prisma.friendship.findMany({
      where: { receiverId: userId, status: FriendshipStatus.PENDING },
      include: { sender: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true } } } } },
    });
  }

  async getSentRequests(userId: string) {
    return this.prisma.friendship.findMany({
      where: { senderId: userId, status: FriendshipStatus.PENDING },
      include: { receiver: { select: { id: true, username: true, avatarUrl: true, stats: { select: { level: true } } } } },
    });
  }

  async getBlockedUsers(userId: string) {
    return this.prisma.block.findMany({
      where: { blockerId: userId },
      include: { blocked: { select: { id: true, username: true, avatarUrl: true } } },
    });
  }

  async isBlocked(userId: string, targetId: string): Promise<boolean> {
    const block = await this.prisma.block.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: targetId }, { blockerId: targetId, blockedId: userId }] },
    });
    return !!block;
  }

  async isFriend(userId: string, targetId: string): Promise<boolean> {
    const f = await this.prisma.friendship.findFirst({
      where: {
        status: FriendshipStatus.ACCEPTED,
        OR: [{ senderId: userId, receiverId: targetId }, { senderId: targetId, receiverId: userId }],
      },
    });
    return !!f;
  }
}
