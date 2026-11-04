import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClubRole, ClubType, MemberStatus, NotificationType } from '@prisma/client';
import { ClubsService, clubLevelFor } from './clubs.service';

// Clubs, against a small in-memory store:
// - club events notify the right people, and joining counts for the Join a Club mission
// - members are added to / removed from the club chat (nobody ever was before)
// - joining twice no longer counts twice; a withdrawn request does not lower the count
// - vice leaders cannot remove officers; handing over LEADER demotes the old leader
// - a club can be deleted (its chat used to block the delete)
// - match points raise the club level, possibly several levels at once
const CLUB = 'c0000000-0000-4000-8000-000000000001';
const OTHER_CLUB = 'c0000000-0000-4000-8000-000000000002';
const CONV = 'v0000000-0000-4000-8000-000000000001';
const LEADER = 'a1111111-1111-4111-8111-111111111111';
const VICE = 'b2222222-2222-4222-8222-222222222222';
const PLAYER = 'd4444444-4444-4444-8444-444444444444';

type Member = { clubId: string; userId: string; role: ClubRole; status: MemberStatus; joinedAt: Date };

function setup(opts: { type?: ClubType; extraMembers?: Member[]; points?: number; level?: number } = {}) {
  const club = { id: CLUB, name: 'Aces', type: opts.type ?? ClubType.OPEN, minPoints: 0, points: opts.points ?? 0, level: opts.level ?? 1, memberCount: 2 };
  const members: Member[] = [
    { clubId: CLUB, userId: LEADER, role: ClubRole.LEADER, status: MemberStatus.ACTIVE, joinedAt: new Date() },
    { clubId: CLUB, userId: VICE, role: ClubRole.VICE_LEADER, status: MemberStatus.ACTIVE, joinedAt: new Date() },
    ...(opts.extraMembers ?? []),
  ];
  const chat = new Set<string>([LEADER, VICE]);
  let clubDeleted = false;
  let chatDeleted = false;

  const find = (clubId: string, userId: string) => members.find((m) => m.clubId === clubId && m.userId === userId);
  const matches = (m: Member, where: any) =>
    (!where.clubId || m.clubId === where.clubId) &&
    (!where.userId || (typeof where.userId === 'string' ? m.userId === where.userId : m.userId !== where.userId.not)) &&
    (!where.status || m.status === where.status) &&
    (!where.role || where.role.in.includes(m.role));

  const db: any = {
    club: {
      findUnique: jest.fn(async () => (clubDeleted ? null : { ...club })),
      update: jest.fn(async ({ data }: any) => {
        if (data.memberCount?.increment) club.memberCount += data.memberCount.increment;
        if (data.memberCount?.decrement) club.memberCount -= data.memberCount.decrement;
        if (data.points?.increment) club.points += data.points.increment;
        return { ...club };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!(club.level < where.level.lt)) return { count: 0 };
        club.level = data.level;
        return { count: 1 };
      }),
      delete: jest.fn(async () => { clubDeleted = true; }),
    },
    clubMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const m = find(where.clubId_userId.clubId, where.clubId_userId.userId);
        return m ? { ...m } : null;
      }),
      findFirst: jest.fn(async ({ where }: any) => members.find((m) => matches(m, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => members.filter((m) => matches(m, where)).map((m) => ({ ...m }))),
      create: jest.fn(async ({ data }: any) => { members.push({ joinedAt: new Date(), ...data }); }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const m = find(where.clubId_userId.clubId, where.clubId_userId.userId);
        if (m) Object.assign(m, update); else members.push({ joinedAt: new Date(), ...create });
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const m = find(where.clubId_userId.clubId, where.clubId_userId.userId)!;
        Object.assign(m, data);
        return { ...m };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const i = members.findIndex((m) => m.clubId === where.clubId_userId.clubId && m.userId === where.clubId_userId.userId);
        members.splice(i, 1);
      }),
    },
    conversation: {
      findUnique: jest.fn(async () => (chatDeleted ? null : { id: CONV })),
      create: jest.fn(async () => ({ id: CONV })),
      delete: jest.fn(async () => { chatDeleted = true; }),
    },
    conversationMember: {
      upsert: jest.fn(async ({ where }: any) => { chat.add(where.conversationId_userId.userId); }),
      deleteMany: jest.fn(async ({ where }: any) => { if (where.userId) chat.delete(where.userId); else chat.clear(); }),
    },
    message: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    playerStats: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ username: 'player' })) },
  };
  db.$transaction = jest.fn(async (fn: any) => fn(db));

  const notifications = { notifySafely: jest.fn(async () => undefined) };
  const missions = { updateProgressSafely: jest.fn(async () => undefined) };
  const service = new ClubsService(db, notifications as any, missions as any);
  return { service, db, club, members, chat, notifications, missions, isDeleted: () => clubDeleted };
}

const pending = (userId = PLAYER): Member => ({ clubId: CLUB, userId, role: ClubRole.MEMBER, status: MemberStatus.PENDING, joinedAt: new Date() });
const active = (userId = PLAYER, role: ClubRole = ClubRole.MEMBER, clubId = CLUB): Member => ({ clubId, userId, role, status: MemberStatus.ACTIVE, joinedAt: new Date() });

describe('ClubsService — joining', () => {
  it('joining an open club adds the member, the chat seat, the count and the mission', async () => {
    const { service, club, chat, missions, notifications } = setup();
    await service.joinClub(PLAYER, CLUB);

    expect(club.memberCount).toBe(3);
    expect(chat.has(PLAYER)).toBe(true);
    expect(missions.updateProgressSafely).toHaveBeenCalledWith(PLAYER, 'JOIN_CLUB');
    expect(notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'player joined the club', expect.objectContaining({ clubId: CLUB, event: 'MEMBER_JOINED', userId: PLAYER }));
  });

  it('refuses joining twice, so the member count is not inflated', async () => {
    const { service, club } = setup();
    await service.joinClub(PLAYER, CLUB);
    await expect(service.joinClub(PLAYER, CLUB)).rejects.toThrow('ALREADY_IN_CLUB');
    expect(club.memberCount).toBe(3);
  });

  it('refuses joining while already in another club', async () => {
    const { service } = setup({ extraMembers: [active(PLAYER, ClubRole.MEMBER, OTHER_CLUB)] });
    await expect(service.joinClub(PLAYER, CLUB)).rejects.toThrow('ALREADY_IN_CLUB');
    await expect(service.requestToJoin(PLAYER, CLUB)).rejects.toThrow('ALREADY_IN_CLUB');
  });

  it('a join request notifies the officers', async () => {
    const { service, notifications } = setup({ type: ClubType.REQUEST_BASED });
    await service.requestToJoin(PLAYER, CLUB);
    expect(notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'player asked to join the club', expect.objectContaining({ event: 'JOIN_REQUEST', userId: PLAYER }));
  });

  it('accepting a request adds the member to the club and its chat', async () => {
    const { service, club, chat, missions, notifications } = setup({ extraMembers: [pending()] });
    await service.respondToRequest(LEADER, CLUB, PLAYER, true);

    expect(club.memberCount).toBe(3);
    expect(chat.has(PLAYER)).toBe(true);
    expect(missions.updateProgressSafely).toHaveBeenCalledWith(PLAYER, 'JOIN_CLUB');
    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, NotificationType.CLUB_REQUEST_ACCEPTED, 'Aces',
      'Your request to join Aces was accepted', { clubId: CLUB });
  });

  it('declining a request changes nothing but tells the player', async () => {
    const { service, club, chat, missions, notifications, members } = setup({ extraMembers: [pending()] });
    await service.respondToRequest(VICE, CLUB, PLAYER, false);

    expect(club.memberCount).toBe(2);
    expect(chat.has(PLAYER)).toBe(false);
    expect(members.some((m) => m.userId === PLAYER)).toBe(false);
    expect(missions.updateProgressSafely).not.toHaveBeenCalled();
    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, NotificationType.CLUB_REQUEST_DECLINED, 'Aces',
      'Your request to join Aces was declined', { clubId: CLUB });
  });
});

describe('ClubsService — leaving and removal', () => {
  it('leaving removes the member from the chat and the count, and tells the officers', async () => {
    const { service, club, chat, notifications } = setup({ extraMembers: [active()] });
    chat.add(PLAYER);
    await service.leaveClub(PLAYER, CLUB);

    expect(club.memberCount).toBe(1);
    expect(chat.has(PLAYER)).toBe(false);
    expect(notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'player left the club', expect.objectContaining({ event: 'MEMBER_LEFT' }));
  });

  it('withdrawing a pending request does not lower the count or notify', async () => {
    const { service, club, notifications } = setup({ extraMembers: [pending()] });
    await service.leaveClub(PLAYER, CLUB);
    expect(club.memberCount).toBe(2);
    expect(notifications.notifySafely).not.toHaveBeenCalled();
  });

  it('the leader cannot leave without handing over', async () => {
    const { service } = setup();
    await expect(service.leaveClub(LEADER, CLUB)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removing a member updates chat and count and tells them', async () => {
    const { service, club, chat, notifications } = setup({ extraMembers: [active()] });
    chat.add(PLAYER);
    await service.removeMember(VICE, CLUB, PLAYER);

    expect(club.memberCount).toBe(1);
    expect(chat.has(PLAYER)).toBe(false);
    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, NotificationType.CLUB_UPDATE, 'Aces',
      'You were removed from Aces', { clubId: CLUB, event: 'REMOVED' });
  });

  it('a vice leader cannot remove the leader or another officer; nobody removes a pending request this way', async () => {
    const { service } = setup({ extraMembers: [active(PLAYER, ClubRole.VICE_LEADER), pending('e5555555-5555-4555-8555-555555555555')] });
    await expect(service.removeMember(VICE, CLUB, LEADER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.removeMember(VICE, CLUB, PLAYER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.removeMember(LEADER, CLUB, 'e5555555-5555-4555-8555-555555555555')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a plain member cannot remove anyone', async () => {
    const { service } = setup({ extraMembers: [active()] });
    await expect(service.removeMember(PLAYER, CLUB, VICE)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ClubsService — roles', () => {
  it('tells a player about their new role', async () => {
    const { service, notifications } = setup({ extraMembers: [active()] });
    await service.assignRole(LEADER, CLUB, PLAYER, ClubRole.VICE_LEADER);
    expect(notifications.notifySafely).toHaveBeenCalledWith(PLAYER, NotificationType.CLUB_UPDATE, 'Aces',
      'You are now vice leader of Aces', expect.objectContaining({ event: 'ROLE_CHANGED', role: ClubRole.VICE_LEADER }));
  });

  it('handing over LEADER demotes the old leader, so there is one leader, who can then leave', async () => {
    const { service, members } = setup({ extraMembers: [active()] });
    await service.assignRole(LEADER, CLUB, PLAYER, ClubRole.LEADER);

    expect(members.filter((m) => m.role === ClubRole.LEADER).map((m) => m.userId)).toEqual([PLAYER]);
    expect(members.find((m) => m.userId === LEADER)!.role).toBe(ClubRole.VICE_LEADER);
    await expect(service.leaveClub(LEADER, CLUB)).resolves.toBeUndefined();
  });

  it('refuses changing your own role or a non-member', async () => {
    const { service } = setup();
    await expect(service.assignRole(LEADER, CLUB, LEADER, ClubRole.MEMBER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.assignRole(LEADER, CLUB, PLAYER, ClubRole.MEMBER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClubsService — delete', () => {
  it('removes the chat first, then the club, and tells the other members', async () => {
    const { service, db, isDeleted, notifications } = setup({ extraMembers: [active()] });
    await expect(service.deleteClub(LEADER, CLUB)).resolves.toEqual({ deleted: true });

    expect(db.message.deleteMany).toHaveBeenCalled();
    expect(db.conversation.delete).toHaveBeenCalled();
    expect(db.conversation.delete.mock.invocationCallOrder[0]).toBeLessThan(db.club.delete.mock.invocationCallOrder[0]);
    expect(isDeleted()).toBe(true);
    expect(notifications.notifySafely).toHaveBeenCalledWith(expect.arrayContaining([VICE, PLAYER]), NotificationType.CLUB_UPDATE,
      'Aces', 'Aces was closed by its leader', { clubId: CLUB, event: 'CLUB_DELETED' });
  });

  it('only the leader can delete', async () => {
    const { service, isDeleted } = setup();
    await expect(service.deleteClub(VICE, CLUB)).rejects.toBeInstanceOf(ForbiddenException);
    expect(isDeleted()).toBe(false);
  });
});

describe('ClubsService — points and levels', () => {
  it('level is one per 1000 points', () => {
    expect(clubLevelFor(0)).toBe(1);
    expect(clubLevelFor(999)).toBe(1);
    expect(clubLevelFor(1000)).toBe(2);
    expect(clubLevelFor(3500)).toBe(4);
  });

  it('match points go to the player\'s club', async () => {
    const { service, club } = setup({ extraMembers: [active()] });
    await service.awardMatchPointsSafely(PLAYER, 120);
    expect(club.points).toBe(120);
  });

  it('players without a club, and zero points, change nothing', async () => {
    const { service, db } = setup();
    await service.awardMatchPointsSafely(PLAYER, 120);
    await service.awardMatchPointsSafely(LEADER, 0);
    expect(db.club.update).not.toHaveBeenCalled();
  });

  it('crossing several levels at once raises the level that far and announces it once', async () => {
    const { service, club, notifications } = setup({ points: 900, level: 1 });
    await service.addClubPoints(CLUB, 2200);

    expect(club.level).toBe(4);
    expect(notifications.notifySafely).toHaveBeenCalledTimes(1);
    expect(notifications.notifySafely).toHaveBeenCalledWith([LEADER, VICE], NotificationType.CLUB_UPDATE, 'Aces',
      'Aces reached level 4!', { clubId: CLUB, event: 'LEVEL_UP', level: 4 });
  });

  it('no announcement without a new level', async () => {
    const { service, club, notifications } = setup({ points: 100, level: 1 });
    await service.addClubPoints(CLUB, 50);
    expect(club.level).toBe(1);
    expect(notifications.notifySafely).not.toHaveBeenCalled();
  });

  it('awardMatchPointsSafely never throws', async () => {
    const { service, db } = setup({ extraMembers: [active()] });
    db.club.update.mockRejectedValueOnce(new Error('db down'));
    await expect(service.awardMatchPointsSafely(PLAYER, 50)).resolves.toBeUndefined();
  });

  it('reports progress within the current level', () => {
    const { service } = setup();
    expect(service.levelProgress(2350)).toEqual({ pointsPerLevel: 1000, pointsInLevel: 350, pointsToNextLevel: 650, progressToNextLevel: 35 });
  });
});
