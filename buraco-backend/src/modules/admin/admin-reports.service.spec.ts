import { BadRequestException } from '@nestjs/common';
import { ReportStatus } from '@prisma/client';
import { AdminReportsService, sourceOf } from './admin-reports.service';
import { GlobalChatService } from '../tables/global-chat.service';

// Moderation: where a report came from, closing / reopening it, banning from a report,
// and removing Global Chat messages.
function setup() {
  const reports: any[] = [
    { id: 'r1', reporterId: 'a', reportedUserId: 'bad', status: ReportStatus.OPEN, reason: 'ABUSE', source: null, conversationId: null, details: 'Table chat, match g1:\nyou are trash', createdAt: new Date(), reviewedAt: null, reviewedBy: null, resolution: null },
    { id: 'r2', reporterId: 'c', reportedUserId: 'bad', status: ReportStatus.OPEN, reason: 'SPAM', source: 'GLOBAL_CHAT', conversationId: null, details: 'Global chat:\nbuy coins here', createdAt: new Date(), reviewedAt: null, reviewedBy: null, resolution: null },
    { id: 'r3', reporterId: 'a', reportedUserId: 'other', status: ReportStatus.OPEN, reason: 'OTHER', source: null, conversationId: 'cv1', details: null, createdAt: new Date(), reviewedAt: null, reviewedBy: null, resolution: null },
  ];
  const audit: any[] = [];
  const prisma: any = {
    report: {
      findUnique: jest.fn(async ({ where }: any) => reports.find((r) => r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(reports.find((r) => r.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = reports.filter((r) => r.reportedUserId === where.reportedUserId && r.status === where.status);
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const bans: any[] = [];
  const players: any = { setBan: jest.fn(async (adminId: string, userId: string, dto: any) => { bans.push({ adminId, userId, ...dto }); }) };
  return { service: new AdminReportsService(prisma, players), reports, audit, bans };
}

describe('AdminReportsService', () => {
  it('works out where an old report came from', () => {
    expect(sourceOf({ source: null, conversationId: 'cv', details: null })).toBe('MESSAGES');
    expect(sourceOf({ source: null, conversationId: null, details: 'Table chat, match x:\nhi' })).toBe('TABLE_CHAT');
    expect(sourceOf({ source: null, conversationId: null, details: 'Global chat:\nhi' })).toBe('GLOBAL_CHAT');
    expect(sourceOf({ source: 'GLOBAL_CHAT', conversationId: null, details: null })).toBe('GLOBAL_CHAT');
    expect(sourceOf({ source: null, conversationId: null, details: 'something' })).toBe('OTHER');
  });

  it('closes a report with who, when and a note; reopening clears them', async () => {
    const { service, reports, audit } = setup();
    await service.setStatus('mod1', 'r3', ReportStatus.DISMISSED, '  friendly banter ');
    expect(reports[2]).toMatchObject({ status: ReportStatus.DISMISSED, reviewedBy: 'mod1', resolution: 'friendly banter' });
    expect(reports[2].reviewedAt).toBeInstanceOf(Date);
    await service.setStatus('mod1', 'r3', ReportStatus.OPEN);
    expect(reports[2]).toMatchObject({ status: ReportStatus.OPEN, reviewedBy: null, reviewedAt: null, resolution: null });
    expect(audit.map((a) => a.action)).toEqual(['REPORT_DISMISSED', 'REPORT_OPEN']);
  });

  it('banning from a report bans the player and closes all their open reports', async () => {
    const { service, reports, bans } = setup();
    const res = await service.banFromReport('mod1', 'r1', 'abusive chat');
    expect(bans).toEqual([{ adminId: 'mod1', userId: 'bad', isBanned: true, reason: 'abusive chat' }]);
    expect(res.reportsClosed).toBe(2);
    expect(reports.filter((r) => r.reportedUserId === 'bad').every((r) => r.status === ReportStatus.REVIEWED)).toBe(true);
    expect(reports[2].status).toBe(ReportStatus.OPEN); // another player's report untouched
  });

  it('needs a reason to ban', async () => {
    const { service } = setup();
    await expect(service.banFromReport('mod1', 'r1', '  ')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GlobalChatService moderation', () => {
  function chat() {
    let stored: any[] | null = [
      { id: 'm1', senderId: 'bad', text: 'spam' },
      { id: 'm2', senderId: 'ok', text: 'hello' },
      { id: 'm3', senderId: 'bad', text: 'more spam' },
    ];
    const events: any[] = [];
    const redis: any = {
      getJson: jest.fn(async () => stored),
      setJson: jest.fn(async (_k: string, v: any[]) => { stored = v; }),
      del: jest.fn(async () => { stored = null; }),
    };
    const socket: any = { emitToRoom: jest.fn((_room: string, event: string, data: any) => events.push({ event, data })) };
    return { service: new GlobalChatService({} as any, redis, socket), get: () => stored, events };
  }

  it('removes one message, or every message of one player', async () => {
    const c = chat();
    expect(await c.service.adminRemove({ messageId: 'm2' })).toEqual({ removed: 1 });
    expect(await c.service.adminRemove({ userId: 'bad' })).toEqual({ removed: 2 });
    expect(c.get()).toEqual([]);
    expect(c.events[1]).toEqual({ event: 'lobby:chat:removed', data: { ids: ['m1', 'm3'] } });
    await expect(c.service.adminRemove({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the whole chat for everyone', async () => {
    const c = chat();
    expect(await c.service.adminClearAll()).toEqual({ removed: 3 });
    expect(c.get()).toBeNull();
    expect(c.events).toEqual([{ event: 'lobby:chat:cleared', data: {} }]);
  });
});
