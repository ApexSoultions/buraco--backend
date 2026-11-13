import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SpecialService } from './special.service';

// Special Features are bought with coins: the coins are taken only when the balance is enough,
// together with the change, and short names (1–3 characters) can only be bought, once.
function setup(opts: { coins?: number; taken?: string[]; role?: string } = {}) {
  const user = { id: 'u1', username: 'player_one', coins: opts.coins ?? 100000, blockLimit: 50 };
  const club = { id: 'c1', name: 'Aces', maxMembers: 30 };
  const taken = new Set((opts.taken ?? []).map((t) => t.toUpperCase()));
  const tx: any = {
    user: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (user.coins < where.coins.gte) return { count: 0 };
        user.coins -= data.coins.decrement;
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ coins: user.coins })),
      update: jest.fn(async ({ data }: any) => {
        if (data.username) user.username = data.username;
        if (data.blockLimit) user.blockLimit += data.blockLimit.increment;
        return { ...user };
      }),
    },
    club: {
      update: jest.fn(async ({ data }: any) => {
        if (data.name) club.name = data.name;
        if (data.maxMembers) club.maxMembers += data.maxMembers.increment;
        return { ...club };
      }),
    },
    transaction: { create: jest.fn(async () => ({})) },
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    user: {
      findUnique: jest.fn(async () => ({ ...user })),
      findFirst: jest.fn(async ({ where }: any) => (taken.has(String(where.username.equals).toUpperCase()) ? { id: 'other' } : null)),
      findMany: jest.fn(async () => [...taken].map((username) => ({ username }))),
    },
    club: { findFirst: jest.fn(async () => null) },
    clubMember: { findUnique: jest.fn(async () => ({ role: opts.role ?? 'LEADER', status: 'ACTIVE' })) },
  };
  return { service: new SpecialService(prisma), user, club };
}

describe('SpecialService', () => {
  it('buys a 2-letter name for its price and sets it in capitals', async () => {
    const { service, user } = setup({ coins: 10000 });
    const res = await service.buyShortName('u1', 'ab');
    expect(res).toMatchObject({ username: 'AB', price: 7000, balance: { coins: 3000 } });
    expect(user.username).toBe('AB');
  });

  it('refuses a taken or reserved short name, a bad name, or too few coins (nothing charged)', async () => {
    const { service, user } = setup({ coins: 500, taken: ['AA'] });
    await expect(service.buyShortName('u1', 'aa')).rejects.toThrow(ConflictException);
    await expect(service.buyShortName('u1', 'ABCD')).rejects.toThrow(BadRequestException);
    await expect(service.buyShortName('u1', 'A_')).rejects.toThrow(BadRequestException);
    await expect(service.buyShortName('u1', 'ABC')).rejects.toThrow('INSUFFICIENT_BALANCE');
    expect(user.coins).toBe(500);
  });

  it('buying the name you already have is refused, not charged twice', async () => {
    const { service, user } = setup({ coins: 10000 });
    await service.buyShortName('u1', 'XY');
    await expect(service.buyShortName('u1', 'xy')).rejects.toThrow('That is already your name');
    expect(user.coins).toBe(3000);
  });

  it('lists short names with which can still be bought', async () => {
    const { service } = setup({ taken: ['AB'] });
    const list = await service.listShortNames(2, 'a', 3);
    expect(list).toMatchObject({ price: 7000, names: [{ name: 'AA', available: true }, { name: 'AB', available: false }, { name: 'AC', available: true }] });
  });

  it('a rename costs 1,000 and needs 4+ characters', async () => {
    const { service, user } = setup({ coins: 1500 });
    await expect(service.rename('u1', 'abc')).rejects.toThrow(BadRequestException);
    await expect(service.rename('u1', 'admin')).rejects.toThrow(ConflictException);
    await service.rename('u1', 'new_name');
    expect(user).toMatchObject({ username: 'new_name', coins: 500 });
  });

  it('club rename and seats are for the club leader; seats add 10', async () => {
    const leader = setup();
    await leader.service.addClubSeats('u1', 'c1');
    expect(leader.club.maxMembers).toBe(40);
    await leader.service.renameClub('u1', 'c1', 'Kings');
    expect(leader.club.name).toBe('Kings');

    const member = setup({ role: 'MEMBER' });
    await expect(member.service.addClubSeats('u1', 'c1')).rejects.toThrow(ForbiddenException);
  });

  it('+10 black list adds 10', async () => {
    const { service, user } = setup();
    expect(await service.addBlockSlots('u1')).toMatchObject({ blockLimit: 60, price: 40000 });
    expect(user.blockLimit).toBe(60);
  });
});
