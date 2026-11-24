import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminContentService } from './admin-content.service';

// Content: achievements and weekly clan objectives (create / edit with audit / delete only
// when untouched), and the level table.
function setup() {
  const achievements: any[] = [
    { id: 'a1', title: 'Win 10', description: 'Win 10 games', requirement: 'WIN_GAMES', targetValue: 10, mode: null, rewardCoins: 1000, rewardDiamonds: 0, sortOrder: 0, isActive: true },
  ];
  const objectives: any[] = [
    { id: 'o1', title: 'Play 50', description: 'Play 50 games', requirement: 'PLAY_GAMES', targetValue: 50, mode: null, rewardCoins: 500, rewardClubPoints: 100, sortOrder: 0, isActive: true },
  ];
  const audit: any[] = [];
  let achievementProgress = 0;
  let objectiveProgress = 0;
  const prisma: any = {
    achievement: {
      create: jest.fn(async ({ data }: any) => { const r = { id: 'a2', ...data }; achievements.push(r); return r; }),
      findUnique: jest.fn(async ({ where }: any) => achievements.find((a) => a.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(achievements.find((a) => a.id === where.id), data)),
      delete: jest.fn(async ({ where }: any) => achievements.splice(achievements.findIndex((a) => a.id === where.id), 1)),
    },
    achievementProgress: { count: jest.fn(async () => achievementProgress) },
    clubObjective: {
      create: jest.fn(async ({ data }: any) => ({ id: 'o2', ...data })),
      findUnique: jest.fn(async ({ where }: any) => objectives.find((o) => o.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(objectives.find((o) => o.id === where.id), data)),
      delete: jest.fn(async () => undefined),
    },
    clubObjectiveProgress: { count: jest.fn(async () => objectiveProgress) },
    playerStats: { groupBy: jest.fn(async () => [{ level: 1, _count: { _all: 7 } }, { level: 3, _count: { _all: 2 } }, { level: 80, _count: { _all: 1 } }]) },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
  };
  return {
    service: new AdminContentService(prisma), achievements, audit,
    setProgress: (a: number, o: number) => { achievementProgress = a; objectiveProgress = o; },
  };
}

describe('AdminContentService', () => {
  it('creates an achievement with trimmed text and logs it', async () => {
    const { service, audit } = setup();
    const row = await service.createAchievement('a', { title: '  Play 5  ', description: 'Play five games', requirement: 'PLAY_GAMES' as any, targetValue: 5, rewardCoins: 100 });
    expect(row.title).toBe('Play 5');
    expect(audit[0]).toMatchObject({ action: 'CREATE_ACHIEVEMENT', details: { title: 'Play 5' } });
  });

  it('edits an achievement and logs before / after; no change logs nothing', async () => {
    const { service, achievements, audit } = setup();
    await service.updateAchievement('a', 'a1', { targetValue: 20, mode: 'CLASSIC' as any });
    expect(achievements[0]).toMatchObject({ targetValue: 20, mode: 'CLASSIC' });
    expect(audit[0].details.changes).toEqual({ targetValue: [10, 20], mode: [null, 'CLASSIC'] });
    await service.updateAchievement('a', 'a1', { targetValue: 20 });
    expect(audit).toHaveLength(1);
    await expect(service.updateAchievement('a', 'nope', { targetValue: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('can switch an achievement off without touching anything else', async () => {
    const { service, achievements } = setup();
    await service.updateAchievement('a', 'a1', { isActive: false });
    expect(achievements[0]).toMatchObject({ isActive: false, targetValue: 10 });
  });

  it('only an untouched achievement or objective can be deleted', async () => {
    const { service, achievements, audit, setProgress } = setup();
    setProgress(3, 2);
    await expect(service.deleteAchievement('a', 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteObjective('a', 'o1')).rejects.toBeInstanceOf(BadRequestException);
    setProgress(0, 0);
    expect(await service.deleteAchievement('a', 'a1')).toEqual({ deleted: true });
    expect(achievements).toHaveLength(0);
    expect(await service.deleteObjective('a', 'o1')).toEqual({ deleted: true });
    expect(audit.map((x) => x.action)).toEqual(['DELETE_ACHIEVEMENT', 'DELETE_CLUB_OBJECTIVE']);
  });

  it('edits a clan objective reward', async () => {
    const { service, audit } = setup();
    await service.updateObjective('a', 'o1', { rewardClubPoints: 250 });
    expect(audit[0]).toMatchObject({ action: 'UPDATE_CLUB_OBJECTIVE', details: { changes: { rewardClubPoints: [100, 250] } } });
  });

  it('level table follows the game formula and counts players per level', async () => {
    const { service } = setup();
    const res = await service.levels(40);
    expect(res.levels[0]).toEqual({ level: 1, xpForLevel: 100, xpToReach: 0, players: 7 });
    expect(res.levels[1].xpToReach).toBe(100);
    expect(res.levels[9].xpForLevel).toBe(1000);   // level 10: 100 x 10
    expect(res.levels[10].xpForLevel).toBe(2200);  // level 11: 200 x 11
    expect(res.levels[30].xpForLevel).toBe(31 * 350);
    expect(res.levels[2].players).toBe(2);
    expect(res.playersAbove).toBe(1);              // the level-80 player
    expect(res.clubPointsPerLevel).toBe(1000);
  });
});
