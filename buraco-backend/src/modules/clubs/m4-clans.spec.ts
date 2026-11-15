import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ClubInviteStatus, ClubRole, MemberStatus, MissionRequirement } from '@prisma/client';
import { ClubObjectivesService, nextWeekStart, weekPeriod } from './club-objectives.service';
import { ClubInvitesService } from './club-invites.service';
import { AchievementsService } from '../missions/achievements.service';
import { StatsService } from '../stats/stats.service';

// Milestone 4 backend: clan objectives, invites, achievements and the level table.

describe('Clan objectives', () => {
  it('weeks run Monday to Sunday (ISO weeks) and end next Monday', () => {
    expect(weekPeriod(new Date('2026-11-16T10:00:00Z'))).toBe('2026-W47'); // Monday
    expect(weekPeriod(new Date('2026-11-22T23:00:00Z'))).toBe('2026-W47'); // Sunday
    expect(weekPeriod(new Date('2026-11-23T00:00:00Z'))).toBe('2026-W48');
    expect(nextWeekStart(new Date('2026-11-18T12:00:00Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });

  function objectivesSetup(target = 3) {
    const objective = { id: 'o1', title: 'Win 3', requirement: MissionRequirement.WIN_GAMES, targetValue: target, mode: null, isActive: true };
    const row: any = { id: 'r1', clubId: 'c1', objectiveId: 'o1', period: '', currentValue: 0, completedAt: null };
    const prisma: any = {
      clubObjective: { findMany: jest.fn(async () => [objective]) },
      clubObjectiveProgress: {
        createMany: jest.fn(async () => ({})),
        findMany: jest.fn(async () => (row.completedAt ? [] : [{ ...row }])),
        update: jest.fn(async ({ data }: any) => { row.currentValue += data.currentValue.increment; return { ...row }; }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.completedAt === null && row.completedAt) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    return { service: new ClubObjectivesService(prisma), row };
  }

  it('counts every member\'s wins and completes the objective once', async () => {
    const { service, row } = objectivesSetup(3);
    const win = [{ requirement: MissionRequirement.WIN_GAMES, add: 1 }];
    expect(await service.advance('c1', win)).toHaveLength(0);
    expect(await service.advance('c1', win)).toHaveLength(0);
    expect(await service.advance('c1', win)).toHaveLength(1); // third win completes it
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(await service.advance('c1', win)).toHaveLength(0); // never paid twice
  });

  it('ignores changes that do not count', async () => {
    const { service } = objectivesSetup();
    expect(await service.advance('c1', [{ requirement: MissionRequirement.WIN_GAMES, add: 0 }])).toHaveLength(0);
  });
});

describe('Club invites', () => {
  function invitesSetup(opts: { role?: ClubRole; inClub?: boolean; pending?: boolean; full?: boolean } = {}) {
    const invites: any[] = [];
    const prisma: any = {
      clubMember: {
        findUnique: jest.fn(async () => ({ role: opts.role ?? ClubRole.LEADER, status: MemberStatus.ACTIVE })),
        findFirst: jest.fn(async () => (opts.inClub ? { id: 'm' } : null)),
      },
      club: { findUnique: jest.fn(async () => ({ name: 'Aces', memberCount: opts.full ? 30 : 5, maxMembers: 30 })) },
      user: {
        findFirst: jest.fn(async () => ({ id: 'p2' })),
        findUnique: jest.fn(async () => ({ username: 'leader' })),
      },
      block: { findFirst: jest.fn(async () => null) },
      clubInvite: {
        findFirst: jest.fn(async () => (opts.pending ? { id: 'old' } : null)),
        create: jest.fn(async ({ data }: any) => { const i = { id: `i${invites.length}`, status: ClubInviteStatus.PENDING, ...data }; invites.push(i); return i; }),
        findUnique: jest.fn(async ({ where }: any) => invites.find((i) => i.id === where.id) ?? null),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = invites.filter((i) => (!where.id || (typeof where.id === 'string' ? i.id === where.id : i.id !== where.id.not))
            && (!where.inviteeId || i.inviteeId === where.inviteeId) && (!where.status || i.status === where.status));
          hit.forEach((i) => Object.assign(i, data));
          return { count: hit.length };
        }),
      },
    };
    const notifications: any = { notifySafely: jest.fn(async () => undefined) };
    const clubs: any = { admitMember: jest.fn(async () => undefined) };
    return { service: new ClubInvitesService(prisma, notifications, clubs), invites, clubs, notifications };
  }

  it('an officer invites a player, who is notified and can accept', async () => {
    const { service, invites, clubs, notifications } = invitesSetup();
    const invite = await service.invite('leader', 'c1', 'p2');
    expect(notifications.notifySafely).toHaveBeenCalled();
    await expect(service.accept('p2', invite.id)).resolves.toMatchObject({ clubId: 'c1', joined: true });
    expect(clubs.admitMember).toHaveBeenCalledWith('c1', 'p2');
    expect(invites[0].status).toBe(ClubInviteStatus.ACCEPTED);
  });

  it('refuses members, players already in a club, full clubs, repeats and self', async () => {
    await expect(invitesSetup({ role: ClubRole.MEMBER }).service.invite('m', 'c1', 'p2')).rejects.toThrow(ForbiddenException);
    await expect(invitesSetup({ inClub: true }).service.invite('leader', 'c1', 'p2')).rejects.toThrow('PLAYER_ALREADY_IN_CLUB');
    await expect(invitesSetup({ full: true }).service.invite('leader', 'c1', 'p2')).rejects.toThrow('CLUB_FULL');
    await expect(invitesSetup({ pending: true }).service.invite('leader', 'c1', 'p2')).rejects.toThrow(ConflictException);
    await expect(invitesSetup().service.invite('leader', 'c1', 'leader')).rejects.toThrow(BadRequestException);
  });

  it('only the invited player can answer', async () => {
    const { service } = invitesSetup();
    const invite = await service.invite('leader', 'c1', 'p2');
    await expect(service.accept('someone-else', invite.id)).rejects.toThrow(ForbiddenException);
  });
});

describe('Achievements', () => {
  it('a completed achievement is paid once', async () => {
    const progress: any = { id: 'ap1', completedAt: new Date(), claimedAt: null, achievement: { rewardCoins: 500, rewardDiamonds: 0 } };
    const prisma: any = {
      achievementProgress: {
        findUnique: jest.fn(async () => progress),
        updateMany: jest.fn(async () => {
          if (progress.claimedAt) return { count: 0 };
          progress.claimedAt = new Date();
          return { count: 1 };
        }),
      },
    };
    const economy: any = { addCoins: jest.fn(async () => undefined), addDiamonds: jest.fn(), getBalance: jest.fn(async () => ({ coins: 500 })) };
    const service = new AchievementsService(prisma, economy, {} as any);
    await expect(service.claim('u1', 'a1')).resolves.toMatchObject({ reward: { coins: 500 } });
    await expect(service.claim('u1', 'a1')).rejects.toThrow('REWARD_ALREADY_CLAIMED');
    expect(economy.addCoins).toHaveBeenCalledTimes(1);
  });

  it('cannot claim before it is completed', async () => {
    const prisma: any = { achievementProgress: { findUnique: jest.fn(async () => ({ id: 'ap', completedAt: null, achievement: {} })) } };
    await expect(new AchievementsService(prisma, {} as any, {} as any).claim('u1', 'a1')).rejects.toThrow('ACHIEVEMENT_NOT_COMPLETED');
  });
});

describe('Level table', () => {
  it('lists the XP each level needs and the total to reach it', async () => {
    const prisma: any = { playerStats: { findUnique: jest.fn(async () => ({ level: 3, experience: 350 })) } };
    const stats = new StatsService(prisma, {} as any);
    const { levels, me } = await stats.levelTable(3, 'u1');
    expect(levels).toEqual([
      { level: 1, xpToReach: 0, xpForLevel: 100 },
      { level: 2, xpToReach: 100, xpForLevel: 200 },
      { level: 3, xpToReach: 300, xpForLevel: 300 },
    ]);
    expect(me).toEqual({ level: 3, experience: 350 });
    // The table agrees with how a level is worked out from XP.
    expect(stats.calculateLevel(300)).toBe(3);
    expect(stats.calculateLevel(299)).toBe(2);
  });
});
