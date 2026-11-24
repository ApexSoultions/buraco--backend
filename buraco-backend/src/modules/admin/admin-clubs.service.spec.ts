import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminClubsService } from './admin-clubs.service';

// Clan moderation: removing members (seat count, chat, notification), leadership hand-over,
// name reset, and deleting a clan with its chat and reported messages.
function setup() {
  const club: any = { id: 'c1', name: 'Bad Name', iconUrl: 'x.png', memberCount: 3 };
  const members: any[] = [
    { id: 'm1', clubId: 'c1', userId: 'lead', role: 'LEADER', status: 'ACTIVE', user: { username: 'Lead' } },
    { id: 'm2', clubId: 'c1', userId: 'vic', role: 'VICE_LEADER', status: 'ACTIVE', user: { username: 'Vic' } },
    { id: 'm3', clubId: 'c1', userId: 'mem', role: 'MEMBER', status: 'ACTIVE', user: { username: 'Mem' } },
    { id: 'm4', clubId: 'c1', userId: 'req', role: 'MEMBER', status: 'PENDING', user: { username: 'Req' } },
  ];
  const audit: any[] = [];
  const notified: any[] = [];
  const reports: any[] = [{ id: 'r1', conversationId: 'cv1', messageId: 'msg1', source: null, details: null, message: { content: 'you suck' } }];
  const chat: any = { members: ['lead', 'vic', 'mem'], messages: 2, deleted: false };
  const find = (where: any) => members.find((m) => m.clubId === where.clubId_userId.clubId && m.userId === where.clubId_userId.userId) ?? null;
  const tx: any = {
    clubMember: { delete: jest.fn(async ({ where }: any) => members.splice(members.indexOf(find(where)), 1)) },
    club: { update: jest.fn(async ({ data }: any) => { if (data.memberCount?.decrement) club.memberCount -= 1; }), delete: jest.fn(async () => { club.deleted = true; }) },
    conversation: { findUnique: jest.fn(async () => ({ id: 'cv1' })), delete: jest.fn(async () => { chat.deleted = true; }) },
    conversationMember: { deleteMany: jest.fn(async ({ where }: any) => { chat.members = where.userId ? chat.members.filter((u: string) => u !== where.userId) : []; }) },
    message: { deleteMany: jest.fn(async () => { chat.messages = 0; }) },
    report: {
      findMany: jest.fn(async () => reports),
      update: jest.fn(async ({ where, data }: any) => Object.assign(reports.find((r) => r.id === where.id), data)),
    },
    clubMember2: null,
  };
  const prisma: any = {
    ...tx,
    club: { ...tx.club, findUnique: jest.fn(async ({ where }: any) => (where.id === 'c1' ? club : null)) },
    clubMember: {
      ...tx.clubMember,
      findUnique: jest.fn(async ({ where }: any) => (find(where) ? { ...find(where), club: { name: club.name } } : null)),
      findFirst: jest.fn(async ({ where }: any) => members.find((m) => m.role === where.role && m.status === where.status) ?? null),
      findMany: jest.fn(async () => members.filter((m) => m.status === 'ACTIVE')),
      update: jest.fn(async ({ where, data }: any) => Object.assign(members.find((m) => m.id === where.id), data)),
    },
    clubActivity: { create: jest.fn(async () => ({})) },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const notifications: any = { notifySafely: jest.fn(async (to: any, _t: any, title: string, body: string) => { notified.push({ to, title, body }); }) };
  return { service: new AdminClubsService(prisma, notifications), club, members, audit, notified, chat, reports };
}

describe('AdminClubsService', () => {
  it('removes an active member: seat, chat, notification with the reason, audit', async () => {
    const { service, club, members, chat, notified, audit } = setup();
    await service.removeMember('adm', 'c1', 'mem', ' spamming ');
    expect(members.find((m) => m.userId === 'mem')).toBeUndefined();
    expect(club.memberCount).toBe(2);
    expect(chat.members).toEqual(['lead', 'vic']);
    expect(notified[0]).toMatchObject({ to: 'mem' });
    expect(notified[0].body).toContain('spamming');
    expect(audit[0]).toMatchObject({ action: 'CLUB_REMOVE_MEMBER', details: { wasActive: true, reason: 'spamming' } });
  });

  it('declining a pending request does not change the seat count', async () => {
    const { service, club, notified } = setup();
    await service.removeMember('adm', 'c1', 'req');
    expect(club.memberCount).toBe(3);
    expect(notified[0].body).toContain('declined');
  });

  it('the leader cannot be removed; unknown member is not found', async () => {
    const { service } = setup();
    await expect(service.removeMember('adm', 'c1', 'lead')).rejects.toThrow('IS_LEADER');
    await expect(service.removeMember('adm', 'c1', 'nobody')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hands the leadership over: old leader becomes vice leader, only one leader', async () => {
    const { service, members, audit } = setup();
    await service.makeLeader('adm', 'c1', 'mem');
    expect(members.filter((m) => m.role === 'LEADER').map((m) => m.userId)).toEqual(['mem']);
    expect(members.find((m) => m.userId === 'lead').role).toBe('VICE_LEADER');
    expect(audit[0]).toMatchObject({ action: 'CLUB_MAKE_LEADER', details: { newLeader: 'Mem' } });
  });

  it('cannot make a pending request or the current leader the leader', async () => {
    const { service } = setup();
    await expect(service.makeLeader('adm', 'c1', 'req')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.makeLeader('adm', 'c1', 'lead')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resets an offensive name to Clan + 6 digits and tells the members', async () => {
    const { service, notified, audit } = setup();
    const { name } = await service.resetName('adm', 'c1', 'offensive');
    expect(name).toMatch(/^Clan\d{6}$/);
    expect(notified[0].body).toContain(name);
    expect(audit[0]).toMatchObject({ action: 'CLUB_RESET_NAME', details: { from: 'Bad Name', to: name } });
  });

  it('deletes a clan with its chat, keeps reports with the message text, tells active members', async () => {
    const { service, chat, reports, notified, audit } = setup();
    expect(await service.remove('adm', 'c1', 'against the rules')).toEqual({ deleted: true });
    expect(chat).toMatchObject({ deleted: true, messages: 0, members: [] });
    expect(reports[0]).toMatchObject({ messageId: null, conversationId: null });
    expect(reports[0].details).toContain('you suck');
    expect(notified[0].to).toEqual(['lead', 'vic', 'mem']);
    expect(audit[0]).toMatchObject({ action: 'DELETE_CLUB', details: { name: 'Bad Name', members: 3 } });
    await expect(service.remove('adm', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removing the icon is a no-op when there is none', async () => {
    const { service, club } = setup();
    expect(await service.removeIcon('adm', 'c1')).toEqual({ removed: true });
    club.iconUrl = null;
    expect(await service.removeIcon('adm', 'c1')).toEqual({ removed: false });
  });
});
