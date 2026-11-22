import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CurrencyType, Prisma, TransactionType } from '@prisma/client';
import { AdminPlayersService } from './admin-players.service';

// Players in the admin panel: balance changes in one step, bans that take effect at once,
// name resets, notes.
function setup() {
  const user: any = { id: 'u1', username: 'BadName', coins: 1000, diamonds: 5, lives: 3, isBanned: false, banReason: null };
  const ledger: any[] = [];
  const audit: any[] = [];
  const notes: any[] = [];
  const takenNames = new Set<string>();
  const tokensDeleted: string[] = [];
  const kicked: string[] = [];

  const matches = (where: any) => {
    if (where.id !== user.id) return false;
    for (const f of ['coins', 'diamonds', 'lives']) if (where[f]?.gte !== undefined && user[f] < where[f].gte) return false;
    return true;
  };
  const userApi = {
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (!matches(where)) return { count: 0 };
      for (const [k, v] of Object.entries<any>(data)) user[k] += v.increment ?? -(v.decrement ?? 0);
      return { count: 1 };
    }),
    count: jest.fn(async ({ where }: any) => (where.id === user.id ? 1 : 0)),
    // Like the real database: a copy, not the stored row.
    findUnique: jest.fn(async ({ where }: any) => (where.id === user.id ? { ...user } : null)),
    findUniqueOrThrow: jest.fn(async () => ({ ...user })),
    update: jest.fn(async ({ data }: any) => {
      if (data.username && takenNames.has(data.username)) {
        throw new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' });
      }
      Object.assign(user, data);
      return user;
    }),
  };
  const tx: any = {
    user: userApi,
    transaction: { create: jest.fn(async ({ data }: any) => { ledger.push(data); return data; }) },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
  };
  const prisma: any = {
    ...tx,
    refreshToken: { deleteMany: jest.fn(async ({ where }: any) => { tokensDeleted.push(where.userId); return { count: 2 }; }) },
    adminNote: { create: jest.fn(async ({ data }: any) => { notes.push(data); return data; }) },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
  };
  const sockets: any = { kickUser: jest.fn((id: string) => kicked.push(id)) };
  return { service: new AdminPlayersService(prisma, sockets), user, ledger, audit, notes, takenNames, tokensDeleted, kicked };
}

describe('AdminPlayersService', () => {
  it('adds and takes coins with a history line, and refuses to go below zero', async () => {
    const { service, user, ledger } = setup();
    await service.changeBalance('a1', 'u1', { currency: CurrencyType.COINS, amount: 500, reason: 'support' }, 1);
    expect(user.coins).toBe(1500);
    expect(ledger[0]).toMatchObject({ type: TransactionType.MANUAL_CREDIT, balanceBefore: 1000, balanceAfter: 1500, performedBy: 'a1' });

    await expect(service.changeBalance('a1', 'u1', { currency: CurrencyType.COINS, amount: 9999 }, -1))
      .rejects.toThrow('INSUFFICIENT_BALANCE');
    expect(user.coins).toBe(1500); // nothing taken

    await service.changeBalance('a1', 'u1', { currency: CurrencyType.DIAMONDS, amount: 5 }, -1);
    expect(user.diamonds).toBe(0);
  });

  it('gives and takes lives, never below zero', async () => {
    const { service, user, audit } = setup();
    expect(await service.changeLives('a1', 'u1', { amount: 2 })).toEqual({ lives: 5 });
    await expect(service.changeLives('a1', 'u1', { amount: -6 })).rejects.toThrow('NOT_ENOUGH_LIVES');
    expect(user.lives).toBe(5);
    await expect(service.changeLives('a1', 'u1', { amount: 0 })).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.map((a) => a.action)).toContain('GIVE_LIVES');
  });

  it('a ban logs the player out everywhere at once; unban only lifts it', async () => {
    const { service, user, tokensDeleted, kicked } = setup();
    await service.setBan('a1', 'u1', { isBanned: true, reason: ' cheating ' });
    expect(user).toMatchObject({ isBanned: true, banReason: 'cheating' });
    expect(tokensDeleted).toEqual(['u1']);
    expect(kicked).toEqual(['u1']);

    await service.setBan('a1', 'u1', { isBanned: false });
    expect(user).toMatchObject({ isBanned: false, banReason: null });
    expect(kicked).toEqual(['u1']); // not kicked again
  });

  it('resets a name to Player + 6 digits, trying again if that name is taken', async () => {
    const { service, user, audit, takenNames } = setup();
    // The first name tried is "taken"; the second is free.
    let first = true;
    takenNames.has = ((name: string) => { if (first) { first = false; return true; } return false; }) as any;
    const { username } = await service.resetName('a1', 'u1');
    expect(username).toMatch(/^Player\d{6}$/);
    expect(user.username).toBe(username);
    expect(audit.find((a) => a.action === 'RESET_NAME').details).toMatchObject({ from: 'BadName', to: username });
  });

  it('refuses empty notes and unknown players', async () => {
    const { service, notes } = setup();
    await expect(service.addNote('a1', 'u1', '   ')).rejects.toThrow('NOTE_EMPTY');
    await expect(service.addNote('a1', 'nobody', 'hi')).rejects.toBeInstanceOf(NotFoundException);
    await service.addNote('a1', 'u1', '  warned in chat  ');
    expect(notes[0]).toMatchObject({ content: 'warned in chat', adminId: 'a1' });
  });
});
