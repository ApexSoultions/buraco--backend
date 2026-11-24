import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShopCategory } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdatePromoDto, UpdateShopItemDto } from './dto/admin-economy.dto';

const PLAYER = { select: { id: true, username: true, avatarUrl: true } } as const;

/**
 * Economy for super admins: shop items and prices (including putting the real prices back
 * after testing), promo codes, and the list of real-money store purchases. Every change is
 * audit-logged with what it was before and after.
 */
@Injectable()
export class AdminEconomyService {
  constructor(private prisma: PrismaService) {}

  // ─── Shop items and prices ───────────────────────────────────────────────────

  async listItems(category?: string) {
    const where: Prisma.ShopItemWhereInput = category && category in ShopCategory ? { category: category as ShopCategory } : {};
    const [items, owned] = await Promise.all([
      this.prisma.shopItem.findMany({ where, orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.inventory.groupBy({ by: ['itemId'], _count: { _all: true } }),
    ]);
    const ownedBy = new Map(owned.map((o) => [o.itemId, o._count._all]));
    return items.map((i) => ({ ...i, ownedBy: ownedBy.get(i.id) ?? 0 }));
  }

  async updateItem(adminId: string, id: string, dto: UpdateShopItemDto) {
    const before = await this.prisma.shopItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('ITEM_NOT_FOUND');

    const data: Prisma.ShopItemUpdateInput = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('NAME_REQUIRED');
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.priceCoins !== undefined) data.priceCoins = dto.priceCoins;
    if (dto.priceDiamonds !== undefined) data.priceDiamonds = dto.priceDiamonds;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    const changes = diff(before as Record<string, unknown>, data as Record<string, unknown>);
    if (Object.keys(changes).length === 0) return before;

    const updated = await this.prisma.shopItem.update({ where: { id }, data });
    await this.audit(adminId, 'UPDATE_SHOP_ITEM', 'ShopItem', id, { name: before.name, changes });
    return updated;
  }

  /**
   * The real prices saved in `shop_prices_backup` before testing (it only exists on the Live
   * database). Lists the items whose price differs from the backup.
   */
  async priceBackup() {
    if (!(await this.backupTableExists())) return { available: false, differing: [] as PriceRow[] };
    const rows = await this.prisma.$queryRaw<PriceRow[]>`
      SELECT s.id, s.name, s."priceCoins" AS "currentCoins", s."priceDiamonds" AS "currentDiamonds",
             b."priceCoins" AS "backupCoins", b."priceDiamonds" AS "backupDiamonds"
      FROM shop_items s JOIN shop_prices_backup b ON b.id = s.id
      WHERE s."priceCoins" IS DISTINCT FROM b."priceCoins" OR s."priceDiamonds" IS DISTINCT FROM b."priceDiamonds"
      ORDER BY s.name`;
    return { available: true, differing: rows };
  }

  /** Put the saved real prices back. The backup table is kept, so it can be done again. */
  async restorePrices(adminId: string) {
    if (!(await this.backupTableExists())) throw new BadRequestException('NO_PRICE_BACKUP');
    const { differing } = await this.priceBackup();
    if (differing.length === 0) return { restored: 0 };
    await this.prisma.$executeRaw`
      UPDATE shop_items s SET "priceCoins" = b."priceCoins", "priceDiamonds" = b."priceDiamonds", "updatedAt" = now()
      FROM shop_prices_backup b WHERE s.id = b.id`;
    await this.audit(adminId, 'RESTORE_SHOP_PRICES', 'ShopItem', 'all', {
      restored: differing.length,
      items: differing.map((r) => ({ id: r.id, name: r.name, from: [r.currentCoins, r.currentDiamonds], to: [r.backupCoins, r.backupDiamonds] })),
    });
    return { restored: differing.length };
  }

  private async backupTableExists() {
    const r = await this.prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('public.shop_prices_backup')::text AS t`;
    return !!r[0]?.t;
  }

  // ─── Promo codes ─────────────────────────────────────────────────────────────

  async updatePromo(adminId: string, id: string, dto: UpdatePromoDto) {
    const before = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('PROMO_NOT_FOUND');
    if (dto.maxUses != null && dto.maxUses < before.usedCount) throw new BadRequestException('MAX_USES_BELOW_USED');

    const data: Prisma.PromoCodeUpdateInput = {};
    if (dto.rewardCoins !== undefined) data.rewardCoins = dto.rewardCoins;
    if (dto.rewardDiamonds !== undefined) data.rewardDiamonds = dto.rewardDiamonds;
    if (dto.maxUses !== undefined) data.maxUses = dto.maxUses;
    if (dto.expiresAt !== undefined) data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const changes = diff(before as Record<string, unknown>, data as Record<string, unknown>);
    if (Object.keys(changes).length === 0) return before;

    const updated = await this.prisma.promoCode.update({ where: { id }, data });
    await this.audit(adminId, 'UPDATE_PROMO', 'PromoCode', id, { code: before.code, changes });
    return updated;
  }

  /** Only a code nobody has used can be deleted; otherwise deactivate it to keep the history. */
  async deletePromo(adminId: string, id: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('PROMO_NOT_FOUND');
    const used = promo.usedCount > 0 || (await this.prisma.promoRedemption.count({ where: { promoId: id } })) > 0;
    if (used) throw new BadRequestException('PROMO_ALREADY_USED');
    await this.prisma.promoCode.delete({ where: { id } });
    await this.audit(adminId, 'DELETE_PROMO', 'PromoCode', id, { code: promo.code });
    return { deleted: true };
  }

  async promoRedemptions(id: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('PROMO_NOT_FOUND');
    const rows = await this.prisma.promoRedemption.findMany({
      where: { promoId: id },
      orderBy: { redeemedAt: 'desc' },
      take: 200,
      include: { user: PLAYER },
    });
    return { code: promo.code, usedCount: promo.usedCount, redemptions: rows.map((r) => ({ id: r.id, redeemedAt: r.redeemedAt, user: r.user })) };
  }

  // ─── Real-money purchases ────────────────────────────────────────────────────

  async purchases(opts: { store?: string; search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const search = opts.search?.trim();
    const where: Prisma.IapPurchaseWhereInput = {
      ...(opts.store ? { store: opts.store } : {}),
      ...(search
        ? { OR: [
            { productId: { contains: search, mode: 'insensitive' } },
            { transactionId: { contains: search, mode: 'insensitive' } },
            { user: { username: { contains: search, mode: 'insensitive' } } },
          ] }
        : {}),
    };
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [rows, total, byStore, last24h] = await Promise.all([
      this.prisma.iapPurchase.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { user: PLAYER } }),
      this.prisma.iapPurchase.count({ where }),
      this.prisma.iapPurchase.groupBy({ by: ['store'], _count: { _all: true }, _sum: { coins: true } }),
      this.prisma.iapPurchase.count({ where: { createdAt: { gte: since } } }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        store: r.store,
        productId: r.productId,
        transactionId: r.transactionId,
        coins: r.coins,
        environment: r.environment,
        createdAt: r.createdAt,
        user: r.user,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      last24h,
      byStore: byStore.map((s) => ({ store: s.store, count: s._count._all, coins: s._sum.coins ?? 0 })),
    };
  }

  async subscriptions(opts: { page?: number; limit?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const now = new Date();
    const [rows, total, active] = await Promise.all([
      this.prisma.iapSubscription.findMany({ orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { user: PLAYER } }),
      this.prisma.iapSubscription.count(),
      this.prisma.iapSubscription.count({ where: { expiresAt: { gt: now } } }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        store: r.store,
        productId: r.productId,
        expiresAt: r.expiresAt,
        isActive: r.expiresAt > now,
        createdAt: r.createdAt,
        user: r.user,
      })),
      total,
      active,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private async audit(adminId: string, action: string, targetType: string, targetId: string, details: object) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType, targetId, details } });
  }
}

export interface PriceRow {
  id: string;
  name: string;
  currentCoins: number | null;
  currentDiamonds: number | null;
  backupCoins: number | null;
  backupDiamonds: number | null;
}

/** What actually changes: { field: [before, after] }. Dates are compared by time. */
function diff(before: Record<string, unknown>, data: Record<string, unknown>) {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(data)) {
    const old = before[k];
    const same = old instanceof Date && v instanceof Date ? old.getTime() === v.getTime() : (old ?? null) === (v ?? null);
    if (!same) out[k] = [old ?? null, v ?? null];
  }
  return out;
}
