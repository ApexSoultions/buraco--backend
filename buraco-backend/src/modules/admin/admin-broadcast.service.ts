import { BadRequestException, Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SocketService } from '../../common/socket/socket.service';

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * A message to every player (shows in their game notifications and live for those online).
 * Shows how many players will get it first, refuses the same message twice within 10 minutes
 * (a double click), and keeps a history.
 */
@Injectable()
export class AdminBroadcastService {
  constructor(private prisma: PrismaService, private socket: SocketService) {}

  private audience() {
    return this.prisma.user.findMany({ where: { isDeleted: false, isBanned: false }, select: { id: true } });
  }

  async audienceCount() {
    return { count: await this.prisma.user.count({ where: { isDeleted: false, isBanned: false } }) };
  }

  async send(adminId: string, titleIn: string, bodyIn: string) {
    const title = titleIn.trim();
    const body = bodyIn.trim();
    if (!title || !body) throw new BadRequestException('TITLE_AND_MESSAGE_REQUIRED');

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const same = await this.prisma.adminAuditLog.findFirst({
      where: { action: 'BROADCAST', createdAt: { gte: since }, AND: [{ details: { path: ['title'], equals: title } }, { details: { path: ['body'], equals: body } }] },
      select: { id: true },
    });
    if (same) throw new BadRequestException('ALREADY_SENT');

    const users = await this.audience();
    await this.prisma.notification.createMany({
      data: users.map((u) => ({ userId: u.id, type: NotificationType.BROADCAST, title, body, data: {} })),
    });
    // One live event for everyone online; clients re-fetch their unread count.
    this.socket.emitToAll('notification:new', {
      notification: { type: NotificationType.BROADCAST, title, body, data: {}, createdAt: new Date().toISOString() },
      unreadCount: null,
    });
    await this.prisma.adminAuditLog.create({
      data: { adminId, action: 'BROADCAST', targetType: 'Notification', targetId: 'all', details: { title, body, recipientCount: users.length } },
    });
    return { sent: users.length };
  }

  async history(limit = 20) {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: { action: 'BROADCAST' },
      orderBy: { createdAt: 'desc' },
      take: Math.min(50, Math.max(1, limit)),
      include: { admin: { select: { name: true } } },
    });
    return rows.map((r) => {
      const d = (r.details ?? {}) as { title?: string; body?: string; recipientCount?: number };
      return { id: r.id, title: d.title ?? '', body: d.body ?? '', recipients: d.recipientCount ?? 0, sentAt: r.createdAt, sentBy: r.admin?.name ?? '' };
    });
  }
}
