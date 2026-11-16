import { RoomsService } from './rooms.service';

// Table-list seat cards show each seated player's picture, level and clan. The list is polled
// often, so profiles come from a short Redis cache and only the missing ones from the database.
function make(cached: Record<string, any> = {}) {
  const store: Record<string, string> = {};
  for (const [id, p] of Object.entries(cached)) store[`seatprofile:${id}`] = JSON.stringify(p);
  const redis = {
    mget: jest.fn(async (keys: string[]) => keys.map((k) => store[k] ?? null)),
    setJson: jest.fn(async (k: string, v: object) => { store[k] = JSON.stringify(v); }),
  };
  const prisma = {
    user: {
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: string) => ({
        id,
        avatarUrl: `/a/${id}.png`,
        stats: { level: 7 },
        clubMemberships: id === 'u1' ? [{ club: { name: 'Lions', iconUrl: '/c/lions.png' } }] : [],
      }))),
    },
  };
  const service = new RoomsService(prisma as any, {} as any, {} as any, redis as any, {} as any);
  return { service, prisma, redis };
}

describe('RoomsService seat profiles', () => {
  it('loads picture, level and clan for seated players and caches them', async () => {
    const { service, prisma, redis } = make();
    const out = await (service as any).seatProfiles(['u1', 'u2']);
    expect(out.u1).toEqual({ avatarUrl: '/a/u1.png', level: 7, clubName: 'Lions', clubIconUrl: '/c/lions.png' });
    expect(out.u2.clubName).toBeNull();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledTimes(2);
  });

  it('uses the cache and only queries players it does not have', async () => {
    const { service, prisma } = make({ u1: { avatarUrl: 'x', level: 3, clubName: null, clubIconUrl: null } });
    const out = await (service as any).seatProfiles(['u1', 'u2', 'u2']);
    expect(out.u1.level).toBe(3);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['u2'] } } }));
  });

  it('does nothing for an empty table', async () => {
    const { service, prisma } = make();
    expect(await (service as any).seatProfiles([])).toEqual({});
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
