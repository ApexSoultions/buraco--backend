import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CurrencyType, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SystemConfigService } from '../../common/system-config/system-config.service';

@Injectable()
export class EconomyService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private sysConfig: SystemConfigService,
  ) {}

  /**
   * Daily login reward, once per UTC day. The day's marker is taken atomically before
   * paying, so two requests at the same moment (two devices, a double tap) pay once.
   * `nextClaimAt` is the next UTC midnight; `coins` is the balance after a payout.
   */
  async claimDailyReward(userId: string) {
    const key = `daily:${userId}`;
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const ttl = Math.max(1, Math.floor((midnight.getTime() - now.getTime()) / 1000));
    const nextClaimAt = midnight.toISOString();

    if (!(await this.redis.setIfAbsent(key, '1', ttl))) {
      return { claimed: false, message: 'Already claimed today', nextClaimAt };
    }

    try {
      const rewardCoins = await this.sysConfig.getNumber('daily_login_reward_coins', 200);
      const coins = await this.addCoins(userId, rewardCoins, TransactionType.REWARD, undefined, 'Daily login reward');
      return { claimed: true, coinsAwarded: rewardCoins, coins, nextClaimAt };
    } catch (err) {
      await this.redis.del(key); // not paid: allow another try today
      throw err;
    }
  }

  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true, diamonds: true, lives: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async addCoins(userId: string, amount: number, type: TransactionType, referenceId?: string, description?: string, performedBy?: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
      if (!user) throw new NotFoundException('User not found');
      const updated = await tx.user.update({ where: { id: userId }, data: { coins: { increment: amount } } });
      await tx.transaction.create({
        data: { userId, type, currency: CurrencyType.COINS, amount, balanceBefore: user.coins, balanceAfter: updated.coins, referenceId, description, performedBy },
      });
      return updated.coins;
    });
  }

  async deductCoins(userId: string, amount: number, type: TransactionType, referenceId?: string, description?: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
      if (!user) throw new NotFoundException('User not found');
      if (user.coins < amount) throw new BadRequestException('INSUFFICIENT_BALANCE');
      const updated = await tx.user.update({ where: { id: userId }, data: { coins: { decrement: amount } } });
      await tx.transaction.create({
        data: { userId, type, currency: CurrencyType.COINS, amount: -amount, balanceBefore: user.coins, balanceAfter: updated.coins, referenceId, description },
      });
      return updated.coins;
    });
  }

  async addDiamonds(userId: string, amount: number, type: TransactionType, referenceId?: string, description?: string, performedBy?: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { diamonds: true } });
      if (!user) throw new NotFoundException('User not found');
      const updated = await tx.user.update({ where: { id: userId }, data: { diamonds: { increment: amount } } });
      await tx.transaction.create({
        data: { userId, type, currency: CurrencyType.DIAMONDS, amount, balanceBefore: user.diamonds, balanceAfter: updated.diamonds, referenceId, description, performedBy },
      });
      return updated.diamonds;
    });
  }

  async deductDiamonds(userId: string, amount: number, type: TransactionType, referenceId?: string, description?: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { diamonds: true } });
      if (!user) throw new NotFoundException('User not found');
      if (user.diamonds < amount) throw new BadRequestException('INSUFFICIENT_BALANCE');
      const updated = await tx.user.update({ where: { id: userId }, data: { diamonds: { decrement: amount } } });
      await tx.transaction.create({
        data: { userId, type, currency: CurrencyType.DIAMONDS, amount: -amount, balanceBefore: user.diamonds, balanceAfter: updated.diamonds, referenceId, description },
      });
      return updated.diamonds;
    });
  }

  async deductEntryFee(userId: string, roomId: string, fee: number) {
    if (fee <= 0) return;
    return this.deductCoins(userId, fee, TransactionType.ENTRY_FEE, roomId, 'Match entry fee');
  }

  async refundEntryFee(userId: string, roomId: string, fee: number) {
    if (fee <= 0) return;
    return this.addCoins(userId, fee, TransactionType.ENTRY_FEE_REFUND, roomId, 'Entry fee refund');
  }

  async distributeMatchReward(userId: string, gameId: string, coins: number, diamonds = 0) {
    const ops: Promise<any>[] = [];
    if (coins > 0) ops.push(this.addCoins(userId, coins, TransactionType.REWARD, gameId, 'Match win reward'));
    if (diamonds > 0) ops.push(this.addDiamonds(userId, diamonds, TransactionType.REWARD, gameId, 'Match win reward'));
    return Promise.all(ops);
  }

  async sendGift(senderId: string, receiverId: string, currency: CurrencyType, amount: number) {
    const [receiver, blocked] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: receiverId, isDeleted: false } }),
      this.prisma.block.findFirst({
        where: { OR: [{ blockerId: senderId, blockedId: receiverId }, { blockerId: receiverId, blockedId: senderId }] },
      }),
    ]);
    if (!receiver) throw new NotFoundException('USER_NOT_FOUND');
    if (blocked) throw new ForbiddenException('USER_BLOCKED');

    // Single transaction — avoids nested Prisma transactions which are unsupported
    await this.prisma.$transaction(async (tx) => {
      if (currency === CurrencyType.COINS) {
        const sender = await tx.user.findUnique({ where: { id: senderId }, select: { coins: true } });
        if (!sender) throw new NotFoundException('User not found');
        if (sender.coins < amount) throw new BadRequestException('INSUFFICIENT_BALANCE');

        const updatedSender = await tx.user.update({ where: { id: senderId }, data: { coins: { decrement: amount } } });
        await tx.transaction.create({ data: { userId: senderId, type: TransactionType.GIFT_SENT, currency, amount: -amount, balanceBefore: sender.coins, balanceAfter: updatedSender.coins, referenceId: receiverId, description: `Gift to ${receiverId}` } });

        const updatedReceiver = await tx.user.update({ where: { id: receiverId }, data: { coins: { increment: amount } } });
        await tx.transaction.create({ data: { userId: receiverId, type: TransactionType.GIFT_RECEIVED, currency, amount, balanceBefore: receiver.coins, balanceAfter: updatedReceiver.coins, referenceId: senderId, description: `Gift from ${senderId}` } });
      } else {
        const sender = await tx.user.findUnique({ where: { id: senderId }, select: { diamonds: true } });
        if (!sender) throw new NotFoundException('User not found');
        if (sender.diamonds < amount) throw new BadRequestException('INSUFFICIENT_BALANCE');

        const updatedSender = await tx.user.update({ where: { id: senderId }, data: { diamonds: { decrement: amount } } });
        await tx.transaction.create({ data: { userId: senderId, type: TransactionType.GIFT_SENT, currency, amount: -amount, balanceBefore: sender.diamonds, balanceAfter: updatedSender.diamonds, referenceId: receiverId, description: `Gift to ${receiverId}` } });

        const updatedReceiver = await tx.user.update({ where: { id: receiverId }, data: { diamonds: { increment: amount } } });
        await tx.transaction.create({ data: { userId: receiverId, type: TransactionType.GIFT_RECEIVED, currency, amount, balanceBefore: receiver.diamonds, balanceAfter: updatedReceiver.diamonds, referenceId: senderId, description: `Gift from ${senderId}` } });
      }
    });
  }

  async getTransactionHistory(userId: string, page = 1, limit = 20, currency?: CurrencyType, type?: TransactionType) {
    const skip = (page - 1) * limit;
    const where = { userId, ...(currency && { currency }), ...(type && { type }) };
    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.transaction.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }
}
