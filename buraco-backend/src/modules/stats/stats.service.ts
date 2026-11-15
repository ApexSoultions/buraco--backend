import { Injectable, NotFoundException } from '@nestjs/common';
import { GameMode } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

/**
 * Redis sorted sets behind the leaderboards:
 * - classic: points earned in Classic-mode matches (PlayerStats.classicPoints), the
 *   game's "Barasilian" ranking
 * - hand: points earned in Professional-mode matches (PlayerStats.professionalPoints), the
 *   game's "Hand" ranking
 * - international: wins across all modes (PlayerStats.wins)
 */
export const RANKING_KEYS = {
  classic: 'ranking:classic',
  hand: 'ranking:hand',
  international: 'ranking:international',
} as const;
export type RankingType = keyof typeof RANKING_KEYS;

@Injectable()
export class StatsService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  async getStats(userId: string) {
    const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
    if (!stats) throw new NotFoundException('Stats not found');

    const progress = this.levelProgress(stats.level, stats.experience);
    return { ...stats, experienceToNextLevel: progress.xpForLevel - progress.xpIntoLevel, levelProgress: progress };
  }

  /**
   * Where a player stands inside their current level. `experience` is total XP since the
   * start; each level needs xpForNextLevel(level) more on top of all earlier levels.
   */
  levelProgress(level: number, experience: number) {
    let accumulated = 0;
    for (let l = 1; l < level; l++) accumulated += this.xpForNextLevel(l);
    const xpForLevel = this.xpForNextLevel(level);
    const xpIntoLevel = Math.min(Math.max(experience - accumulated, 0), xpForLevel);
    return {
      level,
      nextLevel: level + 1,
      xpIntoLevel,
      xpForLevel,
      percent: xpForLevel > 0 ? Math.floor((xpIntoLevel / xpForLevel) * 100) : 0,
    };
  }

  /**
   * `mode` decides which ranking the points count for: CLASSIC adds to classicPoints (the
   * Classic ranking); every match counts for the International ranking through `wins`.
   */
  async updateAfterMatch(userId: string, result: 'WIN' | 'LOSS' | 'ABANDONED', pointsEarned: number, xpEarned: number, mode?: GameMode) {
    const stats = await this.prisma.playerStats.findUnique({ where: { userId } });
    if (!stats) return;

    const isWin = result === 'WIN';
    const isLoss = result === 'LOSS';

    const newWins = isWin ? stats.wins + 1 : stats.wins;
    const newLosses = isLoss ? stats.losses + 1 : stats.losses;
    const newGamesLeft = result === 'ABANDONED' ? stats.gamesLeft + 1 : stats.gamesLeft;
    const newGamesPlayed = stats.gamesPlayed + 1;
    const newStreak = isWin ? stats.winStreak + 1 : 0;
    const newBestStreak = Math.max(stats.bestWinStreak, newStreak);
    const newXP = stats.experience + xpEarned;
    const newPoints = stats.points + pointsEarned;
    const newLevel = this.calculateLevel(newXP);
    const newWinPct = newGamesPlayed > 0 ? (newWins / newGamesPlayed) * 100 : 0;

    const updated = await this.prisma.playerStats.update({
      where: { userId },
      data: {
        wins: newWins,
        losses: newLosses,
        gamesLeft: newGamesLeft,
        gamesPlayed: newGamesPlayed,
        winStreak: newStreak,
        bestWinStreak: newBestStreak,
        experience: newXP,
        points: newPoints,
        ...(mode === GameMode.CLASSIC && pointsEarned > 0 && { classicPoints: { increment: pointsEarned } }),
        ...(mode === GameMode.PROFESSIONAL && pointsEarned > 0 && { professionalPoints: { increment: pointsEarned } }),
        level: newLevel,
        winPercentage: Math.round(newWinPct * 100) / 100,
      },
    });

    await this.syncRankings(updated);
    return updated;
  }

  async addPoints(userId: string, points: number) {
    const stats = await this.prisma.playerStats.update({
      where: { userId },
      data: { points: { increment: points } },
    });
    await this.syncRankings(stats);
    return stats;
  }

  /**
   * Write a player's scores into both ranking sets. They used to receive the same total
   * points, which made the two leaderboards identical.
   */
  async syncRankings(stats: { userId: string; classicPoints: number; professionalPoints: number; wins: number }) {
    await this.redis.zadd(RANKING_KEYS.classic, stats.classicPoints, stats.userId);
    await this.redis.zadd(RANKING_KEYS.hand, stats.professionalPoints, stats.userId);
    await this.redis.zadd(RANKING_KEYS.international, stats.wins, stats.userId);
  }

  calculateLevel(xp: number): number {
    let level = 1;
    let accumulated = 0;
    while (true) {
      const needed = this.xpForNextLevel(level);
      if (accumulated + needed > xp) break;
      accumulated += needed;
      level++;
    }
    return level;
  }

  /**
   * The Level List: every level from 1 to `upTo`, the XP that level needs, and the total XP
   * at which a player reaches it (same formula as levelProgress / calculateLevel).
   * With a player, also their level and total XP so the list can mark where they are.
   */
  async levelTable(upTo = 50, userId?: string) {
    const max = Math.min(200, Math.max(1, Math.floor(upTo) || 50));
    const levels: Array<{ level: number; xpToReach: number; xpForLevel: number }> = [];
    let total = 0;
    for (let level = 1; level <= max; level++) {
      const xpForLevel = this.xpForNextLevel(level);
      levels.push({ level, xpToReach: total, xpForLevel });
      total += xpForLevel;
    }
    let me: { level: number; experience: number } | null = null;
    if (userId) {
      const stats = await this.prisma.playerStats.findUnique({ where: { userId }, select: { level: true, experience: true } });
      if (stats) me = stats;
    }
    return { levels, me };
  }

  private xpForNextLevel(level: number): number {
    if (level <= 10) return level * 100;
    if (level <= 30) return level * 200;
    return level * 350;
  }
}
