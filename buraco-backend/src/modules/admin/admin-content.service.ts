import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CLUB_POINTS_PER_LEVEL } from '../clubs/clubs.service';
import { xpForNextLevel } from '../stats/stats.service';
import {
  CreateAchievementDto, CreateClubObjectiveDto, UpdateAchievementDto, UpdateClubObjectiveDto,
} from './dto/admin-content.dto';

/**
 * Game content for super admins: achievements, weekly clan objectives, and the level table
 * (read-only: it follows a fixed formula in the game server). Missions stay in AdminService.
 * Every change is audit-logged with what it was before and after.
 */
@Injectable()
export class AdminContentService {
  constructor(private prisma: PrismaService) {}

  // ─── Achievements ────────────────────────────────────────────────────────────

  async listAchievements() {
    const [rows, completed, claimed] = await Promise.all([
      this.prisma.achievement.findMany({ orderBy: [{ sortOrder: 'asc' }, { targetValue: 'asc' }] }),
      this.prisma.achievementProgress.groupBy({ by: ['achievementId'], where: { completedAt: { not: null } }, _count: { _all: true } }),
      this.prisma.achievementProgress.groupBy({ by: ['achievementId'], where: { claimedAt: { not: null } }, _count: { _all: true } }),
    ]);
    const done = new Map(completed.map((c) => [c.achievementId, c._count._all]));
    const paid = new Map(claimed.map((c) => [c.achievementId, c._count._all]));
    return rows.map((a) => ({ ...a, completedBy: done.get(a.id) ?? 0, claimedBy: paid.get(a.id) ?? 0 }));
  }

  async createAchievement(adminId: string, dto: CreateAchievementDto) {
    const row = await this.prisma.achievement.create({ data: clean(dto) as Prisma.AchievementCreateInput });
    await this.audit(adminId, 'CREATE_ACHIEVEMENT', 'Achievement', row.id, { title: row.title });
    return row;
  }

  async updateAchievement(adminId: string, id: string, dto: UpdateAchievementDto) {
    const before = await this.prisma.achievement.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('ACHIEVEMENT_NOT_FOUND');
    const data = clean(dto);
    const changes = diff(before as Record<string, unknown>, data);
    if (Object.keys(changes).length === 0) return before;
    const row = await this.prisma.achievement.update({ where: { id }, data: data as Prisma.AchievementUpdateInput });
    await this.audit(adminId, 'UPDATE_ACHIEVEMENT', 'Achievement', id, { title: before.title, changes });
    return row;
  }

  /** Only an achievement nobody has made progress on can be deleted; otherwise switch it off. */
  async deleteAchievement(adminId: string, id: string) {
    const row = await this.prisma.achievement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('ACHIEVEMENT_NOT_FOUND');
    if ((await this.prisma.achievementProgress.count({ where: { achievementId: id } })) > 0) {
      throw new BadRequestException('ACHIEVEMENT_HAS_PROGRESS');
    }
    await this.prisma.achievement.delete({ where: { id } });
    await this.audit(adminId, 'DELETE_ACHIEVEMENT', 'Achievement', id, { title: row.title });
    return { deleted: true };
  }

  // ─── Weekly clan objectives ──────────────────────────────────────────────────

  async listObjectives() {
    const [rows, done] = await Promise.all([
      this.prisma.clubObjective.findMany({ orderBy: [{ sortOrder: 'asc' }, { targetValue: 'asc' }] }),
      this.prisma.clubObjectiveProgress.groupBy({ by: ['objectiveId'], where: { completedAt: { not: null } }, _count: { _all: true } }),
    ]);
    const completed = new Map(done.map((d) => [d.objectiveId, d._count._all]));
    return rows.map((o) => ({ ...o, completedTimes: completed.get(o.id) ?? 0 }));
  }

  async createObjective(adminId: string, dto: CreateClubObjectiveDto) {
    const row = await this.prisma.clubObjective.create({ data: clean(dto) as Prisma.ClubObjectiveCreateInput });
    await this.audit(adminId, 'CREATE_CLUB_OBJECTIVE', 'ClubObjective', row.id, { title: row.title });
    return row;
  }

  async updateObjective(adminId: string, id: string, dto: UpdateClubObjectiveDto) {
    const before = await this.prisma.clubObjective.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('OBJECTIVE_NOT_FOUND');
    const data = clean(dto);
    const changes = diff(before as Record<string, unknown>, data);
    if (Object.keys(changes).length === 0) return before;
    const row = await this.prisma.clubObjective.update({ where: { id }, data: data as Prisma.ClubObjectiveUpdateInput });
    await this.audit(adminId, 'UPDATE_CLUB_OBJECTIVE', 'ClubObjective', id, { title: before.title, changes });
    return row;
  }

  async deleteObjective(adminId: string, id: string) {
    const row = await this.prisma.clubObjective.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('OBJECTIVE_NOT_FOUND');
    if ((await this.prisma.clubObjectiveProgress.count({ where: { objectiveId: id } })) > 0) {
      throw new BadRequestException('OBJECTIVE_HAS_PROGRESS');
    }
    await this.prisma.clubObjective.delete({ where: { id } });
    await this.audit(adminId, 'DELETE_CLUB_OBJECTIVE', 'ClubObjective', id, { title: row.title });
    return { deleted: true };
  }

  // ─── Level table (read-only) ─────────────────────────────────────────────────

  /**
   * XP each player level needs (same formula as the game: 100 × level up to 10, 200 × level
   * up to 30, then 350 × level), with how many players are at each level, plus the clan rule.
   */
  async levels(upTo = 50) {
    const max = Math.min(200, Math.max(1, Math.floor(upTo) || 50));
    const counts = await this.prisma.playerStats.groupBy({ by: ['level'], _count: { _all: true } });
    const players = new Map(counts.map((c) => [c.level, c._count._all]));
    const levels: { level: number; xpForLevel: number; xpToReach: number; players: number }[] = [];
    let total = 0;
    for (let level = 1; level <= max; level++) {
      const xpForLevel = xpForNextLevel(level);
      levels.push({ level, xpForLevel, xpToReach: total, players: players.get(level) ?? 0 });
      total += xpForLevel;
    }
    const above = counts.filter((c) => c.level > max).reduce((n, c) => n + c._count._all, 0);
    return { levels, playersAbove: above, clubPointsPerLevel: CLUB_POINTS_PER_LEVEL };
  }

  private async audit(adminId: string, action: string, targetType: string, targetId: string, details: object) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType, targetId, details } });
  }
}

/** Trim text fields and drop undefined, so a partial update only touches what was sent. */
function clean(dto: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dto)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

function diff(before: Record<string, unknown>, data: Record<string, unknown>) {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(data)) {
    if ((before[k] ?? null) !== (v ?? null)) out[k] = [before[k] ?? null, v ?? null];
  }
  return out;
}
