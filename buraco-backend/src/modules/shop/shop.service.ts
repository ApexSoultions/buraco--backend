import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CurrencyType, Prisma, ShopCategory, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EconomyService } from '../economy/economy.service';

@Injectable()
export class ShopService {
  constructor(
    private prisma: PrismaService,
    private economyService: EconomyService,
  ) {}

  async getCatalog(category?: ShopCategory, userId?: string) {
    const items = await this.prisma.shopItem.findMany({
      where: { isActive: true, ...(category && { category }) },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    if (!userId) return items;

    const owned = await this.prisma.inventory.findMany({ where: { userId }, select: { itemId: true, isEquipped: true } });
    const ownedMap = new Map(owned.map((o) => [o.itemId, o.isEquipped]));
    return items.map((item) => ({ ...item, isOwned: ownedMap.has(item.id), isEquipped: ownedMap.get(item.id) ?? false }));
  }

  async getItemById(itemId: string) {
    const item = await this.prisma.shopItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  /**
   * Buy an item with coins or diamonds, all in one database transaction:
   * - the balance is only taken when it is enough (no negative balance, even with two taps
   *   at once), and the item is only given when the charge succeeded;
   * - a non-consumable item can be owned once (a second purchase gets 409, never charged twice);
   * - a LIVES pack adds its lives to the player.
   */
  async purchaseItem(userId: string, itemId: string, currency: CurrencyType) {
    if (currency !== CurrencyType.COINS && currency !== CurrencyType.DIAMONDS) {
      throw new BadRequestException('currency must be COINS or DIAMONDS');
    }
    const item = await this.prisma.shopItem.findUnique({ where: { id: itemId, isActive: true } });
    if (!item) throw new NotFoundException('Item not found');

    const price = currency === CurrencyType.COINS ? item.priceCoins : item.priceDiamonds;
    if (!price || price <= 0) throw new BadRequestException(`Item not available for purchase with ${currency}`);
    const field = currency === CurrencyType.COINS ? 'coins' : 'diamonds';

    try {
      await this.prisma.$transaction(async (tx) => {
        if (!item.isConsumable) {
          // The unique (user, item) row is the lock: a second buyer fails here (P2002).
          await tx.inventory.create({ data: { userId, itemId, quantity: 1 } });
        }

        const charged = await tx.user.updateMany({
          where: { id: userId, [field]: { gte: price } },
          data: { [field]: { decrement: price } },
        });
        if (charged.count === 0) throw new BadRequestException('INSUFFICIENT_BALANCE');

        const after = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coins: true, diamonds: true } });
        const balanceAfter = after[field];
        await tx.transaction.create({
          data: {
            userId, type: TransactionType.PURCHASE, currency, amount: -price,
            balanceBefore: balanceAfter + price, balanceAfter, referenceId: itemId, description: `Purchase: ${item.name}`,
          },
        });

        if (item.grantLives && item.grantLives > 0) {
          await tx.user.update({ where: { id: userId }, data: { lives: { increment: item.grantLives } } });
        } else if (item.isConsumable) {
          await tx.inventory.upsert({
            where: { userId_itemId: { userId, itemId } },
            create: { userId, itemId, quantity: 1 },
            update: { quantity: { increment: 1 } },
          });
        }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('ITEM_ALREADY_OWNED');
      }
      throw err;
    }

    const balance = await this.economyService.getBalance(userId);
    return { item: { id: item.id, name: item.name, category: item.category }, newBalance: balance };
  }

  async getInventory(userId: string) {
    return this.prisma.inventory.findMany({
      where: { userId },
      include: { item: true },
      orderBy: { purchasedAt: 'desc' },
    });
  }

  async equipItem(userId: string, itemId: string) {
    const inv = await this.prisma.inventory.findUnique({ where: { userId_itemId: { userId, itemId } } });
    if (!inv) throw new NotFoundException('Item not in inventory');

    const item = await this.getItemById(itemId);

    // Unequip other items of same category
    await this.prisma.$transaction(async (tx) => {
      await tx.inventory.updateMany({
        where: { userId, item: { category: item.category }, isEquipped: true },
        data: { isEquipped: false, equippedAt: null },
      });
      await tx.inventory.update({
        where: { userId_itemId: { userId, itemId } },
        data: { isEquipped: true, equippedAt: new Date() },
      });
      // One card back at a time: a custom card in use is put away.
      if (item.category === ShopCategory.CARDS) {
        await tx.customCard.updateMany({ where: { userId, isEquipped: true }, data: { isEquipped: false } });
      }
    });
  }

  async getEquipped(userId: string) {
    return this.prisma.inventory.findMany({
      where: { userId, isEquipped: true },
      include: { item: true },
    });
  }

  /**
   * Redeem a promo code. Each player can redeem a code once, the use count can't go past
   * maxUses even with many players at once, and the rewards are given in the same transaction.
   * Codes are matched without case ("welcome" = "WELCOME").
   */
  async redeemCode(userId: string, rawCode: string) {
    const code = (rawCode ?? '').trim();
    if (!code) throw new BadRequestException('Enter a code');
    const promo = await this.prisma.promoCode.findFirst({ where: { code: { equals: code, mode: 'insensitive' }, isActive: true } });
    if (!promo) throw new NotFoundException('Invalid promo code');
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new BadRequestException('Promo code expired');

    try {
      return await this.prisma.$transaction(async (tx) => {
        // One per player: the unique (promo, player) row is the lock.
        await tx.promoRedemption.create({ data: { promoId: promo.id, userId } });

        const used = await tx.promoCode.updateMany({
          where: { id: promo.id, ...(promo.maxUses != null && { usedCount: { lt: promo.maxUses } }) },
          data: { usedCount: { increment: 1 } },
        });
        if (used.count === 0) throw new BadRequestException('Promo code fully redeemed');

        const rewards: { coins?: number; diamonds?: number; itemId?: string } = {};
        if (promo.rewardCoins > 0 || promo.rewardDiamonds > 0) {
          const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coins: true, diamonds: true } });
          const after = await tx.user.update({
            where: { id: userId },
            data: { coins: { increment: promo.rewardCoins }, diamonds: { increment: promo.rewardDiamonds } },
            select: { coins: true, diamonds: true },
          });
          if (promo.rewardCoins > 0) {
            rewards.coins = promo.rewardCoins;
            await tx.transaction.create({
              data: {
                userId, type: TransactionType.REWARD, currency: CurrencyType.COINS, amount: promo.rewardCoins,
                balanceBefore: before.coins, balanceAfter: after.coins, referenceId: promo.id, description: `Promo: ${promo.code}`,
              },
            });
          }
          if (promo.rewardDiamonds > 0) {
            rewards.diamonds = promo.rewardDiamonds;
            await tx.transaction.create({
              data: {
                userId, type: TransactionType.REWARD, currency: CurrencyType.DIAMONDS, amount: promo.rewardDiamonds,
                balanceBefore: before.diamonds, balanceAfter: after.diamonds, referenceId: promo.id, description: `Promo: ${promo.code}`,
              },
            });
          }
        }
        if (promo.itemId) {
          await tx.inventory.upsert({
            where: { userId_itemId: { userId, itemId: promo.itemId } },
            create: { userId, itemId: promo.itemId },
            update: {},
          });
          rewards.itemId = promo.itemId;
        }

        const balance = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coins: true, diamonds: true, lives: true } });
        return { rewards, newBalance: balance };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('PROMO_ALREADY_REDEEMED');
      }
      throw err;
    }
  }

}
