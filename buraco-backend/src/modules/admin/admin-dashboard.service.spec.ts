import { AdminDashboardService } from './admin-dashboard.service';

// The admin dashboard numbers: shop spending as a positive number, editor test purchases not
// counted as sales, a 7-day chart, and "—" (null) for online players when Redis is down.
function setup(opts: { redisDown?: boolean } = {}) {
  const now = new Date('2026-11-22T12:00:00Z');
  const users = [
    { createdAt: new Date('2026-11-22T08:00:00Z') },
    { createdAt: new Date('2026-11-20T08:00:00Z') },
    { createdAt: new Date('2026-11-01T08:00:00Z') }, // before the chart
  ];
  const games = [
    { createdAt: new Date('2026-11-22T09:00:00Z') },
    { createdAt: new Date('2026-11-22T10:00:00Z') },
    { createdAt: new Date('2026-11-16T10:00:00Z') }, // first chart day
  ];
  const iapWhere: any[] = [];
  const prisma: any = {
    user: {
      count: jest.fn(async () => 3),
      findMany: jest.fn(async ({ where }: any) => users.filter((u) => u.createdAt >= where.createdAt.gte)),
    },
    gameSession: {
      count: jest.fn(async () => 2),
      findMany: jest.fn(async ({ where }: any) => games.filter((g) => g.createdAt >= where.createdAt.gte)),
    },
    transaction: { aggregate: jest.fn(async () => ({ _sum: { amount: -7000 } })) },
    iapPurchase: {
      count: jest.fn(async ({ where }: any) => { iapWhere.push(where); return 1; }),
      aggregate: jest.fn(async ({ where }: any) => { iapWhere.push(where); return { _sum: { coins: 50000 } }; }),
    },
    report: { count: jest.fn(async () => 4) },
    customCard: { count: jest.fn(async () => 2) },
    playerStats: { findMany: jest.fn(async () => [{ user: { id: 'u1', username: 'ace', avatarUrl: null }, points: 90, level: 3, winPercentage: 60 }]) },
  };
  const redis: any = {
    countKeys: jest.fn(async () => { if (opts.redisDown) throw new Error('down'); return 5; }),
  };
  return { service: new AdminDashboardService(prisma, redis), now, iapWhere };
}

describe('AdminDashboardService', () => {
  it('shows shop spending as a positive number and leaves out editor test purchases', async () => {
    const { service, now, iapWhere } = setup();
    const d = await service.get(now);
    expect(d.economy.coinsSpentToday).toBe(7000);
    expect(d.economy.purchasesToday).toBe(1);
    expect(d.economy.coinsBoughtToday).toBe(50000);
    expect(iapWhere.every((w) => w.store?.not === 'FAKE')).toBe(true);
  });

  it('builds a 7-day chart of new players and matches, oldest first', async () => {
    const { service, now } = setup();
    const { last7Days } = await service.get(now);
    expect(last7Days.map((d) => d.date)).toEqual([
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22',
    ]);
    expect(last7Days[6]).toEqual({ date: '2026-11-22', newPlayers: 1, matches: 2 });
    expect(last7Days[4].newPlayers).toBe(1);
    expect(last7Days[0].matches).toBe(1);
  });

  it('counts online players, open reports and pending custom cards', async () => {
    const { service, now } = setup();
    const d = await service.get(now);
    expect(d.players.onlineNow).toBe(5);
    expect(d.todo).toEqual({ openReports: 4, pendingCustomCards: 2 });
    expect(d.topPlayers[0].username).toBe('ace');
  });

  it('still answers when Redis is down (online shows as unknown)', async () => {
    const { service, now } = setup({ redisDown: true });
    const d = await service.get(now);
    expect(d.players.onlineNow).toBeNull();
    expect(d.players.total).toBe(3);
  });
});
