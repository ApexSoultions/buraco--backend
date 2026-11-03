import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SocketService } from '../../common/socket/socket.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private socketService: SocketService,
  ) {}

  private async sendPush(userId: string, title: string, body: string, data?: object): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { fcmToken: true } });
      if (!user?.fcmToken) return;

      const serverKey = process.env.FCM_SERVER_KEY;
      if (!serverKey) return;

      await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${serverKey}`,
        },
        body: JSON.stringify({
          to: user.fcmToken,
          notification: { title, body },
          data: data ?? {},
        }),
      });
    } catch (err) {
      this.logger.error(`FCM push failed for user ${userId}`, err);
    }
  }

  async create(userId: string, type: NotificationType, title: string, body: string, data?: object) {
    const notification = await this.prisma.notification.create({
      data: { userId, type, title, body, data: data as any },
    });
    await this.emitLive(notification);
    // Fire-and-forget push (inactive until FCM is configured)
    this.sendPush(userId, title, body, data).catch(() => {});
    return notification;
  }

  /** The same notification for several players (e.g. everyone who leads a club). */
  async createForUsers(userIds: string[], type: NotificationType, title: string, body: string, data?: object) {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.notification.createManyAndReturn({
      data: unique.map((userId) => ({ userId, type, title, body, data: data as any })),
    });
    await Promise.all(rows.map((n) => this.emitLive(n)));
    return rows;
  }

  /**
   * Notify without ever failing the caller: the action that triggered it (a friend request,
   * a club decision) has already happened and must not be undone by a notification error.
   */
  async notifySafely(userIds: string | string[], type: NotificationType, title: string, body: string, data?: object) {
    try {
      const ids = Array.isArray(userIds) ? userIds : [userIds];
      if (ids.length === 1) await this.create(ids[0], type, title, body, data);
      else await this.createForUsers(ids, type, title, body, data);
    } catch (err) {
      this.logger.error(`Notification ${type} failed`, err as Error);
    }
  }

  /** Live `notification:new` to the player's sockets, with their new unread count for the badge. */
  private async emitLive(notification: { userId: string }) {
    const unreadCount = await this.prisma.notification.count({ where: { userId: notification.userId, isRead: false } });
    this.socketService.emitToUsers([notification.userId], 'notification:new', { notification, unreadCount });
  }

  async getNotifications(userId: string, page = 1, limit = 20, unreadOnly = false) {
    const skip = (page - 1) * limit;
    const where = { userId, ...(unreadOnly && { isRead: false }) };
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.notification.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({ where: { userId, isRead: false } });
    return { count };
  }

  async markAsRead(userId: string, notificationId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async delete(userId: string, notificationId: string) {
    return this.prisma.notification.deleteMany({ where: { id: notificationId, userId } });
  }
}
