import { ForbiddenException } from '@nestjs/common';
import { ClubRole, MemberStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export const ALL_ROLES = [ClubRole.LEADER, ClubRole.VICE_LEADER, ClubRole.MEMBER];
export const OFFICERS = [ClubRole.LEADER, ClubRole.VICE_LEADER];

/** The player's active membership of this club with one of `roles`, or 403. */
export async function requireClubRole(prisma: PrismaService, userId: string, clubId: string, roles: ClubRole[] = ALL_ROLES) {
  const member = await prisma.clubMember.findUnique({ where: { clubId_userId: { clubId, userId } } });
  if (!member || member.status !== MemberStatus.ACTIVE || !roles.includes(member.role)) {
    throw new ForbiddenException('Insufficient club permissions');
  }
  return member;
}

export function pageArgs(page?: number, limit?: number, max = 50) {
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const l = Math.min(max, Math.max(1, Math.floor(Number(limit)) || 20));
  return { page: p, limit: l, skip: (p - 1) * l };
}

export function pageMeta(total: number, page: number, limit: number) {
  return { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
