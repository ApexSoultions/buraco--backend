import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

type Rule = { exact?: string[]; contains?: string[]; startsWith?: string[] };

/** The groups on the audit page, as rules over the action name. */
export const AUDIT_GROUPS: Record<string, Rule> = {
  Players: { exact: ['BAN_USER', 'UNBAN_USER', 'EDIT_USER', 'CREDIT_USER', 'DEDUCT_USER', 'GIVE_LIVES', 'TAKE_LIVES', 'RESET_NAME', 'SEND_ITEM', 'RESET_PLAYER_STATS', 'SET_PLAYER_SCORE'] },
  Moderation: { startsWith: ['REPORT_', 'GLOBAL_CHAT_'], contains: ['CUSTOM_CARD'], exact: ['VOID_GAME'] },
  Clans: { startsWith: ['CLUB_'], exact: ['DELETE_CLUB'] },
  Economy: { contains: ['SHOP_', 'PROMO'] },
  Content: { contains: ['MISSION', 'ACHIEVEMENT', 'CLUB_OBJECTIVE'] },
  Support: { startsWith: ['SUPPORT_'] },
  System: { exact: ['UPDATE_SETTING', 'UPDATE_CONFIG', 'BROADCAST'] },
  Staff: { exact: ['CREATE_ADMIN', 'UPDATE_ADMIN', 'CHANGE_OWN_PASSWORD'], startsWith: ['ADMIN_LOGIN'] },
};

const SECRET_KEY = /secret|pass|token|private|key$/i;

/** Hides secret values that older log entries may hold (settings changed before secrets were kept out of the log). */
export function redact(action: string, targetId: string, details: unknown): unknown {
  if (!details || typeof details !== 'object') return details;
  if (action === 'UPDATE_CONFIG' && SECRET_KEY.test(targetId)) return { hidden: 'The old value was a secret and is not shown.' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '••••••' : v;
  }
  return out;
}

/**
 * The audit log for super admins: filter by group, staff member, action, words and dates; every
 * entry with who did it and what changed. Secret values are never shown.
 */
@Injectable()
export class AdminAuditService {
  constructor(private prisma: PrismaService) {}

  async list(opts: { page?: number; limit?: number; group?: string; adminId?: string; action?: string; q?: string; from?: string; to?: string }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const and: Prisma.AdminAuditLogWhereInput[] = [];

    const rule = opts.group ? AUDIT_GROUPS[opts.group] : undefined;
    if (rule) {
      and.push({
        OR: [
          ...(rule.exact ? [{ action: { in: rule.exact } }] : []),
          ...(rule.startsWith ?? []).map((p) => ({ action: { startsWith: p } })),
          ...(rule.contains ?? []).map((p) => ({ action: { contains: p } })),
        ],
      });
    }
    if (opts.adminId) and.push({ adminId: opts.adminId });
    if (opts.action) and.push({ action: opts.action });
    const q = opts.q?.trim();
    if (q) and.push({ OR: [{ action: { contains: q.toUpperCase().replace(/\s+/g, '_') } }, { targetId: { contains: q, mode: 'insensitive' } }, { targetType: { contains: q, mode: 'insensitive' } }] });
    const from = day(opts.from);
    const to = day(opts.to);
    if (from || to) and.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 24 * 3600 * 1000) } : {}) } });
    const where: Prisma.AdminAuditLogWhereInput = and.length ? { AND: and } : {};

    const [rows, total, admins] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
        include: { admin: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminUser.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id, action: r.action, targetType: r.targetType, targetId: r.targetId, createdAt: r.createdAt,
        details: redact(r.action, r.targetId, r.details), admin: r.admin,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      groups: Object.keys(AUDIT_GROUPS),
      admins,
    };
  }
}

function day(value?: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}
