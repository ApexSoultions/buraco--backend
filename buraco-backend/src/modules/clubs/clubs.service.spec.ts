import { ClubRole, ClubType, MemberStatus, NotificationType } from '@prisma/client';
import { ClubsService } from './clubs.service';

// Club events now create notifications: officers hear about joins, requests and leavers;
// a player hears about the answer to their request, removal and a new role.
const CLUB = 'c0000000-0000-4000-8000-000000000001';
const LEADER = 'a1111111-1111-4111-8111-111111111111';
const VICE = 'b2222222-2222-4222-8222-222222222222';
const PLAYER = 'd4444444-4444-4444-8444-444444444444';

function setup(opts: { member?: any; type?: ClubType } = {}) {
  const roles: Record<string, ClubRole> = { [LEADER]: ClubRole.LEADER, [VICE]: ClubRole.VICE_LEADER };
  const tx = {
    clubMember: { upsert: jest.fn(), update: jest.fn(), delete: jest.fn() },
    club: { update: jest.fn() },
  };
  const prisma = {
    club: {
      findUnique: jest.fn(async () => ({ id: CLUB, name: 'Aces', type: opts.type ?? ClubType.OPEN, minPoints: 0 })),
    },
    clubMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const userId = where.clubId_userId.userId;
        if (roles[userId]) return { userId, role: roles[userId], status: MemberStatus.ACTIVE };
        return opts.member ?? null;
      }),
      findMany: jest.fn(async () => [{ userId: LEADER }, { userId: VICE }]),
      create: jest.fn(),
      update: jest.fn(async ({ data }: any) => ({ userId: PLAYER, ...data })),
      delete: jest.fn(),
    },
    playerStats: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ username: 'player' })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const notifications = { notifySafely: jest.fn(async () => undefined) };
  const missions = { updateProgressSafely: jest.fn(async () => undefined) };
  const service = new ClubsService(prisma as any, notifications as any, missions as any);
  return { service, notifications, missions };
}

describe('ClubsService — Join a Club mission', () => {
  it('counts joining an open club', async () => {
    const { service, missions } = setup();
    await service.joinClub(PLAYER, CLUB);
    expect(missions.updateProgressSafely).toHaveBeenCalledWith(PLAYER, 'JOIN_CLUB');
  });

  it('counts an accepted request, not a declined one', async () => {
    const pending = { userId: PLAYER, role: ClubRole.MEMBER, status: MemberStatus.PENDING };
    const accepted = setup({ member: pending });
    await accepted.service.respondToRequest(LEADER, CLUB, PLAYER, true);
    expect(accepted.missions.updateProgressSafely).toHaveBeenCalledWith(PLAYER, 'JOIN_CLUB');

    const declined = setup({ member: pending });
    await declined.service.respondToRequest(LEADER, CLUB, PLAYER, false);
    expect(declined.missions.updateProgressSafely).not.toHaveBeenCalled();
  });
});

describe('ClubsService notifications', () => {
  it('tells the officers when someone joins an open club', async () => {
    const { service, notifications } = setup();
    await service.joinClub(PLAYER, CLUB);

    expect(notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'player joined the club', expect.objectContaining({ clubId: CLUB, event: 'MEMBER_JOINED', userId: PLAYER }));
  });

  it('tells the officers about a join request', async () => {
    const { service, notifications } = setup({ type: ClubType.REQUEST_BASED });
    await service.requestToJoin(PLAYER, CLUB);

    expect(notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'player asked to join the club', expect.objectContaining({ event: 'JOIN_REQUEST', userId: PLAYER }));
  });

  it.each([
    [true, NotificationType.CLUB_REQUEST_ACCEPTED, 'Your request to join Aces was accepted'],
    [false, NotificationType.CLUB_REQUEST_DECLINED, 'Your request to join Aces was declined'],
  ])('tells the player the answer to their request (accept=%s)', async (accept, type, body) => {
    const { service, notifications } = setup({ member: { userId: PLAYER, role: ClubRole.MEMBER, status: MemberStatus.PENDING } });
    await service.respondToRequest(LEADER, CLUB, PLAYER, accept);

    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, type, 'Aces', body, { clubId: CLUB });
  });

  it('tells a removed player', async () => {
    const { service, notifications } = setup();
    await service.removeMember(LEADER, CLUB, PLAYER);

    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, NotificationType.CLUB_UPDATE, 'Aces',
      'You were removed from Aces', { clubId: CLUB, event: 'REMOVED' });
  });

  it('tells a player about their new role', async () => {
    const { service, notifications } = setup();
    await service.assignRole(LEADER, CLUB, PLAYER, ClubRole.VICE_LEADER);

    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, NotificationType.CLUB_UPDATE, 'Aces',
      'You are now vice leader of Aces', expect.objectContaining({ event: 'ROLE_CHANGED', role: ClubRole.VICE_LEADER }));
  });

  it('tells the officers when an active member leaves, but not for a withdrawn request', async () => {
    const active = setup({ member: { userId: PLAYER, role: ClubRole.MEMBER, status: MemberStatus.ACTIVE } });
    await active.service.leaveClub(PLAYER, CLUB);
    expect(active.notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'player left the club', expect.objectContaining({ event: 'MEMBER_LEFT' }));

    const pending = setup({ member: { userId: PLAYER, role: ClubRole.MEMBER, status: MemberStatus.PENDING } });
    await pending.service.leaveClub(PLAYER, CLUB);
    expect(pending.notifications.notifySafely).not.toHaveBeenCalled();
  });
});
