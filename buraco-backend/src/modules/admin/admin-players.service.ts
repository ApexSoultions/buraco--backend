import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CurrencyType, Prisma, ReportStatus, TransactionType } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SocketService } from '../../common/socket/socket.service';
import { BanUserDto } from './dto/ban-user.dto';
import { CreditUserDto } from './dto/credit-user.dto';
import { AdjustLivesDto } from './dto/admin-players.dto';

const MAX_NOTE = 2000;

/**
 * Players in the admin panel: the full profile, coins / diamonds / lives changes, bans that
 * take effect at once, resetting an offensive name, and staff notes. Every change is
 * audit-logged; balance changes also go to the player's transaction history.
 */
@Injectable()
export class AdminPlayersService {
  constructor(private prisma: PrismaService, private sockets: SocketService) {}

  async getPlayer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, email: true, avatarUrl: true, country: true,
        coins: true, diamonds: true, lives: true,
        subscriptionStatus: true, subscriptionExpiry: true, voiceChatExpiry: true,
        isBanned: true, banReason: true, isDeleted: true, deletedAt: true,
        createdAt: true, lastSeenAt: true,
        googleId: true, appleId: true, // only turned into yes/no below
        stats: true,
        transactions: { take: 20, orderBy: { createdAt: 'desc' } },
        adminNotes: { orderBy: { createdAt: 'desc' } },
        clubMemberships: { where: { status: 'ACTIVE' }, select: { role: true, points: true, joinedAt: true, club: { select: { id: true, name: true } } } },
        inventory: { orderBy: { purchasedAt: 'desc' }, select: { id: true, quantity: true, isEquipped: true, purchasedAt: true, item: { select: { id: true, name: true, category: true } } } },
        gamePlayers: {
          take: 10,
          orderBy: { game: { createdAt: 'desc' } },
          select: { teamId: true, finalScore: true, result: true, game: { select: { id: true, mode: true, variant: true, status: true, createdAt: true, endedAt: true } } },
        },
        iapPurchases: { take: 10, orderBy: { createdAt: 'desc' }, select: { id: true, store: true, productId: true, coins: true, environment: true, createdAt: true } },
        _count: { select: { reportsReceived: true, reportsMade: true, customCards: true } },
      },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');

    const [openReports, noteAdmins] = await Promise.all([
      this.prisma.report.count({ where: { reportedUserId: userId, status: ReportStatus.OPEN } }),
      this.prisma.adminUser.findMany({
        where: { id: { in: [...new Set(user.adminNotes.map((n) => n.adminId))] } },
        select: { id: true, name: true },
      }),
    ]);
    const adminName = new Map(noteAdmins.map((a) => [a.id, a.name]));
    const { googleId, appleId, adminNotes, clubMemberships, _count, ...rest } = user;

    return {
      ...rest,
      login: { email: !!user.email, google: !!googleId, apple: !!appleId },
      club: clubMemberships[0] ? { ...clubMemberships[0].club, role: clubMemberships[0].role, points: clubMemberships[0].points } : null,
      notes: adminNotes.map((n) => ({ id: n.id, content: n.content, createdAt: n.createdAt, by: adminName.get(n.adminId) ?? 'Admin' })),
      reports: { received: _count.reportsReceived, open: openReports, made: _count.reportsMade },
      customCards: _count.customCards,
    };
  }

  /** Adds (credit) or takes (deduct) coins / diamonds in one database step, so a purchase at the same moment can't be lost. */
  async changeBalance(adminId: string, userId: string, dto: CreditUserDto, direction: 1 | -1) {
    const field = dto.currency === CurrencyType.COINS ? 'coins' : 'diamonds';
    return this.prisma.$transaction(async (tx) => {
      const where: Prisma.UserWhereInput = { id: userId, ...(direction < 0 ? { [field]: { gte: dto.amount } } : {}) };
      const done = await tx.user.updateMany({ where, data: { [field]: direction > 0 ? { increment: dto.amount } : { decrement: dto.amount } } });
      if (done.count === 0) {
        const exists = await tx.user.count({ where: { id: userId } });
        throw exists ? new BadRequestException('INSUFFICIENT_BALANCE') : new NotFoundException('USER_NOT_FOUND');
      }
      const after = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coins: true, diamonds: true } });
      const balanceAfter = after[field];
      await tx.transaction.create({
        data: {
          userId,
          type: direction > 0 ? TransactionType.MANUAL_CREDIT : TransactionType.MANUAL_DEDUCT,
          currency: dto.currency,
          amount: dto.amount,
          balanceBefore: balanceAfter - direction * dto.amount,
          balanceAfter,
          description: dto.reason?.trim() || null,
          performedBy: adminId,
        },
      });
      await tx.adminAuditLog.create({
        data: { adminId, action: direction > 0 ? 'CREDIT_USER' : 'DEDUCT_USER', targetType: 'User', targetId: userId, details: { currency: dto.currency, amount: dto.amount, reason: dto.reason ?? null } },
      });
      return { [field]: balanceAfter };
    });
  }

  /** Gives (amount > 0) or takes (amount < 0) lives; never below 0. */
  async changeLives(adminId: string, userId: string, dto: AdjustLivesDto) {
    if (dto.amount === 0) throw new BadRequestException('AMOUNT_ZERO');
    return this.prisma.$transaction(async (tx) => {
      const where: Prisma.UserWhereInput = { id: userId, ...(dto.amount < 0 ? { lives: { gte: -dto.amount } } : {}) };
      const done = await tx.user.updateMany({ where, data: { lives: { increment: dto.amount } } });
      if (done.count === 0) {
        const exists = await tx.user.count({ where: { id: userId } });
        throw exists ? new BadRequestException('NOT_ENOUGH_LIVES') : new NotFoundException('USER_NOT_FOUND');
      }
      const { lives } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { lives: true } });
      await tx.adminAuditLog.create({
        data: { adminId, action: dto.amount > 0 ? 'GIVE_LIVES' : 'TAKE_LIVES', targetType: 'User', targetId: userId, details: { amount: dto.amount, reason: dto.reason ?? null, livesAfter: lives } },
      });
      return { lives };
    });
  }

  /** Ban takes effect at once: saved logins are cancelled and the open game connection is closed. */
  async setBan(adminId: string, userId: string, dto: BanUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    const reason = dto.reason?.trim() || null;
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { isBanned: dto.isBanned, banReason: dto.isBanned ? reason : null } }),
      ...(dto.isBanned ? [this.prisma.refreshToken.deleteMany({ where: { userId } })] : []),
      this.prisma.adminAuditLog.create({ data: { adminId, action: dto.isBanned ? 'BAN_USER' : 'UNBAN_USER', targetType: 'User', targetId: userId, details: { reason } } }),
    ]);
    if (dto.isBanned) this.sockets.kickUser(userId, 'Account banned');
    return { isBanned: dto.isBanned };
  }

  /** Replaces an offensive name with "Player" + 6 digits (the player can pick a new one later). */
  async resetName(adminId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = `Player${randomInt(100000, 1000000)}`;
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { username } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // taken, try another
        throw e;
      }
      await this.prisma.adminAuditLog.create({ data: { adminId, action: 'RESET_NAME', targetType: 'User', targetId: userId, details: { from: user.username, to: username } } });
      return { username };
    }
    throw new ConflictException('NAME_RESET_FAILED');
  }

  async addNote(adminId: string, userId: string, content: string) {
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('NOTE_EMPTY');
    if (text.length > MAX_NOTE) throw new BadRequestException('NOTE_TOO_LONG');
    if (!(await this.prisma.user.count({ where: { id: userId } }))) throw new NotFoundException('USER_NOT_FOUND');
    return this.prisma.adminNote.create({ data: { userId, adminId, content: text } });
  }
}
