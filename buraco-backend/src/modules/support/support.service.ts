import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';

/** A player may send this many messages to support per day (stops spam). */
export const MAX_TICKETS_PER_DAY = 3;

/** "Contact Game Support": a player sends a message and can read the answers later. */
@Injectable()
export class SupportService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateTicketDto) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const today = await this.prisma.supportTicket.count({ where: { userId, createdAt: { gte: since } } });
    if (today >= MAX_TICKETS_PER_DAY) throw new BadRequestException('TOO_MANY_TICKETS');

    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId,
        name: dto.name.trim(),
        email: dto.email.trim().toLowerCase(),
        social: dto.social?.trim() || null,
        message: dto.message.trim(),
      },
    });
    return { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt };
  }

  /** The player's own messages with the answers, newest first. */
  async mine(userId: string) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { replies: { orderBy: { createdAt: 'asc' }, select: { id: true, message: true, createdAt: true, adminName: true } } },
    });
    return rows.map((t) => ({ id: t.id, message: t.message, status: t.status, createdAt: t.createdAt, replies: t.replies }));
  }
}
