import { BadRequestException } from '@nestjs/common';
import { ProfileService, SEARCH_MAX_RESULTS } from './profile.service';

// "Add new friend" needs to find players by name. Results must never include yourself or
// anyone on either side of a block, and must say how you are already connected.
const ME = 'a1111111-1111-4111-8111-111111111111';
const user = (id: string, username: string, level = 3) => ({ id, username, avatarUrl: null, stats: { level, points: 120 } });

function setup(startsWith: any[] = [], contains: any[] = [], friendships: any[] = []) {
  const prisma = {
    user: {
      findMany: jest.fn()
        .mockResolvedValueOnce(startsWith)
        .mockResolvedValueOnce(contains),
    },
    friendship: { findMany: jest.fn(async () => friendships) },
  };
  const service = new ProfileService(prisma as any, {} as any, {} as any);
  return { service, prisma };
}

describe('ProfileService.searchPlayers', () => {
  it('rejects text that is too short or too long', async () => {
    const { service, prisma } = setup();
    await expect(service.searchPlayers(ME, ' a ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.searchPlayers(ME, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.searchPlayers(ME, 'x'.repeat(31))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('leaves out yourself, deleted, banned and blocked players, case-insensitively', async () => {
    const { service, prisma } = setup();
    await service.searchPlayers(ME, ' Ali ');

    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      id: { not: ME },
      isDeleted: false,
      isBanned: false,
      blocksGiven: { none: { blockedId: ME } },
      blocksReceived: { none: { blockerId: ME } },
      username: { startsWith: 'Ali', mode: 'insensitive' },
    });
  });

  it('lists starts-with matches first, then other matches, without repeats', async () => {
    const { service, prisma } = setup([user('u1', 'ali'), user('u2', 'alina')], [user('u3', 'khalid')]);
    const res = await service.searchPlayers(ME, 'ali');

    expect(res.map((r) => r.username)).toEqual(['ali', 'alina', 'khalid']);
    const second = prisma.user.findMany.mock.calls[1][0];
    expect(second.where.username).toEqual({ contains: 'ali', mode: 'insensitive' });
    expect(second.where.NOT).toEqual({ id: { in: ['u1', 'u2'] } });
    expect(second.take).toBe(SEARCH_MAX_RESULTS - 2);
  });

  it('skips the second query when starts-with already fills the page', async () => {
    const { service, prisma } = setup([user('u1', 'ali'), user('u2', 'alina')]);
    await service.searchPlayers(ME, 'ali', 2);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('caps the page size', async () => {
    const { service, prisma } = setup();
    await service.searchPlayers(ME, 'ali', 500);
    expect(prisma.user.findMany.mock.calls[0][0].take).toBe(SEARCH_MAX_RESULTS);
  });

  it('says how you are connected to each result', async () => {
    const { service } = setup(
      [user('f', 'friend'), user('s', 'sent'), user('r', 'received'), user('d', 'declined'), user('n', 'nobody')],
      [],
      [
        { id: 'x1', senderId: ME, receiverId: 'f', status: 'ACCEPTED' },
        { id: 'x2', senderId: ME, receiverId: 's', status: 'PENDING' },
        { id: 'x3', senderId: 'r', receiverId: ME, status: 'PENDING' },
        { id: 'x4', senderId: 'd', receiverId: ME, status: 'DECLINED' },
      ],
    );
    const res = await service.searchPlayers(ME, 'zz');

    expect(res.map((r) => [r.username, r.relation, r.requestId])).toEqual([
      ['friend', 'FRIEND', null],
      ['sent', 'REQUEST_SENT', 'x2'],
      ['received', 'REQUEST_RECEIVED', 'x3'],
      ['declined', 'NONE', null],
      ['nobody', 'NONE', null],
    ]);
    expect(res[0]).toEqual(expect.objectContaining({ level: 3, points: 120, avatarUrl: null }));
  });

  it('returns an empty list without looking up friendships when nothing matches', async () => {
    const { service, prisma } = setup();
    expect(await service.searchPlayers(ME, 'nobody')).toEqual([]);
    expect(prisma.friendship.findMany).not.toHaveBeenCalled();
  });
});
