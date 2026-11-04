import { BadRequestException } from '@nestjs/common';
import { GameMode, MissionRequirement, MissionType, NotificationType } from '@prisma/client';
import { MissionsService, pickRandom } from './missions.service';

// updateProgress existed but nothing called it, so missions never moved. Matches, chat
// messages and club joins now advance them; completing one sends a REWARD notification;
// a reward can only be claimed once even if two claims race.
const USER = 'a1111111-1111-4111-8111-111111111111';

type Row = { id: string; currentValue: number; isCompleted: boolean; isClaimed: boolean; mission: any };

function mission(id: string, requirement: MissionRequirement, targetValue: number, type: MissionType = MissionType.DAILY) {
  return { id, title: `Mission ${id}`, type, requirement, targetValue, rewardCoins: 100, rewardDiamonds: 0, isActive: true };
}

function setup(rows: Row[], opts: { claimCount?: number } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const prisma = {
    missionProgress: {
      // ensureMissionsAssigned: report enough rows that nothing new is assigned.
      count: jest.fn(async () => 3),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => !r.isCompleted && !r.isClaimed && where.mission.requirement.in.includes(r.mission.requirement))),
      update: jest.fn(async ({ where, data }: any) => {
        const r = byId.get(where.id)!;
        r.currentValue += data.currentValue.increment;
        return { ...r };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.userId) return { count: opts.claimCount ?? 1 }; // claimReward
        const r = byId.get(where.id)!;
        if (where.isCompleted === false && r.isCompleted) return { count: 0 };
        if (where.currentValue?.lt !== undefined && !(r.currentValue < where.currentValue.lt)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => ({ isCompleted: true, isClaimed: false, mission: mission('m1', MissionRequirement.PLAY_GAMES, 1) })),
    },
  };
  const economy = { addCoins: jest.fn(), addDiamonds: jest.fn(), getBalance: jest.fn(async () => ({ coins: 100 })) };
  const notifications = { notifySafely: jest.fn(async () => undefined) };
  const service = new MissionsService(prisma as any, economy as any, notifications as any);
  return { service, prisma, economy, notifications, rows };
}

const row = (id: string, m: any, currentValue = 0): Row => ({ id, currentValue, isCompleted: false, isClaimed: false, mission: m });

describe('MissionsService.recordMatch', () => {
  it('counts a won Classic match towards play, win, points and Classic missions', async () => {
    const { service, rows } = setup([
      row('play', mission('m-play', MissionRequirement.PLAY_GAMES, 3)),
      row('win', mission('m-win', MissionRequirement.WIN_GAMES, 10)),
      row('pts', mission('m-pts', MissionRequirement.EARN_POINTS, 500)),
      row('classic', mission('m-classic', MissionRequirement.PLAY_CLASSIC, 5)),
      row('pro', mission('m-pro', MissionRequirement.PLAY_PROFESSIONAL, 5)),
    ]);

    await service.recordMatch(USER, { mode: GameMode.CLASSIC, isWinner: true, pointsEarned: 120, winStreak: 1 });

    const value = (id: string) => rows.find((r) => r.id === id)!.currentValue;
    expect(value('play')).toBe(1);
    expect(value('win')).toBe(1);
    expect(value('pts')).toBe(120);
    expect(value('classic')).toBe(1);
    expect(value('pro')).toBe(0);
  });

  it('does not count a win for a loss', async () => {
    const { service, rows } = setup([row('win', mission('m-win', MissionRequirement.WIN_GAMES, 1))]);
    await service.recordMatch(USER, { mode: GameMode.PROFESSIONAL, isWinner: false, pointsEarned: 10, winStreak: 0 });
    expect(rows[0].currentValue).toBe(0);
  });

  it('completes a mission at its target, caps the value and notifies once', async () => {
    const { service, rows, notifications } = setup([row('play', mission('m-play', MissionRequirement.PLAY_GAMES, 3), 2)]);

    const done = await service.recordMatch(USER, { mode: GameMode.CLASSIC, isWinner: false, pointsEarned: 0, winStreak: 0 });

    expect(done.map((m) => m.id)).toEqual(['m-play']);
    expect(rows[0]).toEqual(expect.objectContaining({ isCompleted: true, currentValue: 3 }));
    expect(notifications.notifySafely).toHaveBeenCalledTimes(1);
    expect(notifications.notifySafely).toHaveBeenCalledWith(USER, NotificationType.REWARD, 'Mission complete',
      'Mission m-play — claim your reward', expect.objectContaining({ event: 'MISSION_COMPLETED', missionId: 'm-play' }));
  });

  it('tracks a win streak as the best streak reached, not a running total', async () => {
    const { service, rows } = setup([row('streak', mission('m-streak', MissionRequirement.WIN_STREAK, 3, MissionType.WEEKLY), 1)]);

    await service.recordMatch(USER, { mode: GameMode.CLASSIC, isWinner: true, pointsEarned: 50, winStreak: 2 });
    expect(rows[0].currentValue).toBe(2);

    // A loss resets the live streak to 0 but must not lower the mission's progress.
    await service.recordMatch(USER, { mode: GameMode.CLASSIC, isWinner: false, pointsEarned: 0, winStreak: 0 });
    expect(rows[0].currentValue).toBe(2);

    await service.recordMatch(USER, { mode: GameMode.CLASSIC, isWinner: true, pointsEarned: 50, winStreak: 3 });
    expect(rows[0]).toEqual(expect.objectContaining({ isCompleted: true, currentValue: 3 }));
  });
});

describe('pickRandom (mission assignment)', () => {
  it('returns distinct items from the pool, at most count', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    const picked = pickRandom(pool, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    picked.forEach((p) => expect(pool).toContain(p));
    expect(pickRandom(pool, 10)).toHaveLength(5);
    expect(pickRandom([], 3)).toEqual([]);
  });

  it('can hand out every mission in the pool, not just the oldest ones', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) pickRandom(pool, 3).forEach((p) => seen.add(p));
    expect(seen.size).toBe(5);
  });
});

describe('MissionsService safety', () => {
  it('recordMatchSafely swallows errors so a settled match is never undone', async () => {
    const { service, prisma } = setup([]);
    prisma.missionProgress.count.mockRejectedValueOnce(new Error('db down'));
    await expect(service.recordMatchSafely(USER, { mode: GameMode.CLASSIC, isWinner: true, pointsEarned: 1, winStreak: 1 })).resolves.toBeUndefined();
  });

  it('pays a reward once even when two claims race', async () => {
    const { service, economy } = setup([], { claimCount: 0 });
    await expect(service.claimReward(USER, 'm1')).rejects.toBeInstanceOf(BadRequestException);
    expect(economy.addCoins).not.toHaveBeenCalled();
  });

  it('pays the reward when the claim wins', async () => {
    const { service, economy } = setup([], { claimCount: 1 });
    const res = await service.claimReward(USER, 'm1');
    expect(res.reward.coins).toBe(100);
    expect(economy.addCoins).toHaveBeenCalledTimes(1);
  });
});
