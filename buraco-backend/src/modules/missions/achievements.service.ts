import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Achievement, GameMode, NotificationType, Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EconomyService } from '../economy/economy.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ProgressChange } from './missions.service';

/**
 * Lifetime achievements ("Win 10 games → 1,000 coins"). Unlike daily/weekly missions they
 * never reset: every player works on all active achievements at once, and each reward is
 * claimed once. Counted by the same events as missions (matches, messages, joining a club).
 */
@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(
    private prisma: PrismaService,
    private economy: EconomyService,
    private notifications: NotificationsService,
  ) {}

  /** Every active achievement with this player's progress; completed-but-unclaimed first. */
  async list(userId: string) {
    const [achievements, progress] = await Promise.all([
      this.prisma.achievement.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { targetValue: 'asc' }] }),
      this.prisma.achievementProgress.findMany({ where: { userId } }),
    ]);
    const byId = new Map(progress.map((p) => [p.achievementId, p]));

    const rows = achievements.map((a) => {
      const p = byId.get(a.id);
      return {
        id: a.id,
        title: a.title,
        description: a.description,
        requirement: a.requirement,
        mode: a.mode,
        targetValue: a.targetValue,
        currentValue: Math.min(p?.currentValue ?? 0, a.targetValue),
        rewardCoins: a.rewardCoins,
        rewardDiamonds: a.rewardDiamonds,
        isCompleted: !!p?.completedAt,
        isClaimed: !!p?.claimedAt,
        completedAt: p?.completedAt ?? null,
        claimedAt: p?.claimedAt ?? null,
      };
    });
    // Ready to claim → in progress → already claimed.
    const rank = (r: (typeof rows)[number]) => (r.isCompleted && !r.isClaimed ? 0 : r.isClaimed ? 2 : 1);
    rows.sort((x, y) => rank(x) - rank(y));

    return {
      data: rows,
      summary: {
        total: rows.length,
        completed: rows.filter((r) => r.isCompleted).length,
        readyToClaim: rows.filter((r) => r.isCompleted && !r.isClaimed).length,
      },
    };
  }

  async claim(userId: string, achievementId: string) {
    const progress = await this.prisma.achievementProgress.findUnique({
      where: { userId_achievementId: { userId, achievementId } },
      include: { achievement: true },
    });
    if (!progress) throw new NotFoundException('Achievement not found');
    if (!progress.completedAt) throw new BadRequestException('ACHIEVEMENT_NOT_COMPLETED');

    // Conditional: of two claims racing, only one sets claimedAt and gets paid.
    const claimed = await this.prisma.achievementProgress.updateMany({
      where: { id: progress.id, completedAt: { not: null }, claimedAt: null },
      data: { claimedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestException('REWARD_ALREADY_CLAIMED');

    const { rewardCoins, rewardDiamonds } = progress.achievement;
    if (rewardCoins > 0) await this.economy.addCoins(userId, rewardCoins, TransactionType.ACHIEVEMENT_REWARD, achievementId);
    if (rewardDiamonds > 0) await this.economy.addDiamonds(userId, rewardDiamonds, TransactionType.ACHIEVEMENT_REWARD, achievementId);

    return { reward: { coins: rewardCoins, diamonds: rewardDiamonds }, newBalance: await this.economy.getBalance(userId) };
  }

  /** Never throws: progress must not break the match or message that caused it. */
  async advanceSafely(userId: string, changes: ProgressChange[], mode?: GameMode) {
    try {
      return await this.advance(userId, changes, mode);
    } catch (err) {
      this.logger.error(`Achievement progress failed for ${userId}`, err as Error);
      return [];
    }
  }

  /**
   * Apply changes and return the achievements this call completed. An achievement tied to a
   * mode counts only that mode's matches; events with no mode (messages, joining a club)
   * count only for achievements with no mode.
   */
  async advance(userId: string, changes: ProgressChange[], mode?: GameMode): Promise<Achievement[]> {
    const wanted = changes.filter((c) => (c.add ?? 0) > 0 || (c.atLeast ?? 0) > 0);
    if (wanted.length === 0) return [];

    const modeFilter: Prisma.AchievementWhereInput = mode ? { OR: [{ mode: null }, { mode }] } : { mode: null };
    const achievements = await this.prisma.achievement.findMany({
      where: { isActive: true, requirement: { in: wanted.map((c) => c.requirement) }, ...modeFilter },
    });
    if (achievements.length === 0) return [];

    await this.prisma.achievementProgress.createMany({
      data: achievements.map((a) => ({ userId, achievementId: a.id })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.achievementProgress.findMany({
      where: { userId, achievementId: { in: achievements.map((a) => a.id) }, completedAt: null },
    });
    const byId = new Map(achievements.map((a) => [a.id, a]));

    const completed: Achievement[] = [];
    for (const row of rows) {
      const a = byId.get(row.achievementId)!;
      let reached = row.currentValue;
      for (const change of wanted.filter((c) => c.requirement === a.requirement)) {
        if (change.add) {
          reached = (await this.prisma.achievementProgress.update({
            where: { id: row.id },
            data: { currentValue: { increment: change.add } },
          })).currentValue;
        }
        if (change.atLeast && change.atLeast > reached) {
          await this.prisma.achievementProgress.updateMany({
            where: { id: row.id, currentValue: { lt: change.atLeast } },
            data: { currentValue: change.atLeast },
          });
          reached = change.atLeast;
        }
      }
      if (reached >= a.targetValue) {
        const done = await this.prisma.achievementProgress.updateMany({
          where: { id: row.id, completedAt: null },
          data: { completedAt: new Date(), currentValue: a.targetValue },
        });
        if (done.count === 1) completed.push(a);
      }
    }

    for (const a of completed) {
      await this.notifications.notifySafely(userId, NotificationType.REWARD, 'Achievement unlocked',
        `${a.title} — claim your reward`,
        { event: 'ACHIEVEMENT_COMPLETED', achievementId: a.id, rewardCoins: a.rewardCoins, rewardDiamonds: a.rewardDiamonds });
    }
    return completed;
  }
}
