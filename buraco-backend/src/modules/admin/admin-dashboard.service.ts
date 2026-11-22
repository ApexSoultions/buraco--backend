import { Injectable } from '@nestjs/common';
import { CustomCardStatus, GameStatus, ReportStatus, SubscriptionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

const DAY = 24 * 60 * 60 * 1000;

/** Store purchases made from the Unity editor for testing; never counted as sales. */
const TEST_STORE = 'FAKE';

/**
 * The admin dashboard's numbers. "Today" means the last 24 hours. Money is not shown: real
 * prices live in Google Play / the App Store, so purchases are counted with the coins bought.
 */
@Injectable()
export class AdminDashboardService {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  async get(now = new Date()) {
    const since = new Date(now.getTime() - DAY);
    const realPurchases = { store: { not: TEST_STORE } };

    const [
      playersTotal, activeToday, newToday, banned, subscribers,
      matchesLive, matchesToday, matchesTotal,
      coinsSpent, purchasesToday, coinsBought,
      openReports, pendingCustomCards, topPlayerStats, onlineNow, last7Days,
    ] = await Promise.all([
      this.prisma.user.count({ where: { isDeleted: false } }),
      this.prisma.user.count({ where: { isDeleted: false, lastSeenAt: { gte: since } } }),
      this.prisma.user.count({ where: { isDeleted: false, createdAt: { gte: since } } }),
      this.prisma.user.count({ where: { isDeleted: false, isBanned: true } }),
      this.prisma.user.count({ where: { isDeleted: false, subscriptionStatus: { not: SubscriptionStatus.FREE } } }),
      this.prisma.gameSession.count({ where: { status: GameStatus.IN_PROGRESS } }),
      this.prisma.gameSession.count({ where: { createdAt: { gte: since } } }),
      this.prisma.gameSession.count(),
      // Shop spending is stored as negative amounts.
      this.prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: TransactionType.PURCHASE, createdAt: { gte: since } } }),
      this.prisma.iapPurchase.count({ where: { ...realPurchases, createdAt: { gte: since } } }),
      this.prisma.iapPurchase.aggregate({ _sum: { coins: true }, where: { ...realPurchases, createdAt: { gte: since } } }),
      this.prisma.report.count({ where: { status: ReportStatus.OPEN } }),
      this.prisma.customCard.count({ where: { status: CustomCardStatus.PENDING } }),
      this.prisma.playerStats.findMany({
        take: 5,
        orderBy: { points: 'desc' },
        where: { user: { isDeleted: false } },
        include: { user: { select: { id: true, username: true, avatarUrl: true } } },
      }),
      this.onlineCount(),
      this.lastDays(now, 7),
    ]);

    return {
      players: { total: playersTotal, onlineNow, activeToday, newToday, banned, subscribers },
      matches: { live: matchesLive, today: matchesToday, total: matchesTotal },
      economy: {
        coinsSpentToday: Math.abs(coinsSpent._sum.amount ?? 0),
        purchasesToday,
        coinsBoughtToday: coinsBought._sum.coins ?? 0,
      },
      todo: { openReports, pendingCustomCards },
      last7Days,
      topPlayers: topPlayerStats.map((s) => ({
        id: s.user.id,
        username: s.user.username,
        avatarUrl: s.user.avatarUrl,
        points: s.points,
        level: s.level,
        winPercentage: s.winPercentage,
      })),
    };
  }

  /** Players with a connected game socket (the gateway keeps `online:<id>` alive). */
  private async onlineCount(): Promise<number | null> {
    try {
      return await this.redis.countKeys('online:*');
    } catch {
      return null; // Redis unavailable: the dashboard shows "—"
    }
  }

  /** New players and matches per day, oldest first, for the small chart. */
  private async lastDays(now: Date, days: number) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const [users, games] = await Promise.all([
      this.prisma.user.findMany({ where: { isDeleted: false, createdAt: { gte: start } }, select: { createdAt: true } }),
      this.prisma.gameSession.findMany({ where: { createdAt: { gte: start } }, select: { createdAt: true } }),
    ]);
    const key = (d: Date) => d.toISOString().slice(0, 10);
    const out = Array.from({ length: days }, (_, i) => {
      const d = new Date(start.getTime() + i * DAY);
      return { date: key(d), newPlayers: 0, matches: 0 };
    });
    const index = new Map(out.map((row, i) => [row.date, i]));
    for (const u of users) { const i = index.get(key(u.createdAt)); if (i !== undefined) out[i].newPlayers++; }
    for (const g of games) { const i = index.get(key(g.createdAt)); if (i !== undefined) out[i].matches++; }
    return out;
  }
}
