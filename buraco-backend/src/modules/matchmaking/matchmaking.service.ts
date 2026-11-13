import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { GameMode, GameVariant } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { isPremiumActive } from '../../common/premium/premium';
import { EconomyService } from '../economy/economy.service';

const ENTRY_FEES: Record<string, Record<string, number>> = {
  CLASSIC: { ONE_VS_ONE: 100, TWO_VS_TWO: 200 },
  PROFESSIONAL: { ONE_VS_ONE: 500, TWO_VS_TWO: 1000 },
};

const PLAYERS_NEEDED: Record<string, number> = {
  ONE_VS_ONE: 2,
  TWO_VS_TWO: 4,
};

@Injectable()
export class MatchmakingService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private economyService: EconomyService,
  ) {}

  queueKey(mode: GameMode, variant: GameVariant) {
    return `queue:${mode.toLowerCase()}:${variant.toLowerCase()}`;
  }

  async joinQueue(userId: string, mode: GameMode, variant: GameVariant) {
    const inQueue = await this.isInQueue(userId);
    if (inQueue) throw new BadRequestException('ALREADY_IN_QUEUE');

    const activeGame = await this.prisma.gameSession.findFirst({
      where: { status: 'IN_PROGRESS', players: { some: { userId } } },
    });
    if (activeGame) throw new BadRequestException('ALREADY_IN_GAME');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (mode === GameMode.PROFESSIONAL && !isPremiumActive(user)) {
      throw new ForbiddenException('SUBSCRIPTION_REQUIRED');
    }

    const fee = ENTRY_FEES[mode]?.[variant] || 0;
    if (fee > 0) await this.economyService.deductEntryFee(userId, `queue-${userId}`, fee);

    await this.prisma.matchmakingEntry.upsert({
      where: { userId },
      create: { userId, mode, variant },
      update: { mode, variant, joinedAt: new Date() },
    });

    const score = Date.now();
    await this.redis.zadd(this.queueKey(mode, variant), score, userId);

    const position = await this.redis.zrank(this.queueKey(mode, variant), userId);
    return { queueId: `queue-${userId}`, estimatedWaitSeconds: (position || 0) * 15, message: 'Joined matchmaking queue' };
  }

  async leaveQueue(userId: string) {
    const entry = await this.prisma.matchmakingEntry.findUnique({ where: { userId } });
    if (!entry) return { message: 'Not in queue' };

    await this.redis.zrem(this.queueKey(entry.mode, entry.variant), userId);
    await this.prisma.matchmakingEntry.delete({ where: { userId } });

    // Refund entry fee
    const fee = ENTRY_FEES[entry.mode]?.[entry.variant] || 0;
    if (fee > 0) await this.economyService.refundEntryFee(userId, `queue-${userId}`, fee);

    return { message: 'Left queue, entry fee refunded' };
  }

  async getQueueStatus(userId: string) {
    const entry = await this.prisma.matchmakingEntry.findUnique({ where: { userId } });
    if (!entry) return { inQueue: false };

    const key = this.queueKey(entry.mode, entry.variant);
    const position = await this.redis.zrank(key, userId);
    const joinedAt = entry.joinedAt.getTime();
    const waitedSeconds = Math.floor((Date.now() - joinedAt) / 1000);

    return { inQueue: true, mode: entry.mode, variant: entry.variant, queuePosition: (position || 0) + 1, waitedSeconds };
  }

  async isInQueue(userId: string): Promise<boolean> {
    const entry = await this.prisma.matchmakingEntry.findUnique({ where: { userId } });
    return !!entry;
  }

  async processQueues(): Promise<{ mode: GameMode; variant: GameVariant; playerIds: string[] } | null> {
    for (const mode of Object.values(GameMode)) {
      for (const variant of Object.values(GameVariant)) {
        const needed = PLAYERS_NEEDED[variant];
        const key = this.queueKey(mode, variant);
        const count = await this.redis.zcard(key);

        if (count >= needed) {
          const playerIds = await this.redis.zrangebyscore(key, '-inf', '+inf', needed);
          if (playerIds.length >= needed) {
            const selected = playerIds.slice(0, needed);
            for (const pid of selected) await this.redis.zrem(key, pid);
            await this.prisma.matchmakingEntry.deleteMany({ where: { userId: { in: selected } } });
            return { mode, variant, playerIds: selected };
          }
        }
      }
    }
    return null;
  }
}
