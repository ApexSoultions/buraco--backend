import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { RANKING_KEYS, RankingType } from '../stats/stats.service';

const MAX_PAGE_SIZE = 100;

/** Bump RANKING_SCHEME whenever what the ranking sets hold changes; startup then rebuilds them. */
const RANKING_SCHEME_KEY = 'ranking:scheme';
const RANKING_SCHEME = 'classicPoints+wins/v2';

@Injectable()
export class RankingsService implements OnModuleInit {
  private readonly logger = new Logger(RankingsService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  /**
   * The leaderboards live in Redis, but the scores live in the database. Rebuild both sets
   * from player_stats when Redis comes up empty (a flush, a new server) or still holds sets
   * written by an older scoring scheme — the live server's sets give both boards the same
   * total points, and would otherwise stay wrong until each player's next match.
   */
  async onModuleInit() {
    try {
      const [classic, international, version] = await Promise.all([
        this.redis.zcard(RANKING_KEYS.classic),
        this.redis.zcard(RANKING_KEYS.international),
        this.redis.get(RANKING_SCHEME_KEY),
      ]);
      if (classic === 0 || international === 0 || version !== RANKING_SCHEME) await this.rebuild();
    } catch (err) {
      this.logger.error('Ranking rebuild at startup failed', err as Error);
    }
  }

  /** Recompute both ranking sets from the database. Safe to run any time. */
  async rebuild() {
    const rows = await this.prisma.playerStats.findMany({
      where: { user: { isDeleted: false } },
      select: { userId: true, classicPoints: true, wins: true },
    });
    await this.redis.del(RANKING_KEYS.classic);
    await this.redis.del(RANKING_KEYS.international);
    for (const r of rows) {
      await this.redis.zadd(RANKING_KEYS.classic, r.classicPoints, r.userId);
      await this.redis.zadd(RANKING_KEYS.international, r.wins, r.userId);
    }
    await this.redis.set(RANKING_SCHEME_KEY, RANKING_SCHEME);
    this.logger.log(`Rankings rebuilt from player_stats: ${rows.length} players`);
    return { players: rows.length };
  }

  async getClassicRanking(page = 1, limit = 50, requestingUserId?: string) {
    return this.getRanking('classic', page, limit, requestingUserId);
  }

  async getInternationalRanking(page = 1, limit = 50, requestingUserId?: string) {
    return this.getRanking('international', page, limit, requestingUserId);
  }

  private async getRanking(type: RankingType, page: number, limit: number, requestingUserId?: string) {
    const key = RANKING_KEYS[type];
    page = Math.max(1, Math.floor(page) || 1);
    limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit) || 50));
    const offset = (page - 1) * limit;
    const total = await this.redis.zcard(key);
    // Read exactly this page. The old code fetched the first `limit` entries and then
    // sliced from `offset`, so every page after the first came back empty.
    const entries = await this.redis.zrevrangeWithScores(key, offset, offset + limit - 1);

    const userIds = entries.map((e) => e.member);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, isDeleted: false },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        stats: { select: { level: true, classicPoints: true, wins: true } },
        clubMemberships: {
          where: { status: 'ACTIVE' },
          select: { role: true, club: { select: { name: true } } },
          take: 1,
        },
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));
    const ranked = entries.map((entry, idx) => {
      const user = userMap.get(entry.member);
      if (!user) return null;
      const membership = user.clubMemberships[0];
      return {
        rank: offset + idx + 1,
        user: { id: user.id, username: user.username, avatarUrl: user.avatarUrl, level: user.stats?.level },
        // `score` is what this leaderboard is sorted by: Classic points, or total wins.
        score: entry.score,
        points: user.stats?.classicPoints ?? 0,
        wins: user.stats?.wins ?? 0,
        club: membership ? { name: membership.club.name, role: membership.role } : null,
      };
    }).filter(Boolean);

    let myRank: number | null = null;
    if (requestingUserId) {
      const rank = await this.redis.zrevrank(key, requestingUserId);
      myRank = rank !== null ? rank + 1 : null;
    }

    return {
      data: ranked,
      meta: {
        type,
        sortedBy: type === 'classic' ? 'classicPoints' : 'wins',
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        myRank,
      },
    };
  }

  async getPlayerRank(userId: string, type: string = 'classic') {
    if (type !== 'classic' && type !== 'international') throw new BadRequestException('type must be classic or international');
    const key = RANKING_KEYS[type];
    const rank = await this.redis.zrevrank(key, userId);
    const score = await this.redis.zscore(key, userId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, avatarUrl: true,
        stats: { select: { level: true, points: true, classicPoints: true, gamesPlayed: true, wins: true, winPercentage: true } },
        clubMemberships: {
          where: { status: 'ACTIVE' },
          select: { role: true, club: { select: { id: true, name: true } } },
          take: 1,
        },
      },
    });

    const membership = user?.clubMemberships?.[0];
    return {
      type,
      rank: rank !== null ? rank + 1 : null,
      score: score ? parseInt(score, 10) : 0,
      points: user?.stats?.classicPoints ?? 0,
      wins: user?.stats?.wins ?? 0,
      user: { id: user?.id, username: user?.username, avatarUrl: user?.avatarUrl, level: user?.stats?.level },
      stats: user?.stats,
      club: membership ? { ...membership.club, role: membership.role } : null,
    };
  }
}
