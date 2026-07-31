import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GameStatus, RoomStatus } from '@prisma/client';
import { GameEngineService } from './game-engine.service';

const GAME_ID = '5e18a94d-cade-432b-bf3c-ee678e63e21f';
const P1 = '4185aa3b-e1fe-4bfb-a41e-d86db649b1ba';
const P2 = 'a703ba66-d6cc-4536-b4e0-f2d117ab3f41';
const OUTSIDER = '00000000-0000-0000-0000-000000000000';

/** The exact body the Unity client posts (JsonUtility output). */
function reportBody(): Record<string, unknown> {
  return {
    gameId: GAME_ID,
    winnerTeam: 2,
    winnerIds: [P2],
    reason: 'finished',
    players: [
      {
        playerId: P1, playerName: 'player one', result: 'LOSS',
        boardScore: 60, cleanBuraco: 0, semiCleanBuraco: 0, dirtyBuraco: 0,
        potNotTaken: -100, paidCards: -55, finishBonus: 0,
        matchScore: -95, roundScore: -95,
      },
      {
        playerId: P2, playerName: 'player two', result: 'WIN',
        boardScore: 145, cleanBuraco: 200, semiCleanBuraco: 0, dirtyBuraco: 100,
        potNotTaken: 0, paidCards: -35, finishBonus: 100,
        matchScore: 510, roundScore: 510,
      },
    ],
  };
}

function buildService(overrides: { existingReport?: boolean; gameStatus?: GameStatus } = {}) {
  const created: any[] = [];
  let reportExists = !!overrides.existingReport;

  const prisma: any = {
    gameSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: GAME_ID,
        mode: 'CLASSIC',
        variant: 'ONE_VS_ONE',
        status: overrides.gameStatus ?? GameStatus.IN_PROGRESS,
        startedAt: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 60_000),
        roomId: 'room-1',
        players: [
          { userId: P1, teamId: 1 },
          { userId: P2, teamId: 2 },
        ],
        matchRecord: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    matchResultReport: {
      create: jest.fn().mockImplementation((args: any) => {
        if (reportExists) return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
        reportExists = true;
        created.push(args.data);
        return Promise.resolve(args.data);
      }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    matchRecord: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    room: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
  };

  const redis: any = {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(undefined),
    // setNx returns 'OK' (lock acquired) by default so settlement proceeds; a test that
    // wants the "already settled" branch overrides it with null.
    setNx: jest.fn().mockResolvedValue('OK'),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
  };
  const economy: any = { distributeMatchReward: jest.fn().mockResolvedValue(undefined) };
  const stats: any = { updateAfterMatch: jest.fn().mockResolvedValue(undefined) };
  const socket: any = { emitToRoom: jest.fn(), emitPerPlayer: jest.fn() };

  const service = new GameEngineService(prisma, redis, economy, stats, socket);
  return { service, prisma, redis, economy, stats, created };
}

describe('GameEngineService.reportMatchResult', () => {
  it('persists the first report and settles economy, stats and the room', async () => {
    const { service, prisma, economy, stats, created } = buildService();

    await expect(service.reportMatchResult(GAME_ID, P1, reportBody())).resolves.toEqual({ ok: true });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ gameId: GAME_ID, reportedBy: P1, winnerTeam: 2, reason: 'finished' });
    // winnerIds come from the server's own team mapping, not the client's list.
    expect(created[0].winnerIds).toEqual([P2]);
    // The body is stored verbatim so GET /result can return it unchanged.
    expect(created[0].payload.players).toHaveLength(2);

    expect(prisma.gameSession.update).toHaveBeenCalledTimes(1);
    expect(prisma.matchRecord.create).toHaveBeenCalledTimes(1);
    expect(economy.distributeMatchReward).toHaveBeenCalledTimes(2);
    expect(stats.updateAfterMatch).toHaveBeenCalledWith(P2, 'WIN', expect.any(Number), expect.any(Number));
    expect(stats.updateAfterMatch).toHaveBeenCalledWith(P1, 'LOSS', expect.any(Number), expect.any(Number));

    // Room released back to the lobby.
    expect(prisma.room.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: RoomStatus.EMPTY, gameId: null }) }),
    );
  });

  it('accepts a report from the non-original host (host migration)', async () => {
    const { service, created } = buildService();
    await expect(service.reportMatchResult(GAME_ID, P2, reportBody())).resolves.toEqual({ ok: true });
    expect(created[0].reportedBy).toBe(P2);
  });

  it('treats a duplicate report as success without re-settling', async () => {
    const { service, prisma, economy, created } = buildService({ existingReport: true });

    await expect(service.reportMatchResult(GAME_ID, P1, reportBody())).resolves.toEqual({ ok: true });

    expect(created).toHaveLength(0);
    expect(prisma.gameSession.update).not.toHaveBeenCalled();
    expect(prisma.matchRecord.create).not.toHaveBeenCalled();
    expect(economy.distributeMatchReward).not.toHaveBeenCalled();
  });

  it('stores a late report but leaves an already-settled match untouched', async () => {
    const { service, prisma, economy, created } = buildService({ gameStatus: GameStatus.ABANDONED });

    await expect(service.reportMatchResult(GAME_ID, P1, reportBody())).resolves.toEqual({ ok: true });

    expect(created).toHaveLength(1);
    expect(prisma.matchRecord.create).not.toHaveBeenCalled();
    expect(economy.distributeMatchReward).not.toHaveBeenCalled();
  });

  it('rejects a caller who is not a participant', async () => {
    const { service } = buildService();
    await expect(service.reportMatchResult(GAME_ID, OUTSIDER, reportBody())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s an unknown gameId', async () => {
    const { service, prisma } = buildService();
    prisma.gameSession.findUnique.mockResolvedValue(null);
    await expect(service.reportMatchResult(GAME_ID, P1, reportBody())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400s a body with no players', async () => {
    const { service } = buildService();
    await expect(service.reportMatchResult(GAME_ID, P1, { winnerTeam: 1, players: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('strips unknown fields instead of rejecting them', async () => {
    const { service, created } = buildService();
    const body = { ...reportBody(), someFutureField: 'x' };

    await expect(service.reportMatchResult(GAME_ID, P1, body)).resolves.toEqual({ ok: true });
    expect(created[0].payload.someFutureField).toBeUndefined();
  });

  it('normalises an unrecognised reason to "finished"', async () => {
    const { service, created } = buildService();
    await expect(
      service.reportMatchResult(GAME_ID, P1, { ...reportBody(), reason: 'something_new' }),
    ).resolves.toEqual({ ok: true });
    expect(created[0].reason).toBe('finished');
  });

  it('keeps a known non-default reason', async () => {
    const { service, created } = buildService();
    await expect(service.reportMatchResult(GAME_ID, P1, { ...reportBody(), reason: 'inactive' })).resolves.toEqual({
      ok: true,
    });
    expect(created[0].reason).toBe('inactive');
  });

  it('marks a leftover Redis state COMPLETED so the auto-play cron stops', async () => {
    const { service, redis } = buildService();
    redis.getJson.mockResolvedValue({
      gameId: GAME_ID,
      status: GameStatus.IN_PROGRESS,
      players: [{ userId: P1, teamId: 1 }, { userId: P2, teamId: 2 }],
      usernames: {},
      matchScores: { 1: 0, 2: 0 },
    });

    await service.reportMatchResult(GAME_ID, P1, reportBody());

    const saved = redis.setJson.mock.calls.at(-1)?.[1];
    expect(saved.status).toBe(GameStatus.COMPLETED);
    expect(saved.winnerTeam).toBe(2);
    expect(saved.matchScores).toEqual({ 1: -95, 2: 510 });
    expect(saved.lastRoundScores).toHaveLength(2);
  });
});

describe('GameEngineService.getGameResult', () => {
  it('returns the reported payload verbatim once a report exists', async () => {
    const { service, prisma } = buildService();
    const payload = reportBody();
    prisma.matchResultReport.findUnique.mockResolvedValue({ payload });

    await expect(service.getGameResult(GAME_ID)).resolves.toBe(payload);
  });

  it('404s while the match is still live', async () => {
    const { service, prisma } = buildService();
    prisma.matchResultReport.findUnique.mockResolvedValue(null);
    prisma.matchRecord.findUnique.mockResolvedValue(null);

    await expect(service.getGameResult(GAME_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
