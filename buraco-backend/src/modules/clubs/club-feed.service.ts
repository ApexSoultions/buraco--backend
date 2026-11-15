import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MemberStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OFFICERS, pageArgs, pageMeta, requireClubRole } from './club-access';

export type ClubActivityType =
  | 'CREATED' | 'JOINED' | 'LEFT' | 'REMOVED' | 'ROLE_CHANGED' | 'LEVEL_UP' | 'OBJECTIVE_COMPLETED';

/**
 * The club's News feed (activities) and Advices (posts by the leader and vice leaders).
 * Members read both; officers delete single rows or clear all.
 */
@Injectable()
export class ClubFeedService {
  private readonly logger = new Logger(ClubFeedService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ─── Activities (News) ──────────────────────────────────────────────────

  /** Never throws: the feed must not break the join, leave or match that it records. */
  async logSafely(clubId: string, type: ClubActivityType, text: string, userId?: string, data?: object) {
    try {
      await this.prisma.clubActivity.create({ data: { clubId, type, text, userId, data: data as any } });
    } catch (err) {
      this.logger.error(`Club activity ${type} failed for club ${clubId}`, err as Error);
    }
  }

  async listActivities(userId: string, clubId: string, page?: number, limit?: number) {
    await requireClubRole(this.prisma, userId, clubId);
    const p = pageArgs(page, limit);
    const [data, total] = await Promise.all([
      this.prisma.clubActivity.findMany({
        where: { clubId },
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.limit,
        select: { id: true, type: true, userId: true, text: true, data: true, createdAt: true },
      }),
      this.prisma.clubActivity.count({ where: { clubId } }),
    ]);
    return { data, meta: pageMeta(total, p.page, p.limit) };
  }

  async deleteActivity(userId: string, clubId: string, activityId: string) {
    await requireClubRole(this.prisma, userId, clubId, OFFICERS);
    const res = await this.prisma.clubActivity.deleteMany({ where: { id: activityId, clubId } });
    if (res.count === 0) throw new NotFoundException('Activity not found');
    return { deleted: 1 };
  }

  async clearActivities(userId: string, clubId: string) {
    await requireClubRole(this.prisma, userId, clubId, OFFICERS);
    const res = await this.prisma.clubActivity.deleteMany({ where: { clubId } });
    return { deleted: res.count };
  }

  // ─── Advices ────────────────────────────────────────────────────────────

  async listAdvices(userId: string, clubId: string, page?: number, limit?: number) {
    await requireClubRole(this.prisma, userId, clubId);
    const p = pageArgs(page, limit);
    const [rows, total] = await Promise.all([
      this.prisma.clubAdvice.findMany({
        where: { clubId },
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.limit,
        include: { author: { select: { id: true, username: true, avatarUrl: true } } },
      }),
      this.prisma.clubAdvice.count({ where: { clubId } }),
    ]);
    // The author's role today (they may have been promoted or left since).
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const roles = await this.prisma.clubMember.findMany({
      where: { clubId, userId: { in: authorIds }, status: MemberStatus.ACTIVE },
      select: { userId: true, role: true },
    });
    const roleOf = new Map(roles.map((r) => [r.userId, r.role]));
    const data = rows.map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.createdAt,
      author: { ...r.author, role: roleOf.get(r.authorId) ?? null },
    }));
    return { data, meta: pageMeta(total, p.page, p.limit) };
  }

  async postAdvice(userId: string, clubId: string, text: string) {
    await requireClubRole(this.prisma, userId, clubId, OFFICERS);
    const advice = await this.prisma.clubAdvice.create({
      data: { clubId, authorId: userId, text: text.trim() },
      include: { author: { select: { id: true, username: true, avatarUrl: true } } },
    });

    const [club, members] = await Promise.all([
      this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } }),
      this.prisma.clubMember.findMany({ where: { clubId, status: MemberStatus.ACTIVE, userId: { not: userId } }, select: { userId: true } }),
    ]);
    await this.notifications.notifySafely(members.map((m) => m.userId), NotificationType.CLUB_UPDATE,
      club?.name ?? 'Your club', `New advice from ${advice.author.username}`, { clubId, event: 'NEW_ADVICE', adviceId: advice.id });
    return advice;
  }

  async deleteAdvice(userId: string, clubId: string, adviceId: string) {
    await requireClubRole(this.prisma, userId, clubId, OFFICERS);
    const res = await this.prisma.clubAdvice.deleteMany({ where: { id: adviceId, clubId } });
    if (res.count === 0) throw new NotFoundException('Advice not found');
    return { deleted: 1 };
  }

  async clearAdvices(userId: string, clubId: string) {
    await requireClubRole(this.prisma, userId, clubId, OFFICERS);
    const res = await this.prisma.clubAdvice.deleteMany({ where: { clubId } });
    return { deleted: res.count };
  }
}
