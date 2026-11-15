import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { RANKING_KEYS, RankingType } from '../stats/stats.service';

const MAX_PAGE_SIZE = 100;

/** Bump RANKING_SCHEME whenever what the ranking sets hold changes; startup then rebuilds them. */
const RANKING_SCHEME_KEY = 'ranking:scheme';
const RANKING_SCHEME = 'classicPoints+professionalPoints+wins/v3';

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
      const [classic, hand, international, version] = await Promise.all([
        this.redis.zcard(RANKING_KEYS.classic),
        this.redis.zcard(RANKING_KEYS.hand),
        this.redis.zcard(RANKING_KEYS.international),
        this.redis.get(RANKING_SCHEME_KEY),
      ]);
      if (classic === 0 || hand === 0 || international === 0 || version !== RANKING_SCHEME) await this.rebuild();
    } catch (err) {
      this.logger.error('Ranking rebuild at startup failed', err as Error);
    }
  }

  /** Recompute the ranking sets from the database. Safe to run any time. */
  async rebuild() {
    const rows = await this.prisma.playerStats.findMany({
      where: { user: { isDeleted: false } },
      select: { userId: true, classicPoints: true, professionalPoints: true, wins: true },
    });
    await this.redis.del(RANKING_KEYS.classic);
    await this.redis.del(RANKING_KEYS.hand);
    await this.redis.del(RANKING_KEYS.international);
    for (const r of rows) {
      await this.redis.zadd(RANKING_KEYS.classic, r.classicPoints, r.userId);
      await this.redis.zadd(RANKING_KEYS.hand, r.professionalPoints, r.userId);
      await this.redis.zadd(RANKING_KEYS.international, r.wins, r.userId);
    }
    await this.redis.set(RANKING_SCHEME_KEY, RANKING_SCHEME);
    this.logger.log(`Rankings rebuilt from player_stats: ${rows.length} players`);
    return { players: rows.length };
  }

  async getClassicRanking(page = 1, limit = 50, requestingUserId?: string) {
    return this.getRanking('classic', page, limit, requestingUserId);
  }

  /** The game's "Hand" ranking: points earned in Professional-mode matches. */
  async getHandRanking(page = 1, limit = 50, requestingUserId?: string) {
    return this.getRanking('hand', page, limit, requestingUserId);
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
        country: true,
        stats: { select: { level: true, classicPoints: true, professionalPoints: true, wins: true } },
        clubMemberships: {
          where: { status: 'ACTIVE' },
          select: { role: true, club: { select: { id: true, name: true, iconUrl: true } } },
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
        user: { id: user.id, username: user.username, avatarUrl: user.avatarUrl, level: user.stats?.level, country: user.country },
        // `score` is what this leaderboard is sorted by: Classic or Hand points, or total wins.
        score: entry.score,
        points: type === 'hand' ? user.stats?.professionalPoints ?? 0 : user.stats?.classicPoints ?? 0,
        wins: user.stats?.wins ?? 0,
        club: membership ? { id: membership.club.id, name: membership.club.name, iconUrl: membership.club.iconUrl, role: membership.role } : null,
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
        sortedBy: type === 'classic' ? 'classicPoints' : type === 'hand' ? 'professionalPoints' : 'wins',
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        myRank,
      },
    };
  }

  async getPlayerRank(userId: string, type: string = 'classic') {
    if (type !== 'classic' && type !== 'hand' && type !== 'international') throw new BadRequestException('type must be classic, hand or international');
    const key = RANKING_KEYS[type];
    const rank = await this.redis.zrevrank(key, userId);
    const score = await this.redis.zscore(key, userId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, avatarUrl: true,
        stats: { select: { level: true, points: true, classicPoints: true, professionalPoints: true, gamesPlayed: true, wins: true, winPercentage: true } },
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
      points: (type === 'hand' ? user?.stats?.professionalPoints : user?.stats?.classicPoints) ?? 0,
      wins: user?.stats?.wins ?? 0,
      user: { id: user?.id, username: user?.username, avatarUrl: user?.avatarUrl, level: user?.stats?.level },
      stats: user?.stats,
      club: membership ? { ...membership.club, role: membership.role } : null,
    };
  }

  /**
   * Clan ranking: clubs by club points (matches their members play, objectives completed),
   * with the player's own club and its rank when they are in one.
   */
  async getClubRanking(page = 1, limit = 50, requestingUserId?: string) {
    page = Math.max(1, Math.floor(page) || 1);
    limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit) || 50));
    const [clubs, total] = await Promise.all([
      this.prisma.club.findMany({
        orderBy: [{ points: 'desc' }, { createdAt: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, name: true, iconUrl: true, mode: true, level: true, points: true, memberCount: true, maxMembers: true, createdAt: true },
      }),
      this.prisma.club.count(),
    ]);
    const data = clubs.map((c, i) => ({ rank: (page - 1) * limit + i + 1, ...c }));

    let myClub: (typeof data)[number] | null = null;
    if (requestingUserId) {
      const membership = await this.prisma.clubMember.findFirst({
        where: { userId: requestingUserId, status: 'ACTIVE' },
        select: { club: { select: { id: true, name: true, iconUrl: true, mode: true, level: true, points: true, memberCount: true, maxMembers: true, createdAt: true } } },
      });
      if (membership) {
        const c = membership.club;
        // Clubs ahead: more points, or the same points and older (the list's tie order).
        const ahead = await this.prisma.club.count({
          where: { OR: [{ points: { gt: c.points } }, { points: c.points, createdAt: { lt: c.createdAt } }] },
        });
        myClub = { rank: ahead + 1, ...c };
      }
    }
    return { data, myClub, meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /**
   * Top Countries: players grouped by the country on their profile, ranked by their total
   * points, then wins. Players without a country are not counted.
   */
  async getCountryRanking(limit = 50, requestingUserId?: string) {
    limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit) || 50));
    const rows = await this.prisma.$queryRaw<Array<{ country: string; players: number; points: number; wins: number }>>`
      SELECT u."country" AS country,
             COUNT(*)::int AS players,
             COALESCE(SUM(s."points"), 0)::int AS points,
             COALESCE(SUM(s."wins"), 0)::int AS wins
      FROM "users" u
      LEFT JOIN "player_stats" s ON s."userId" = u."id"
      WHERE u."country" IS NOT NULL AND u."isDeleted" = false AND u."isBanned" = false
      GROUP BY u."country"
      ORDER BY points DESC, wins DESC, players DESC, country ASC`;
    const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

    let myCountry: (typeof ranked)[number] | null = null;
    if (requestingUserId) {
      const me = await this.prisma.user.findUnique({ where: { id: requestingUserId }, select: { country: true } });
      myCountry = me?.country ? ranked.find((r) => r.country === me.country) ?? null : null;
    }
    return { data: ranked.slice(0, limit), myCountry, total: ranked.length };
  }
}
