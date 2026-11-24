import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminEconomyService } from './admin-economy.service';

// Economy: editing item prices and promo codes (with audit of before/after), restoring the
// saved real prices, and the purchases list.
function setup(opts: { backup?: boolean } = {}) {
  const items: any[] = [
    { id: 'i1', name: 'Gold Foil', description: null, category: 'CARDS', priceCoins: 100, priceDiamonds: null, isActive: true, sortOrder: 0 },
  ];
  const promos: any[] = [
    { id: 'p1', code: 'WELCOME', rewardCoins: 50, rewardDiamonds: 0, maxUses: 10, usedCount: 3, expiresAt: null, isActive: true },
    { id: 'p2', code: 'FRESH', rewardCoins: 10, rewardDiamonds: 0, maxUses: null, usedCount: 0, expiresAt: null, isActive: true },
  ];
  const audit: any[] = [];
  const prisma: any = {
    shopItem: {
      findUnique: jest.fn(async ({ where }: any) => items.find((i) => i.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(items.find((i) => i.id === where.id), data)),
    },
    promoCode: {
      findUnique: jest.fn(async ({ where }: any) => promos.find((p) => p.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(promos.find((p) => p.id === where.id), data)),
      delete: jest.fn(async ({ where }: any) => promos.splice(promos.findIndex((p) => p.id === where.id), 1)),
    },
    promoRedemption: { count: jest.fn(async ({ where }: any) => (where.promoId === 'p1' ? 3 : 0)) },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    $queryRaw: jest.fn(async () => [{ t: opts.backup ? 'shop_prices_backup' : null }]),
    $executeRaw: jest.fn(async () => 1),
  };
  const service = new AdminEconomyService(prisma);
  return { service, items, promos, audit, prisma };
}

describe('AdminEconomyService', () => {
  it('changes a price and logs what it was before and after', async () => {
    const { service, items, audit } = setup();
    await service.updateItem('a1', 'i1', { priceCoins: 30_000, priceDiamonds: 25 });
    expect(items[0]).toMatchObject({ priceCoins: 30_000, priceDiamonds: 25 });
    expect(audit[0]).toMatchObject({ action: 'UPDATE_SHOP_ITEM', targetId: 'i1' });
    expect(audit[0].details.changes).toEqual({ priceCoins: [100, 30_000], priceDiamonds: [null, 25] });
  });

  it('null removes a price; saving the same values logs nothing', async () => {
    const { service, items, audit } = setup();
    await service.updateItem('a1', 'i1', { priceCoins: null });
    expect(items[0].priceCoins).toBeNull();
    await service.updateItem('a1', 'i1', { priceCoins: null, isActive: true });
    expect(audit).toHaveLength(1);
  });

  it('rejects an empty name and an unknown item', async () => {
    const { service } = setup();
    await expect(service.updateItem('a1', 'i1', { name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateItem('a1', 'nope', { priceCoins: 5 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restoring prices needs the saved backup table', async () => {
    const { service } = setup({ backup: false });
    expect(await service.priceBackup()).toEqual({ available: false, differing: [] });
    await expect(service.restorePrices('a1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('restores the saved prices and logs which items changed', async () => {
    const { service, prisma, audit } = setup({ backup: true });
    const row = { id: 'i1', name: 'Gold Foil', currentCoins: 100, currentDiamonds: null, backupCoins: 30000, backupDiamonds: 25 };
    prisma.$queryRaw
      .mockResolvedValueOnce([{ t: 'shop_prices_backup' }]) // exists (restore)
      .mockResolvedValueOnce([{ t: 'shop_prices_backup' }]) // exists (priceBackup)
      .mockResolvedValueOnce([row]);
    const res = await service.restorePrices('a1');
    expect(res).toEqual({ restored: 1 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(audit[0]).toMatchObject({ action: 'RESTORE_SHOP_PRICES' });
    expect(audit[0].details.items[0]).toMatchObject({ from: [100, null], to: [30000, 25] });
  });

  it('a promo limit cannot go below the uses so far', async () => {
    const { service } = setup();
    await expect(service.updatePromo('a1', 'p1', { maxUses: 2 })).rejects.toThrow('MAX_USES_BELOW_USED');
    const ok = await service.updatePromo('a1', 'p1', { maxUses: 20, expiresAt: '2027-01-01' });
    expect(ok.maxUses).toBe(20);
    expect(ok.expiresAt).toBeInstanceOf(Date);
  });

  it('only an unused promo can be deleted', async () => {
    const { service, promos, audit } = setup();
    await expect(service.deletePromo('a1', 'p1')).rejects.toThrow('PROMO_ALREADY_USED');
    expect(await service.deletePromo('a1', 'p2')).toEqual({ deleted: true });
    expect(promos.map((p) => p.id)).toEqual(['p1']);
    expect(audit[audit.length - 1]).toMatchObject({ action: 'DELETE_PROMO', details: { code: 'FRESH' } });
  });

  it('lists purchases with totals per store', async () => {
    const { prisma } = setup();
    prisma.iapPurchase = {
      findMany: jest.fn(async () => [{ id: 'x', store: 'GOOGLE_PLAY', productId: 'coins_1', transactionId: 't1', coins: 1000, environment: 'real', createdAt: new Date(), user: { id: 'u', username: 'ali' } }]),
      count: jest.fn(async () => 1),
      groupBy: jest.fn(async () => [{ store: 'GOOGLE_PLAY', _count: { _all: 1 }, _sum: { coins: 1000 } }]),
    };
    const res = await new AdminEconomyService(prisma).purchases({ search: 'ali' });
    expect(res.total).toBe(1);
    expect(res.byStore).toEqual([{ store: 'GOOGLE_PLAY', count: 1, coins: 1000 }]);
    expect(res.data[0].user.username).toBe('ali');
  });
});
