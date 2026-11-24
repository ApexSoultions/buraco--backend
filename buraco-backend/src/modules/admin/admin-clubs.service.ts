import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ClubRole, ClubMode, ClubType, MemberStatus, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const PLAYER = { select: { id: true, username: true, avatarUrl: true, email: true, isBanned: true, lastSeenAt: true } } as const;

/**
 * Clan moderation for staff: the list, one clan with its members and recent news, removing a
 * member, handing the leadership to someone else, cleaning an offensive name or icon, and
 * deleting a clan. It does what the game does for the same actions (chat membership, seat
 * count, news, notifications), and every action is audit-logged.
 */
@Injectable()
export class AdminClubsService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async list(opts: { search?: string; mode?: string; type?: string; page?: number; limit?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const search = opts.search?.trim();
    const where: Prisma.ClubWhereInput = {
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(opts.mode && opts.mode in ClubMode ? { mode: opts.mode as ClubMode } : {}),
      ...(opts.type && opts.type in ClubType ? { type: opts.type as ClubType } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.club.findMany({
        where, orderBy: { points: 'desc' }, skip: (page - 1) * limit, take: limit,
        include: { members: { where: { role: ClubRole.LEADER, status: MemberStatus.ACTIVE }, take: 1, include: { user: PLAYER } } },
      }),
      this.prisma.club.count({ where }),
    ]);
    return {
      data: rows.map(({ members, ...c }) => ({ ...c, leader: members[0]?.user ?? null })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      include: {
        members: { orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }], include: { user: PLAYER } },
        activities: { orderBy: { createdAt: 'desc' }, take: 15 },
      },
    });
    if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
    const { members, activities, ...rest } = club;
    return {
      ...rest,
      members: members.map((m) => ({
        userId: m.userId, role: m.role, status: m.status, points: m.points, joinedAt: m.joinedAt, user: m.user,
      })),
      news: activities.map((a) => ({ id: a.id, type: a.type, text: a.text, createdAt: a.createdAt })),
    };
  }

  /** Remove an active member or decline a pending request. The leader can't be removed. */
  async removeMember(adminId: string, clubId: string, userId: string, reason?: string) {
    const member = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } }, include: { club: { select: { name: true } }, user: { select: { username: true } } },
    });
    if (!member) throw new NotFoundException('MEMBER_NOT_FOUND');
    const active = member.status === MemberStatus.ACTIVE;
    if (active && member.role === ClubRole.LEADER) throw new BadRequestException('IS_LEADER');

    await this.prisma.$transaction(async (tx) => {
      await tx.clubMember.delete({ where: { clubId_userId: { clubId, userId } } });
      if (active) {
        await tx.club.update({ where: { id: clubId }, data: { memberCount: { decrement: 1 } } });
        const conv = await tx.conversation.findUnique({ where: { clubId }, select: { id: true } });
        if (conv) await tx.conversationMember.deleteMany({ where: { conversationId: conv.id, userId } });
      }
    });

    const why = reason?.trim();
    if (active) {
      await this.prisma.clubActivity.create({ data: { clubId, type: 'REMOVED', userId, text: `${member.user.username} was removed from the club` } }).catch(() => undefined);
    }
    await this.notifications.notifySafely(userId, NotificationType.CLUB_UPDATE, member.club.name,
      active ? `You were removed from ${member.club.name}${why ? `: ${why}` : ''}` : `Your request to join ${member.club.name} was declined`,
      { clubId, event: 'REMOVED' });
    await this.audit(adminId, 'CLUB_REMOVE_MEMBER', 'Club', clubId, { club: member.club.name, userId, username: member.user.username, wasActive: active, reason: why ?? null });
    return { removed: true };
  }

  /** The old leader becomes vice leader, so a club always has exactly one leader. */
  async makeLeader(adminId: string, clubId: string, userId: string) {
    const [club, target, current] = await Promise.all([
      this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } }),
      this.prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } }, include: { user: { select: { username: true } } } }),
      this.prisma.clubMember.findFirst({ where: { clubId, role: ClubRole.LEADER, status: MemberStatus.ACTIVE } }),
    ]);
    if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
    if (!target || target.status !== MemberStatus.ACTIVE) throw new NotFoundException('MEMBER_NOT_FOUND');
    if (target.role === ClubRole.LEADER) throw new BadRequestException('ALREADY_LEADER');

    await this.prisma.$transaction(async (tx) => {
      if (current) await tx.clubMember.update({ where: { id: current.id }, data: { role: ClubRole.VICE_LEADER } });
      await tx.clubMember.update({ where: { id: target.id }, data: { role: ClubRole.LEADER } });
    });
    await this.prisma.clubActivity.create({ data: { clubId, type: 'ROLE_CHANGED', userId, text: `${target.user.username} is now leader` } }).catch(() => undefined);
    await this.notifications.notifySafely(userId, NotificationType.CLUB_UPDATE, club.name, `You are now leader of ${club.name}`, { clubId, event: 'ROLE_CHANGED', role: 'LEADER' });
    await this.audit(adminId, 'CLUB_MAKE_LEADER', 'Club', clubId, { club: club.name, newLeader: target.user.username, oldLeaderId: current?.userId ?? null });
    return { leaderId: userId };
  }

  /** Replace an offensive club name with "Clan" + 6 digits. */
  async resetName(adminId: string, clubId: string, reason?: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
    if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
    let name = '';
    for (let i = 0; i < 5; i++) {
      const candidate = `Clan${Math.floor(100000 + Math.random() * 900000)}`;
      if (!(await this.prisma.club.findUnique({ where: { name: candidate }, select: { id: true } }))) { name = candidate; break; }
    }
    if (!name) throw new BadRequestException('TRY_AGAIN');
    await this.prisma.club.update({ where: { id: clubId }, data: { name } });
    await this.notifyActive(clubId, name, `Your clan was renamed to ${name}${reason?.trim() ? `: ${reason.trim()}` : ''}`, 'RENAMED');
    await this.audit(adminId, 'CLUB_RESET_NAME', 'Club', clubId, { from: club.name, to: name, reason: reason?.trim() ?? null });
    return { name };
  }

  async removeIcon(adminId: string, clubId: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { name: true, iconUrl: true } });
    if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
    if (!club.iconUrl) return { removed: false };
    await this.prisma.club.update({ where: { id: clubId }, data: { iconUrl: null } });
    await this.audit(adminId, 'CLUB_REMOVE_ICON', 'Club', clubId, { club: club.name });
    return { removed: true };
  }

  /**
   * Delete a clan with its chat. Reports on its chat messages are kept (the message text is
   * copied into the report first), because the messages themselves are deleted.
   */
  async remove(adminId: string, clubId: string, reason?: string) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true, memberCount: true } });
    if (!club) throw new NotFoundException('CLUB_NOT_FOUND');
    const members = await this.prisma.clubMember.findMany({ where: { clubId, status: MemberStatus.ACTIVE }, select: { userId: true } });

    await this.prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.findUnique({ where: { clubId }, select: { id: true } });
      if (conv) {
        const reported = await tx.report.findMany({ where: { conversationId: conv.id }, include: { message: { select: { content: true } } } });
        for (const r of reported) {
          await tx.report.update({
            where: { id: r.id },
            data: { messageId: null, conversationId: null, source: r.source ?? 'MESSAGES', details: r.details ?? `Clan chat (${club.name}, clan deleted):\n${r.message?.content ?? '[voice message]'}` },
          });
        }
        await tx.message.deleteMany({ where: { conversationId: conv.id } });
        await tx.conversationMember.deleteMany({ where: { conversationId: conv.id } });
        await tx.conversation.delete({ where: { id: conv.id } });
      }
      await tx.club.delete({ where: { id: clubId } });
    });

    const why = reason?.trim();
    await this.notifications.notifySafely(members.map((m) => m.userId), NotificationType.CLUB_UPDATE, club.name,
      `${club.name} was closed by the game staff${why ? `: ${why}` : ''}`, { clubId, event: 'CLUB_DELETED' });
    await this.audit(adminId, 'DELETE_CLUB', 'Club', clubId, { name: club.name, members: members.length, reason: why ?? null });
    return { deleted: true };
  }

  private async notifyActive(clubId: string, title: string, body: string, event: string) {
    const members = await this.prisma.clubMember.findMany({ where: { clubId, status: MemberStatus.ACTIVE }, select: { userId: true } });
    await this.notifications.notifySafely(members.map((m) => m.userId), NotificationType.CLUB_UPDATE, title, body, { clubId, event });
  }

  private async audit(adminId: string, action: string, targetType: string, targetId: string, details: object) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType, targetId, details } });
  }
}
