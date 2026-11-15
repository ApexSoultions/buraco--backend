import { Injectable, NotFoundException } from '@nestjs/common';
import { ClubObjective, GameMode, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ProgressChange } from '../missions/missions.service';

/** ISO week of `d` in UTC, e.g. "2026-W46". Objectives start again from zero each week. */
export function weekPeriod(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Next Monday 00:00 UTC: when this week's objectives end. */
export function nextWeekStart(d = new Date()): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + (8 - day));
  return t;
}

/**
 * Clan Objectives ("Win 20 games"): weekly goals for a whole club. Every active member's
 * matches count. Rewards are paid by ClubsService when a call here reports a completion.
 */
@Injectable()
export class ClubObjectivesService {
  constructor(private prisma: PrismaService) {}

  async list(clubId: string, now = new Date()) {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
    if (!club) throw new NotFoundException('Club not found');

    const period = weekPeriod(now);
    const [objectives, progress] = await Promise.all([
      this.prisma.clubObjective.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { targetValue: 'asc' }] }),
      this.prisma.clubObjectiveProgress.findMany({ where: { clubId, period } }),
    ]);
    const byId = new Map(progress.map((p) => [p.objectiveId, p]));
    const data = objectives.map((o) => {
      const p = byId.get(o.id);
      return {
        id: o.id,
        title: o.title,
        description: o.description,
        requirement: o.requirement,
        mode: o.mode,
        targetValue: o.targetValue,
        currentValue: Math.min(p?.currentValue ?? 0, o.targetValue),
        isCompleted: !!p?.completedAt,
        completedAt: p?.completedAt ?? null,
        rewardCoins: o.rewardCoins,
        rewardClubPoints: o.rewardClubPoints,
      };
    });
    return { data, period, endsAt: nextWeekStart(now) };
  }

  /** Apply one member's match to the club's objectives; returns the ones this completed. */
  async advance(clubId: string, changes: ProgressChange[], mode?: GameMode, now = new Date()): Promise<ClubObjective[]> {
    const wanted = changes.filter((c) => (c.add ?? 0) > 0 || (c.atLeast ?? 0) > 0);
    if (wanted.length === 0) return [];

    const modeFilter: Prisma.ClubObjectiveWhereInput = mode ? { OR: [{ mode: null }, { mode }] } : { mode: null };
    const objectives = await this.prisma.clubObjective.findMany({
      where: { isActive: true, requirement: { in: wanted.map((c) => c.requirement) }, ...modeFilter },
    });
    if (objectives.length === 0) return [];

    const period = weekPeriod(now);
    await this.prisma.clubObjectiveProgress.createMany({
      data: objectives.map((o) => ({ clubId, objectiveId: o.id, period })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.clubObjectiveProgress.findMany({
      where: { clubId, period, objectiveId: { in: objectives.map((o) => o.id) }, completedAt: null },
    });
    const byId = new Map(objectives.map((o) => [o.id, o]));

    const completed: ClubObjective[] = [];
    for (const row of rows) {
      const o = byId.get(row.objectiveId)!;
      let reached = row.currentValue;
      for (const change of wanted.filter((c) => c.requirement === o.requirement)) {
        if (change.add) {
          reached = (await this.prisma.clubObjectiveProgress.update({
            where: { id: row.id },
            data: { currentValue: { increment: change.add } },
          })).currentValue;
        }
        if (change.atLeast && change.atLeast > reached) {
          await this.prisma.clubObjectiveProgress.updateMany({
            where: { id: row.id, currentValue: { lt: change.atLeast } },
            data: { currentValue: change.atLeast },
          });
          reached = change.atLeast;
        }
      }
      if (reached >= o.targetValue) {
        // Conditional so two members finishing matches together pay the reward once.
        const done = await this.prisma.clubObjectiveProgress.updateMany({
          where: { id: row.id, completedAt: null },
          data: { completedAt: new Date(), currentValue: o.targetValue },
        });
        if (done.count === 1) completed.push(o);
      }
    }
    return completed;
  }
}
