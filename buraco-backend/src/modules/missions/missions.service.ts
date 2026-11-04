import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GameMode, Mission, MissionRequirement, MissionType, NotificationType, TransactionType } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EconomyService } from '../economy/economy.service';
import { NotificationsService } from '../notifications/notifications.service';

const DAILY_MISSION_COUNT = 3;
const WEEKLY_MISSION_COUNT = 3;

/** Up to `count` distinct items in random order (Fisher–Yates on a copy). */
export function pickRandom<T>(items: T[], count: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, count));
}

/** One change to a requirement: `add` counts up, `atLeast` raises to a value (streaks). */
type ProgressChange = { requirement: MissionRequirement; add?: number; atLeast?: number };

export interface MatchProgress {
  mode: GameMode;
  isWinner: boolean;
  pointsEarned: number;
  /** The player's win streak after this match (0 after a loss). */
  winStreak: number;
}

@Injectable()
export class MissionsService {
  private readonly logger = new Logger(MissionsService.name);

  constructor(
    private prisma: PrismaService,
    private economyService: EconomyService,
    private notifications: NotificationsService,
  ) {}

  async getActiveMissions(userId: string) {
    await this.ensureMissionsAssigned(userId);

    const progress = await this.prisma.missionProgress.findMany({
      where: { userId, isClaimed: false },
      include: { mission: true },
    });

    const daily = progress.filter((p) => p.mission.type === MissionType.DAILY);
    const weekly = progress.filter((p) => p.mission.type === MissionType.WEEKLY);
    return { daily, weekly };
  }

  async claimReward(userId: string, missionId: string) {
    const progress = await this.prisma.missionProgress.findUnique({
      where: { userId_missionId: { userId, missionId } },
      include: { mission: true },
    });

    if (!progress) throw new NotFoundException('Mission not found');
    if (!progress.isCompleted) throw new BadRequestException('MISSION_NOT_COMPLETED');
    if (progress.isClaimed) throw new BadRequestException('REWARD_ALREADY_CLAIMED');

    // Conditional update: of two claims racing, only one flips isClaimed and gets paid.
    const claimed = await this.prisma.missionProgress.updateMany({
      where: { userId, missionId, isCompleted: true, isClaimed: false },
      data: { isClaimed: true, claimedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestException('REWARD_ALREADY_CLAIMED');

    const { rewardCoins, rewardDiamonds } = progress.mission;
    const ops: Promise<any>[] = [];
    if (rewardCoins > 0) ops.push(this.economyService.addCoins(userId, rewardCoins, TransactionType.MISSION_REWARD, missionId));
    if (rewardDiamonds > 0) ops.push(this.economyService.addDiamonds(userId, rewardDiamonds, TransactionType.MISSION_REWARD, missionId));
    await Promise.all(ops);

    const balance = await this.economyService.getBalance(userId);
    return { reward: { coins: rewardCoins, diamonds: rewardDiamonds }, newBalance: balance };
  }

  async updateProgress(userId: string, event: MissionRequirement, value = 1) {
    return this.advance(userId, [{ requirement: event, add: value }]);
  }

  /** Everything one finished match counts towards, applied in one pass. */
  async recordMatch(userId: string, match: MatchProgress) {
    const changes: ProgressChange[] = [{ requirement: MissionRequirement.PLAY_GAMES, add: 1 }];
    if (match.isWinner) changes.push({ requirement: MissionRequirement.WIN_GAMES, add: 1 });
    if (match.pointsEarned > 0) changes.push({ requirement: MissionRequirement.EARN_POINTS, add: match.pointsEarned });
    if (match.mode === GameMode.CLASSIC) changes.push({ requirement: MissionRequirement.PLAY_CLASSIC, add: 1 });
    if (match.mode === GameMode.PROFESSIONAL) changes.push({ requirement: MissionRequirement.PLAY_PROFESSIONAL, add: 1 });
    if (match.winStreak > 0) changes.push({ requirement: MissionRequirement.WIN_STREAK, atLeast: match.winStreak });
    return this.advance(userId, changes);
  }

  /**
   * Mission progress must never break what triggered it — a settled match, a sent
   * message, a club join — so callers outside this module use the safe variants.
   */
  async recordMatchSafely(userId: string, match: MatchProgress) {
    try {
      await this.recordMatch(userId, match);
    } catch (err) {
      this.logger.error(`Mission progress after match failed for ${userId}`, err as Error);
    }
  }

  async updateProgressSafely(userId: string, event: MissionRequirement, value = 1) {
    try {
      await this.updateProgress(userId, event, value);
    } catch (err) {
      this.logger.error(`Mission progress ${event} failed for ${userId}`, err as Error);
    }
  }

  /**
   * Apply changes to the player's open missions and return the ones this call completed.
   *
   * Missions are assigned first: before, they were only assigned when the player opened
   * the missions screen, so games played before that never counted. Writes are atomic
   * increments plus a conditional "complete" update, so two events landing together
   * neither lose a count nor send the completion notification twice.
   */
  private async advance(userId: string, changes: ProgressChange[]): Promise<Mission[]> {
    const wanted = changes.filter((c) => (c.add ?? 0) > 0 || (c.atLeast ?? 0) > 0);
    if (wanted.length === 0) return [];

    await this.ensureMissionsAssigned(userId);

    const open = await this.prisma.missionProgress.findMany({
      where: {
        userId,
        isClaimed: false,
        isCompleted: false,
        mission: { requirement: { in: wanted.map((c) => c.requirement) }, isActive: true },
      },
      include: { mission: true },
    });

    const completed: Mission[] = [];
    for (const p of open) {
      const target = p.mission.targetValue;
      let reached = p.currentValue;
      for (const change of wanted.filter((c) => c.requirement === p.mission.requirement)) {
        if (change.add) {
          const row = await this.prisma.missionProgress.update({
            where: { id: p.id },
            data: { currentValue: { increment: change.add } },
          });
          reached = row.currentValue;
        }
        if (change.atLeast && change.atLeast > reached) {
          await this.prisma.missionProgress.updateMany({
            where: { id: p.id, currentValue: { lt: change.atLeast } },
            data: { currentValue: change.atLeast },
          });
          reached = change.atLeast;
        }
      }

      if (reached >= target) {
        const done = await this.prisma.missionProgress.updateMany({
          where: { id: p.id, isCompleted: false },
          data: { isCompleted: true, currentValue: target },
        });
        if (done.count === 1) completed.push(p.mission);
      }
    }

    for (const mission of completed) {
      await this.notifications.notifySafely(userId, NotificationType.REWARD, 'Mission complete',
        `${mission.title} — claim your reward`,
        { event: 'MISSION_COMPLETED', missionId: mission.id, missionType: mission.type, rewardCoins: mission.rewardCoins, rewardDiamonds: mission.rewardDiamonds });
    }
    return completed;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async resetDailyMissions() {
    await this.prisma.missionProgress.deleteMany({
      where: { mission: { type: MissionType.DAILY } },
    });
  }

  @Cron('0 0 * * 1') // Every Monday midnight
  async resetWeeklyMissions() {
    await this.prisma.missionProgress.deleteMany({
      where: { mission: { type: MissionType.WEEKLY } },
    });
  }

  private async ensureMissionsAssigned(userId: string) {
    const existingDaily = await this.prisma.missionProgress.count({
      where: { userId, mission: { type: MissionType.DAILY } },
    });

    if (existingDaily < DAILY_MISSION_COUNT) {
      await this.assignMissions(userId, MissionType.DAILY, DAILY_MISSION_COUNT - existingDaily);
    }

    const existingWeekly = await this.prisma.missionProgress.count({
      where: { userId, mission: { type: MissionType.WEEKLY } },
    });

    if (existingWeekly < WEEKLY_MISSION_COUNT) {
      await this.assignMissions(userId, MissionType.WEEKLY, WEEKLY_MISSION_COUNT - existingWeekly);
    }
  }

  private async assignMissions(userId: string, type: MissionType, count: number) {
    const existing = await this.prisma.missionProgress.findMany({
      where: { userId, mission: { type } },
      select: { missionId: true },
    });
    const excludeIds = existing.map((p) => p.missionId);

    // Random pick from the active pool: taking the oldest `count` every time handed every
    // player the same missions forever and left the rest of the pool unused.
    const pool = await this.prisma.mission.findMany({
      where: { type, isActive: true, id: { notIn: excludeIds } },
    });
    const missions = pickRandom(pool, count);

    if (missions.length > 0) {
      await this.prisma.missionProgress.createMany({
        data: missions.map((m) => ({ userId, missionId: m.id })),
        skipDuplicates: true,
      });
    }
  }
}
