import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupportService, MAX_TICKETS_PER_DAY } from './support.service';
import { AdminSupportService } from '../admin/admin-support.service';

// "Contact Game Support": the player's side (send, daily limit, read answers) and the staff
// side (reply with notification + email, close / reopen, audit).
function setup(opts: { sentToday?: number } = {}) {
  const tickets: any[] = [];
  const replies: any[] = [];
  const audit: any[] = [];
  const prisma: any = {
    supportTicket: {
      count: jest.fn(async () => opts.sentToday ?? 0),
      create: jest.fn(async ({ data }: any) => { const t = { id: `t${tickets.length + 1}`, status: 'OPEN', createdAt: new Date(), ...data }; tickets.push(t); return t; }),
      findMany: jest.fn(async () => tickets.map((t) => ({ ...t, replies: replies.filter((r) => r.ticketId === t.id) }))),
      findUnique: jest.fn(async ({ where }: any) => {
        const t = tickets.find((x) => x.id === where.id);
        return t ? { ...t, user: { id: t.userId, username: 'ali' }, replies: replies.filter((r) => r.ticketId === t.id) } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(tickets.find((t) => t.id === where.id), data)),
    },
    supportReply: { create: jest.fn(async ({ data }: any) => { replies.push({ id: `r${replies.length + 1}`, createdAt: new Date(), ...data }); }) },
    adminUser: { findUnique: jest.fn(async () => ({ name: 'Sara (Support)' })) },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const notifications: any = { notifySafely: jest.fn(async () => undefined) };
  const mail: any = { sendSupportReply: jest.fn(async () => undefined) };
  return { player: new SupportService(prisma), staff: new AdminSupportService(prisma, notifications, mail), tickets, replies, audit, notifications, mail };
}

const FORM = { name: ' Ali ', email: ' Ali@Example.COM ', message: '  I was charged but got no coins.  ', social: ' @ali ' };

describe('SupportService (player)', () => {
  it('saves a trimmed message with the email in lower case', async () => {
    const { player, tickets } = setup();
    const res = await player.create('u1', FORM);
    expect(res).toMatchObject({ id: 't1', status: 'OPEN' });
    expect(tickets[0]).toMatchObject({ userId: 'u1', name: 'Ali', email: 'ali@example.com', social: '@ali', message: 'I was charged but got no coins.' });
  });

  it('an empty social becomes null', async () => {
    const { player, tickets } = setup();
    await player.create('u1', { ...FORM, social: '   ' });
    expect(tickets[0].social).toBeNull();
  });

  it(`refuses a ${MAX_TICKETS_PER_DAY + 1}th message in a day`, async () => {
    const { player, tickets } = setup({ sentToday: MAX_TICKETS_PER_DAY });
    await expect(player.create('u1', FORM)).rejects.toThrow('TOO_MANY_TICKETS');
    expect(tickets).toHaveLength(0);
  });

  it('shows the player their messages with the answers', async () => {
    const { player, staff } = setup();
    await player.create('u1', FORM);
    await staff.reply('a1', 't1', 'We fixed it.');
    const mine = await player.mine('u1');
    expect(mine[0]).toMatchObject({ id: 't1', status: 'ANSWERED' });
    expect(mine[0].replies[0]).toMatchObject({ message: 'We fixed it.', adminName: 'Sara (Support)' });
  });
});

describe('AdminSupportService (staff)', () => {
  it('replying answers the ticket, tells the player in the game, emails them and logs it', async () => {
    const { player, staff, tickets, replies, notifications, mail, audit } = setup();
    await player.create('u1', FORM);
    await staff.reply('a1', 't1', '  We added the coins.  ');
    expect(replies[0]).toMatchObject({ ticketId: 't1', adminId: 'a1', adminName: 'Sara (Support)', message: 'We added the coins.' });
    expect(tickets[0].status).toBe('ANSWERED');
    expect(notifications.notifySafely).toHaveBeenCalledWith('u1', 'SYSTEM', 'Game Support answered you', 'We added the coins.', { event: 'SUPPORT_REPLY', ticketId: 't1' });
    expect(mail.sendSupportReply).toHaveBeenCalledWith('ali@example.com', 'Ali', 'I was charged but got no coins.', 'We added the coins.');
    expect(audit[0]).toMatchObject({ action: 'SUPPORT_REPLY', targetId: 't1' });
  });

  it('a mail failure does not undo the reply', async () => {
    const { player, staff, mail, replies } = setup();
    mail.sendSupportReply.mockRejectedValueOnce(new Error('smtp down'));
    await player.create('u1', FORM);
    await expect(staff.reply('a1', 't1', 'Hello there')).resolves.toBeDefined();
    expect(replies).toHaveLength(1);
  });

  it('rejects an empty reply and an unknown ticket', async () => {
    const { player, staff } = setup();
    await player.create('u1', FORM);
    await expect(staff.reply('a1', 't1', ' ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(staff.reply('a1', 'nope', 'Hello there')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('closes and reopens a ticket with who and when; replying to a closed ticket reopens it as answered', async () => {
    const { player, staff, tickets, audit } = setup();
    await player.create('u1', FORM);
    await staff.setStatus('a1', 't1', 'CLOSED');
    expect(tickets[0]).toMatchObject({ status: 'CLOSED', closedBy: 'a1' });
    expect(tickets[0].closedAt).toBeInstanceOf(Date);
    await staff.reply('a1', 't1', 'One more thing');
    expect(tickets[0]).toMatchObject({ status: 'ANSWERED', closedBy: null, closedAt: null });
    await staff.setStatus('a1', 't1', 'OPEN');
    expect(tickets[0].status).toBe('OPEN');
    expect(audit.map((a) => a.action)).toEqual(['SUPPORT_CLOSE', 'SUPPORT_REPLY', 'SUPPORT_REOPEN']);
  });
});
