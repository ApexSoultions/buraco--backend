import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, SupportStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

const PLAYER = { select: { id: true, username: true, email: true, isBanned: true } } as const;

/**
 * Support tickets for staff: the list (open first, oldest waiting first), one ticket with its
 * conversation, replying (the player gets a game notification and an email), and closing or
 * reopening. Every action is audit-logged.
 */
@Injectable()
export class AdminSupportService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService, private mail: MailService) {}

  async list(opts: { status?: string; search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const status = opts.status && opts.status in SupportStatus ? (opts.status as SupportStatus) : undefined;
    const search = opts.search?.trim();
    const where: Prisma.SupportTicketWhereInput = {
      ...(status ? { status } : {}),
      ...(search
        ? { OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { message: { contains: search, mode: 'insensitive' } },
            { user: { username: { contains: search, mode: 'insensitive' } } },
          ] }
        : {}),
    };
    const [rows, total, counts] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        // Waiting tickets: the one waiting longest first. Everything else: newest first.
        orderBy: { createdAt: status === SupportStatus.OPEN ? 'asc' : 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: PLAYER, _count: { select: { replies: true } } },
      }),
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      data: rows.map((t) => ({
        id: t.id, status: t.status, name: t.name, email: t.email, snippet: snippet(t.message),
        createdAt: t.createdAt, replies: t._count.replies, user: t.user,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<SupportStatus, number>>,
    };
  }

  async get(id: string) {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { user: PLAYER, replies: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException('TICKET_NOT_FOUND');
    return t;
  }

  async reply(adminId: string, id: string, messageIn: string) {
    const message = messageIn.trim();
    if (message.length < 2) throw new BadRequestException('MESSAGE_REQUIRED');
    const [ticket, admin] = await Promise.all([
      this.prisma.supportTicket.findUnique({ where: { id }, select: { id: true, userId: true, name: true, email: true, message: true } }),
      this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { name: true } }),
    ]);
    if (!ticket) throw new NotFoundException('TICKET_NOT_FOUND');
    const adminName = admin?.name ?? 'Game Support';

    await this.prisma.$transaction([
      this.prisma.supportReply.create({ data: { ticketId: id, adminId, adminName, message } }),
      this.prisma.supportTicket.update({ where: { id }, data: { status: SupportStatus.ANSWERED, closedAt: null, closedBy: null } }),
    ]);

    await this.notifications.notifySafely(ticket.userId, NotificationType.SYSTEM, 'Game Support answered you', message, { event: 'SUPPORT_REPLY', ticketId: id });
    // The email is a courtesy: a mail problem must not undo the reply.
    await this.mail.sendSupportReply(ticket.email, ticket.name, ticket.message, message).catch(() => undefined);
    await this.audit(adminId, 'SUPPORT_REPLY', id, { length: message.length });
    return this.get(id);
  }

  async setStatus(adminId: string, id: string, status: 'OPEN' | 'CLOSED') {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id }, select: { id: true } });
    if (!ticket) throw new NotFoundException('TICKET_NOT_FOUND');
    const closing = status === 'CLOSED';
    await this.prisma.supportTicket.update({
      where: { id },
      data: closing
        ? { status: SupportStatus.CLOSED, closedAt: new Date(), closedBy: adminId }
        : { status: SupportStatus.OPEN, closedAt: null, closedBy: null },
    });
    await this.audit(adminId, closing ? 'SUPPORT_CLOSE' : 'SUPPORT_REOPEN', id, {});
    return this.get(id);
  }

  private async audit(adminId: string, action: string, targetId: string, details: object) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType: 'SupportTicket', targetId, details } });
  }
}

function snippet(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}
