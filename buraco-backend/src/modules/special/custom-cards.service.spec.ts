import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomCardStatus } from '@prisma/client';
import { CustomCardsService } from './custom-cards.service';

// Custom Cards: paid when sent, private picture, usable only after approval, refunded if rejected.
function setup(opts: { coins?: number; pending?: number } = {}) {
  const user = { coins: opts.coins ?? 100000 };
  const cards: any[] = [];
  const uploads: string[] = [];
  const ledger: any[] = [];
  const inventoryUnequip = jest.fn(async () => ({ count: 1 }));
  for (let i = 0; i < (opts.pending ?? 0); i++) cards.push({ id: `old${i}`, userId: 'u1', status: CustomCardStatus.PENDING, imageKey: 'k', pricePaid: 40000, isEquipped: false });

  const tx: any = {
    user: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (user.coins < where.coins.gte) return { count: 0 };
        user.coins -= data.coins.decrement;
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ coins: user.coins })),
      update: jest.fn(async ({ data }: any) => { user.coins += data.coins.increment; return { coins: user.coins }; }),
    },
    customCard: {
      create: jest.fn(async ({ data }: any) => {
        const c = { id: `c${cards.length}`, status: CustomCardStatus.PENDING, isEquipped: false, ...data };
        cards.push(c);
        return c;
      }),
      findFirst: jest.fn(async ({ where }: any) => cards.find((c) => c.id === where.id && (!where.userId || c.userId === where.userId) && (!where.status || c.status === where.status)) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = cards.filter((c) => (!where.id || c.id === where.id) && (!where.status || c.status === where.status) && (where.isEquipped === undefined || c.isEquipped === where.isEquipped));
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(cards.find((c) => c.id === where.id), data)),
    },
    transaction: { create: jest.fn(async ({ data }: any) => { ledger.push(data); return data; }) },
    inventory: { updateMany: inventoryUnequip },
  };
  const prisma: any = {
    ...tx,
    user: { ...tx.user, findUnique: jest.fn(async () => ({ coins: user.coins })) },
    customCard: {
      ...tx.customCard,
      count: jest.fn(async ({ where }: any) => cards.filter((c) => c.status === where.status).length),
      findMany: jest.fn(async () => [...cards]),
    },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
  };
  const s3: any = {
    uploadPrivate: jest.fn(async (key: string) => { uploads.push(key); return key; }),
    signUrls: jest.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `https://signed/${k}`]))),
  };
  const file = { mimetype: 'image/jpeg', buffer: Buffer.from('jpg') } as Express.Multer.File;
  return { service: new CustomCardsService(prisma, s3), user, cards, uploads, ledger, file, inventoryUnequip };
}

describe('CustomCardsService', () => {
  it('charges 40,000, stores the picture privately and waits for review', async () => {
    const { service, user, uploads, file } = setup({ coins: 50000 });
    const res = await service.create('u1', file);
    expect(user.coins).toBe(10000);
    expect(uploads[0]).toMatch(/^custom-cards\/u1\/.+\.jpg$/);
    expect(res.card).toMatchObject({ status: CustomCardStatus.PENDING, imageUrl: expect.stringContaining('https://signed/') });
    expect(res.card).not.toHaveProperty('imageKey');
  });

  it('refuses without coins (nothing uploaded), a wrong file, and a 4th card in review', async () => {
    const poor = setup({ coins: 100 });
    await expect(poor.service.create('u1', poor.file)).rejects.toThrow('INSUFFICIENT_BALANCE');
    expect(poor.uploads).toHaveLength(0);
    await expect(poor.service.create('u1', { ...poor.file, mimetype: 'image/gif' } as any)).rejects.toThrow(BadRequestException);
    const full = setup({ pending: 3 });
    await expect(full.service.create('u1', full.file)).rejects.toThrow(ConflictException);
  });

  it('can only be used once approved; using it puts the Shop card back away', async () => {
    const { service, file, inventoryUnequip } = setup();
    const { card } = await service.create('u1', file);
    await expect(service.equip('u1', card.id)).rejects.toThrow('CUSTOM_CARD_NOT_APPROVED');
    await service.approve(card.id, 'admin1');
    await expect(service.equip('u1', card.id)).resolves.toMatchObject({ isEquipped: true });
    expect(inventoryUnequip).toHaveBeenCalled();
    await expect(service.equip('u2', card.id)).rejects.toThrow(NotFoundException);
  });

  it('rejecting gives the coins back once', async () => {
    const { service, user, ledger, file } = setup({ coins: 40000 });
    const { card } = await service.create('u1', file);
    expect(user.coins).toBe(0);
    await expect(service.reject(card.id, 'admin1', 'Not allowed')).resolves.toMatchObject({ refunded: 40000 });
    expect(user.coins).toBe(40000);
    expect(ledger.at(-1)).toMatchObject({ type: 'REFUND', amount: 40000 });
    await expect(service.reject(card.id, 'admin1')).rejects.toThrow(NotFoundException);
    expect(user.coins).toBe(40000);
  });
});
