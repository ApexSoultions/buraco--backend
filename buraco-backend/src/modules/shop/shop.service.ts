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
    });
  }

  async getEquipped(userId: string) {
    return this.prisma.inventory.findMany({
      where: { userId, isEquipped: true },
      include: { item: true },
    });
  }

  async redeemCode(userId: string, code: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code, isActive: true } });
    if (!promo) throw new NotFoundException('Invalid promo code');
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new BadRequestException('Promo code expired');
    if (promo.maxUses && promo.usedCount >= promo.maxUses) throw new BadRequestException('Promo code fully redeemed');

    await this.prisma.promoCode.update({ where: { code }, data: { usedCount: { increment: 1 } } });

    const rewards: any = {};
    if (promo.rewardCoins > 0) {
      await this.economyService.addCoins(userId, promo.rewardCoins, TransactionType.REWARD, promo.id, `Promo: ${code}`);
      rewards.coins = promo.rewardCoins;
    }
    if (promo.rewardDiamonds > 0) {
      await this.economyService.addDiamonds(userId, promo.rewardDiamonds, TransactionType.REWARD, promo.id, `Promo: ${code}`);
      rewards.diamonds = promo.rewardDiamonds;
    }
    if (promo.itemId) {
      await this.prisma.inventory.upsert({
        where: { userId_itemId: { userId, itemId: promo.itemId } },
        create: { userId, itemId: promo.itemId },
        update: {},
      });
      rewards.itemId = promo.itemId;
    }

    return { rewards };
  }
}
