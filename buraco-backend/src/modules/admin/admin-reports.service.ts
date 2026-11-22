import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminPlayersService } from './admin-players.service';

export type ReportSource = 'MESSAGES' | 'TABLE_CHAT' | 'GLOBAL_CHAT' | 'OTHER';

/** Old reports have no source saved: work it out from what they carry. */
export function sourceOf(r: { source: string | null; conversationId: string | null; details: string | null }): ReportSource {
  if (r.source === 'MESSAGES' || r.source === 'TABLE_CHAT' || r.source === 'GLOBAL_CHAT') return r.source;
  if (r.conversationId) return 'MESSAGES';
  if (r.details?.startsWith('Table chat')) return 'TABLE_CHAT';
  if (r.details?.startsWith('Global chat')) return 'GLOBAL_CHAT';
  return 'OTHER';
}

const PLAYER = { select: { id: true, username: true, avatarUrl: true, isBanned: true } } as const;

/**
 * Player reports for moderators: the list (open first), one report with the reported
 * message and the conversation around it, closing a report (handled / dismissed, with who
 * and when), and banning straight from a report (which also closes every open report
 * against that player). Everything is audit-logged.
 */
@Injectable()
export class AdminReportsService {
  constructor(private prisma: PrismaService, private players: AdminPlayersService) {}

  async list(opts: { status?: string; page?: number; limit?: number; userId?: string }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const status = opts.status && opts.status in ReportStatus ? (opts.status as ReportStatus) : undefined;
    const where: Prisma.ReportWhereInput = {
      ...(status ? { status } : {}),
      ...(opts.userId ? { reportedUserId: opts.userId } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { reporter: PLAYER, reportedUser: PLAYER, message: { select: { content: true, type: true } } },
      }),
      this.prisma.report.count({ where }),
      this.prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const openAgainst = await this.openCounts(rows.map((r) => r.reportedUserId));
    return {
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        source: sourceOf(r),
        snippet: snippet(r.message?.content ?? (r.message?.type === 'VOICE' ? '[voice message]' : null) ?? stripHeader(r.details)),
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        reporter: r.reporter,
        reportedUser: r.reportedUser,
        openAgainstUser: openAgainst.get(r.reportedUserId) ?? 0,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<ReportStatus, number>>,
    };
  }

  async get(id: string) {
    const r = await this.prisma.report.findUnique({
      where: { id },
      include: {
        reporter: PLAYER,
        reportedUser: PLAYER,
        message: { select: { id: true, content: true, type: true, duration: true, senderId: true, createdAt: true } },
      },
    });
    if (!r) throw new NotFoundException('REPORT_NOT_FOUND');

    // Private messages: the reported message with up to 5 messages before and after it,
    // or the last 10 of the conversation when the whole chat was reported.
    let conversation: Array<{ id: string; senderId: string; username: string; text: string; createdAt: Date; reported: boolean }> = [];
    if (r.conversationId) {
      const pick = { id: true, senderId: true, content: true, type: true, duration: true, createdAt: true, sender: { select: { username: true } } } as const;
      const around = r.message?.createdAt ?? new Date();
      const [before, after] = await Promise.all([
        this.prisma.message.findMany({ where: { conversationId: r.conversationId, createdAt: { lte: around } }, orderBy: { createdAt: 'desc' }, take: r.message ? 6 : 10, select: pick }),
        r.message
          ? this.prisma.message.findMany({ where: { conversationId: r.conversationId, createdAt: { gt: around } }, orderBy: { createdAt: 'asc' }, take: 5, select: pick })
          : Promise.resolve([]),
      ]);
      conversation = [...before.reverse(), ...after].map((m) => ({
        id: m.id,
        senderId: m.senderId,
        username: m.sender.username,
        text: m.type === 'VOICE' ? `[voice message ${m.duration ?? 0}s]` : (m.content ?? ''),
        createdAt: m.createdAt,
        reported: m.id === r.messageId,
      }));
    }

    const [others, reviewer] = await Promise.all([
      this.prisma.report.findMany({
        where: { reportedUserId: r.reportedUserId, id: { not: r.id } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, reason: true, status: true, createdAt: true, source: true, conversationId: true, details: true },
      }),
      r.reviewedBy ? this.prisma.adminUser.findUnique({ where: { id: r.reviewedBy }, select: { name: true } }) : null,
    ]);

    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      source: sourceOf(r),
      details: r.details,
      createdAt: r.createdAt,
      reporter: r.reporter,
      reportedUser: r.reportedUser,
      conversation,
      review: r.reviewedAt ? { at: r.reviewedAt, by: reviewer?.name ?? 'Admin', resolution: r.resolution } : null,
      otherReports: others.map(({ conversationId, details, ...o }) => ({ ...o, source: sourceOf({ source: o.source, conversationId, details }) })),
    };
  }

  /** Close a report: REVIEWED (handled) or DISMISSED (nothing wrong); OPEN reopens it. */
  async setStatus(adminId: string, id: string, status: ReportStatus, resolution?: string) {
    const r = await this.prisma.report.findUnique({ where: { id }, select: { id: true } });
    if (!r) throw new NotFoundException('REPORT_NOT_FOUND');
    const note = resolution?.trim().slice(0, 300) || null;
    const reopening = status === ReportStatus.OPEN;
    await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id },
        data: reopening
          ? { status, reviewedAt: null, reviewedBy: null, resolution: null }
          : { status, reviewedAt: new Date(), reviewedBy: adminId, resolution: note },
      }),
      this.prisma.adminAuditLog.create({ data: { adminId, action: `REPORT_${status}`, targetType: 'Report', targetId: id, details: { resolution: note } } }),
    ]);
    return { status };
  }

  /** Ban the reported player and close every open report against them. */
  async banFromReport(adminId: string, id: string, reason: string) {
    const r = await this.prisma.report.findUnique({ where: { id }, select: { reportedUserId: true } });
    if (!r) throw new NotFoundException('REPORT_NOT_FOUND');
    const why = reason?.trim();
    if (!why) throw new BadRequestException('REASON_REQUIRED');
    await this.players.setBan(adminId, r.reportedUserId, { isBanned: true, reason: why });
    const closed = await this.prisma.report.updateMany({
      where: { reportedUserId: r.reportedUserId, status: ReportStatus.OPEN },
      data: { status: ReportStatus.REVIEWED, reviewedAt: new Date(), reviewedBy: adminId, resolution: `Banned: ${why}`.slice(0, 300) },
    });
    return { banned: true, reportsClosed: closed.count };
  }

  private async openCounts(userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map<string, number>();
    const rows = await this.prisma.report.groupBy({
      by: ['reportedUserId'],
      where: { reportedUserId: { in: ids }, status: ReportStatus.OPEN },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.reportedUserId, r._count._all]));
  }
}

/** Table and Global Chat reports start with a "Table chat, match …:" line; drop it for the list. */
function stripHeader(details: string | null): string | null {
  if (!details) return null;
  const nl = details.indexOf('\n');
  return /^(Table chat|Global chat)/.test(details) && nl >= 0 ? details.slice(nl + 1) : details;
}

function snippet(text: string | null): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 140 ? one.slice(0, 137) + '…' : one;
}
