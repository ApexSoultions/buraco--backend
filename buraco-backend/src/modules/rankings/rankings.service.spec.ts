import { BadRequestException } from '@nestjs/common';
import { GameMode } from '@prisma/client';
import { RANKING_KEYS, StatsService } from '../stats/stats.service';
import { RankingsService } from './rankings.service';

// The two leaderboards used to receive the same total points, so they were identical, and
// only the first page could ever be read. Now:
// - Classic ranks points earned in Classic matches (PlayerStats.classicPoints)
// - International ranks wins across all modes (PlayerStats.wins)
// - pages after the first return the right players
// - the Redis sets are rebuilt from the database when they are empty

/** Minimal in-memory Redis sorted sets. */
function fakeRedis() {
  const sets = new Map<string, Map<string, number>>();
  const set = (k: string) => (sets.has(k) ? sets.get(k)! : sets.set(k, new Map()).get(k)!);
  const sorted = (k: string) => [...set(k).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  const kv = new Map<string, string>();
  return {
    sets,
    kv,
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { kv.set(k, v); }),
    zadd: jest.fn(async (k: string, score: number, m: string) => { set(k).set(m, score); }),
    zcard: jest.fn(async (k: string) => set(k).size),
    del: jest.fn(async (k: string) => { sets.delete(k); }),
    zscore: jest.fn(async (k: string, m: string) => (set(k).has(m) ? String(set(k).get(m)) : null)),
    zrevrank: jest.fn(async (k: string, m: string) => { const i = sorted(k).findIndex(([id]) => id === m); return i < 0 ? null : i; }),
    zrevrangeWithScores: jest.fn(async (k: string, start: number, stop: number) =>
      sorted(k).slice(start, stop + 1).map(([member, score]) => ({ member, score }))),
  };
}

function players(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u${String(i).padStart(2, '0')}`,
    classicPoints: (count - i) * 10, // u00 has the most Classic points
    wins: i,                         // u(count-1) has the most wins
  }));
}

function setup(rows = players(5)) {
  const redis = fakeRedis();
  const prisma = {
    playerStats: { findMany: jest.fn(async () => rows) },
    user: {
      findMany: jest.fn(async ({ where }: any) => rows
        .filter((r) => where.id.in.includes(r.userId))
        .map((r) => ({ id: r.userId, username: r.userId, avatarUrl: null, stats: { level: 1, classicPoints: r.classicPoints, wins: r.wins }, clubMemberships: [] }))),
      findUnique: jest.fn(async ({ where }: any) => {
        const r = rows.find((x) => x.userId === where.id);
        return r ? { id: r.userId, username: r.userId, avatarUrl: null, stats: { level: 1, ...r }, clubMemberships: [] } : null;
      }),
    },
  };
  return { service: new RankingsService(prisma as any, redis as any), redis, prisma };
}

describe('RankingsService', () => {
  it('rebuilds both leaderboards from the database when Redis is empty', async () => {
    const { service, redis } = setup();
    await service.onModuleInit();

    expect(redis.sets.get(RANKING_KEYS.classic)!.get('u00')).toBe(50);
    expect(redis.sets.get(RANKING_KEYS.international)!.get('u04')).toBe(4);
  });

  it('rebuilds sets left by the old scheme (same points on both boards), then not again', async () => {
    const { service, redis, prisma } = setup();
    // What the live server holds today: total points written to both sets, no scheme marker.
    await redis.zadd(RANKING_KEYS.classic, 999, 'u00');
    await redis.zadd(RANKING_KEYS.international, 999, 'u00');

    await service.onModuleInit();
    expect(redis.sets.get(RANKING_KEYS.international)!.get('u00')).toBe(0);
    expect(prisma.playerStats.findMany).toHaveBeenCalledTimes(1);

    await service.onModuleInit();
    expect(prisma.playerStats.findMany).toHaveBeenCalledTimes(1);
  });

  it('Classic is ordered by Classic points and International by wins — different lists', async () => {
    const { service } = setup();
    await service.rebuild();

    const classic = await service.getClassicRanking(1, 5);
    const intl = await service.getInternationalRanking(1, 5);

    expect(classic.data.map((r: any) => r.user.id)).toEqual(['u00', 'u01', 'u02', 'u03', 'u04']);
    expect(classic.data[0]).toEqual(expect.objectContaining({ rank: 1, score: 50, points: 50 }));
    expect(intl.data.map((r: any) => r.user.id)).toEqual(['u04', 'u03', 'u02', 'u01', 'u00']);
    expect(intl.data[0]).toEqual(expect.objectContaining({ rank: 1, score: 4, wins: 4 }));
    expect(classic.meta.sortedBy).toBe('classicPoints');
    expect(intl.meta.sortedBy).toBe('wins');
  });

  it('returns the right players on page 2 (it used to be empty)', async () => {
    const { service } = setup(players(25));
    await service.rebuild();

    const page2 = await service.getClassicRanking(2, 10);
    expect(page2.data).toHaveLength(10);
    expect(page2.data[0]).toEqual(expect.objectContaining({ rank: 11, user: expect.objectContaining({ id: 'u10' }) }));
    expect(page2.meta).toEqual(expect.objectContaining({ total: 25, page: 2, totalPages: 3 }));

    const page3 = await service.getClassicRanking(3, 10);
    expect(page3.data).toHaveLength(5);
  });

  it('includes the requesting player\'s own rank', async () => {
    const { service } = setup();
    await service.rebuild();
    expect((await service.getInternationalRanking(1, 2, 'u00')).meta.myRank).toBe(5);
  });

  it('caps the page size', async () => {
    const { service } = setup();
    await service.rebuild();
    expect((await service.getClassicRanking(1, 10_000)).meta.limit).toBe(100);
  });

  it('player rank per type, and refuses an unknown type', async () => {
    const { service } = setup();
    await service.rebuild();

    expect(await service.getPlayerRank('u04', 'classic')).toEqual(expect.objectContaining({ type: 'classic', rank: 5, score: 10 }));
    expect(await service.getPlayerRank('u04', 'international')).toEqual(expect.objectContaining({ type: 'international', rank: 1, score: 4 }));
    await expect(service.getPlayerRank('u04', 'weekly')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StatsService.updateAfterMatch — ranking scores', () => {
  function stats(mode: GameMode | undefined, result: 'WIN' | 'LOSS', points: number) {
    const row = { userId: 'p1', points: 100, classicPoints: 80, wins: 3, losses: 1, gamesLeft: 0, gamesPlayed: 4, winStreak: 0, bestWinStreak: 1, experience: 0, level: 1 };
    const prisma = {
      playerStats: {
        findUnique: jest.fn(async () => ({ ...row })),
        update: jest.fn(async ({ data }: any) => ({
          ...row, ...data,
          classicPoints: row.classicPoints + (data.classicPoints?.increment ?? 0),
        })),
      },
    };
    const redis = fakeRedis();
    return { run: () => new StatsService(prisma as any, redis as any).updateAfterMatch('p1', result, points, 10, mode), redis, prisma };
  }

  it('a Classic win adds to Classic points and to International wins', async () => {
    const { run, redis } = stats(GameMode.CLASSIC, 'WIN', 60);
    await run();
    expect(redis.sets.get(RANKING_KEYS.classic)!.get('p1')).toBe(140);
    expect(redis.sets.get(RANKING_KEYS.international)!.get('p1')).toBe(4);
  });

  it('a Professional win counts for International only', async () => {
    const { run, redis, prisma } = stats(GameMode.PROFESSIONAL, 'WIN', 60);
    await run();
    expect(prisma.playerStats.update.mock.calls[0][0].data.classicPoints).toBeUndefined();
    expect(redis.sets.get(RANKING_KEYS.classic)!.get('p1')).toBe(80);
    expect(redis.sets.get(RANKING_KEYS.international)!.get('p1')).toBe(4);
  });

  it('a loss changes neither score', async () => {
    const { run, redis } = stats(GameMode.CLASSIC, 'LOSS', 0);
    await run();
    expect(redis.sets.get(RANKING_KEYS.classic)!.get('p1')).toBe(80);
    expect(redis.sets.get(RANKING_KEYS.international)!.get('p1')).toBe(3);
  });
});
