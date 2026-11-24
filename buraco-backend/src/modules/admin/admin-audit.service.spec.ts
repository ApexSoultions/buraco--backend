import { AdminAuditService, AUDIT_GROUPS, redact } from './admin-audit.service';

// Audit log: filters, groups, and never showing secrets.
function setup(rows: any[] = []) {
  const prisma: any = {
    adminAuditLog: { findMany: jest.fn(async () => rows), count: jest.fn(async () => rows.length) },
    adminUser: { findMany: jest.fn(async () => [{ id: 'a1', name: 'Super Admin' }]) },
  };
  return { service: new AdminAuditService(prisma), prisma };
}
const whereOf = (prisma: any) => prisma.adminAuditLog.findMany.mock.calls[0][0].where;

describe('redact', () => {
  it('hides the old value of a secret setting', () => {
    expect(redact('UPDATE_CONFIG', 'smtp_pass', { value: 'hunter2' })).toEqual({ hidden: 'The old value was a secret and is not shown.' });
    expect(redact('UPDATE_CONFIG', 'aws_secret_access_key', { value: 'abc' })).not.toHaveProperty('value');
  });

  it('keeps a normal setting value, and masks secret-looking fields in any entry', () => {
    expect(redact('UPDATE_CONFIG', 'new_user_coins', { value: '1000' })).toEqual({ value: '1000' });
    expect(redact('X', 'y', { password: 'p', title: 't' })).toEqual({ password: '••••••', title: 't' });
  });

  it('leaves empty details alone', () => {
    expect(redact('BAN_USER', 'u', null)).toBeNull();
  });
});

describe('AdminAuditService', () => {
  it('lists newest first with the staff list for the filter', async () => {
    const { service, prisma } = setup([{ id: 'l1', action: 'BAN_USER', targetType: 'User', targetId: 'u1', createdAt: new Date(), details: { reason: 'x' }, admin: { id: 'a1', name: 'Super Admin', email: 'a@b', role: 'SUPER_ADMIN' } }]);
    const res = await service.list({});
    expect(prisma.adminAuditLog.findMany.mock.calls[0][0]).toMatchObject({ orderBy: { createdAt: 'desc' }, skip: 0, take: 50 });
    expect(res.total).toBe(1);
    expect(res.admins).toEqual([{ id: 'a1', name: 'Super Admin' }]);
    expect(res.groups).toEqual(Object.keys(AUDIT_GROUPS));
  });

  it('a group becomes exact / prefix / contains rules', async () => {
    const { service, prisma } = setup();
    await service.list({ group: 'Moderation' });
    const or = whereOf(prisma).AND[0].OR;
    expect(or).toContainEqual({ action: { in: ['VOID_GAME'] } });
    expect(or).toContainEqual({ action: { startsWith: 'REPORT_' } });
    expect(or).toContainEqual({ action: { contains: 'CUSTOM_CARD' } });
  });

  it('combines staff member, action and dates; a date range covers the whole last day', async () => {
    const { service, prisma } = setup();
    await service.list({ adminId: 'a1', action: 'BAN_USER', from: '2026-11-01', to: '2026-11-02' });
    const and = whereOf(prisma).AND;
    expect(and).toContainEqual({ adminId: 'a1' });
    expect(and).toContainEqual({ action: 'BAN_USER' });
    const range = and.find((c: any) => c.createdAt).createdAt;
    expect(range.gte.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('ignores bad dates and unknown groups, and caps the page size', async () => {
    const { service, prisma } = setup();
    await service.list({ from: 'yesterday', group: 'Nope', limit: 5000 });
    expect(whereOf(prisma)).toEqual({});
    expect(prisma.adminAuditLog.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('words search the action name, target id and target type', async () => {
    const { service, prisma } = setup();
    await service.list({ q: ' ban user ' });
    const or = whereOf(prisma).AND[0].OR;
    expect(or[0]).toEqual({ action: { contains: 'BAN_USER' } });
    expect(or).toHaveLength(3);
  });

  it('secret values in old entries are hidden in the list', async () => {
    const { service } = setup([{ id: 'l1', action: 'UPDATE_CONFIG', targetType: 'SystemConfig', targetId: 'smtp_pass', createdAt: new Date(), details: { value: 'hunter2' }, admin: null }]);
    const res = await service.list({});
    expect(JSON.stringify(res.data)).not.toContain('hunter2');
  });
});
