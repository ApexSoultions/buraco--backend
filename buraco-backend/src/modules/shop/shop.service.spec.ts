import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CurrencyType, Prisma, ShopCategory } from '@prisma/client';
import { ShopService } from './shop.service';

// Buying used to check "already owned" and the balance outside the database transaction, so
// two quick taps could buy a table twice or take the balance below zero. Purchase is now one
// transaction: charge only when the balance is enough, give the item only after the charge.
const USER = 'u1';

function item(over: Partial<any> = {}) {
  return {
    id: 'i1', name: 'Marble Table', category: ShopCategory.TABLES, isActive: true,
    priceCoins: 1000, priceDiamonds: null, isConsumable: false, grantLives: null, ...over,
  };
}

function setup(opts: { item?: any; coins?: number; owned?: boolean } = {}) {
  const user = { coins: opts.coins ?? 5000, diamonds: 0, lives: 5 };
  const calls: string[] = [];
  const tx = {
    inventory: {
      create: jest.fn(async () => {
        calls.push('inventory.create');
        if (opts.owned) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        return {};
      }),
      upsert: jest.fn(async () => { calls.push('inventory.upsert'); return {}; }),
    },
    user: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const field = Object.keys(data)[0] as 'coins' | 'diamonds';
        if ((user as any)[field] < where[field].gte) return { count: 0 };
        (user as any)[field] -= data[field].decrement;
        calls.push('charge');
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ ...user })),
      update: jest.fn(async ({ data }: any) => { user.lives += data.lives.increment; calls.push('lives'); return {}; }),
    },
    transaction: { create: jest.fn(async () => { calls.push('ledger'); return {}; }) },
  };
  const prisma = {
    shopItem: { findUnique: jest.fn(async () => (opts.item === undefined ? item() : opts.item)) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const economy = { getBalance: jest.fn(async () => ({ ...user })) };
  return { service: new ShopService(prisma as any, economy as any), user, calls, tx };
}

describe('ShopService.purchaseItem', () => {
  it('charges once and gives a table', async () => {
    const { service, user, calls } = setup();
    const res = await service.purchaseItem(USER, 'i1', CurrencyType.COINS);
    expect(user.coins).toBe(4000);
    expect(calls).toEqual(['inventory.create', 'charge', 'ledger']);
    expect(res.newBalance.coins).toBe(4000);
  });

  it('refuses when the balance is too low, without going negative', async () => {
    const { service, user } = setup({ coins: 500 });
    await expect(service.purchaseItem(USER, 'i1', CurrencyType.COINS)).rejects.toThrow(BadRequestException);
    expect(user.coins).toBe(500);
  });

  it('a second purchase of an owned item is 409 and never charged', async () => {
    const { service, user, calls } = setup({ owned: true });
    await expect(service.purchaseItem(USER, 'i1', CurrencyType.COINS)).rejects.toThrow(ConflictException);
    expect(user.coins).toBe(5000);
    expect(calls).not.toContain('charge');
  });

  it('a lives pack adds its lives and can be bought again', async () => {
    const pack = item({ name: '5 Lives', category: ShopCategory.LIVES, priceCoins: 6000, isConsumable: true, grantLives: 5 });
    const { service, user, calls } = setup({ item: pack, coins: 13000 });
    await service.purchaseItem(USER, 'i1', CurrencyType.COINS);
    await service.purchaseItem(USER, 'i1', CurrencyType.COINS);
    expect(user.lives).toBe(15);
    expect(user.coins).toBe(1000);
    expect(calls).not.toContain('inventory.create');
  });

  it('refuses a currency the item has no price in, and unknown items', async () => {
    await expect(setup().service.purchaseItem(USER, 'i1', CurrencyType.DIAMONDS)).rejects.toThrow(BadRequestException);
    await expect(setup({ item: null }).service.purchaseItem(USER, 'x', CurrencyType.COINS)).rejects.toThrow(NotFoundException);
    await expect(setup().service.purchaseItem(USER, 'i1', 'GOLD' as any)).rejects.toThrow(BadRequestException);
  });
});
