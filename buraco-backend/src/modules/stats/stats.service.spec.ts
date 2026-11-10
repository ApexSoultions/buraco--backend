import { StatsService } from './stats.service';

// The profile screen's level ring reads levelProgress. experience is total XP since the
// start, so the XP needed for the current level must be measured from where that level began.
describe('StatsService level progress', () => {
  const service = new StatsService({} as any, {} as any);

  it('level 1: progress is the XP so far out of 100', () => {
    expect(service.levelProgress(1, 40)).toEqual({ level: 1, nextLevel: 2, xpIntoLevel: 40, xpForLevel: 100, percent: 40 });
  });

  it('later levels count from the start of the level, never negative', () => {
    // Levels 1–4 need 100+200+300+400 = 1000 XP; level 5 needs 500 more.
    expect(service.levelProgress(5, 1100)).toEqual({ level: 5, nextLevel: 6, xpIntoLevel: 100, xpForLevel: 500, percent: 20 });
    expect(service.calculateLevel(1100)).toBe(5);
  });

  it('getStats returns the progress and a correct XP-to-next-level', async () => {
    const prisma = { playerStats: { findUnique: jest.fn(async () => ({ level: 5, experience: 1100 })) } };
    const s = new StatsService(prisma as any, {} as any);
    const res: any = await s.getStats('u1');
    expect(res.experienceToNextLevel).toBe(400);
    expect(res.levelProgress.percent).toBe(20);
  });

  it('clamps odd data instead of showing more than 100%', () => {
    expect(service.levelProgress(1, 5000).percent).toBe(100);
    expect(service.levelProgress(3, 0).xpIntoLevel).toBe(0);
  });
});
