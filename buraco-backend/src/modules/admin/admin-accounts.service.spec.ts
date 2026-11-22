import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AdminAccountsService } from './admin-accounts.service';

// Admin panel accounts: own password, staff accounts, and the "never lock the panel" rules.
async function setup() {
  const admins: any[] = [
    { id: 'boss', email: 'boss@x.com', name: 'Boss', role: AdminRole.SUPER_ADMIN, isActive: true, passwordHash: await bcrypt.hash('old-password-1', 4) },
    { id: 'mod', email: 'mod@x.com', name: 'Mod', role: AdminRole.MODERATOR, isActive: true, passwordHash: 'x' },
  ];
  const logs: any[] = [];
  const pick = (a: any) => a && (({ passwordHash, ...rest }) => rest)(a);
  const prisma: any = {
    adminUser: {
      findUnique: jest.fn(async ({ where }: any) => {
        const a = admins.find((x) => (where.id ? x.id === where.id : x.email === where.email));
        return a ?? null;
      }),
      findMany: jest.fn(async () => admins.map(pick)),
      count: jest.fn(async ({ where }: any) => admins.filter((a) => a.role === where.role && a.isActive === where.isActive).length),
      create: jest.fn(async ({ data }: any) => { const a = { id: `a${admins.length}`, isActive: true, ...data }; admins.push(a); return pick(a); }),
      update: jest.fn(async ({ where, data }: any) => pick(Object.assign(admins.find((a) => a.id === where.id), data))),
    },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { logs.push(data); return data; }) },
  };
  return { service: new AdminAccountsService(prisma), admins, logs };
}

describe('AdminAccountsService', () => {
  it('changes the own password only with the right current one', async () => {
    const { service, admins, logs } = await setup();
    await expect(service.changePassword('boss', { currentPassword: 'wrong', newPassword: 'new-password-12' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await service.changePassword('boss', { currentPassword: 'old-password-1', newPassword: 'new-password-12' });
    expect(await bcrypt.compare('new-password-12', admins[0].passwordHash)).toBe(true);
    expect(logs.map((l) => l.action)).toContain('CHANGE_OWN_PASSWORD');
  });

  it('adds a staff account once per email, stored lower-case, password hashed', async () => {
    const { service, admins } = await setup();
    const a = await service.create('boss', { email: 'Help@X.com', name: 'Help', role: AdminRole.SUPPORT, password: 'support-pass-1' });
    expect(a.email).toBe('help@x.com');
    expect((a as any).passwordHash).toBeUndefined();
    expect(admins.find((x) => x.email === 'help@x.com').passwordHash).not.toBe('support-pass-1');
    await expect(service.create('boss', { email: 'help@x.com', name: 'Again', role: AdminRole.SUPPORT, password: 'support-pass-1' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('never lets you switch yourself off or change your own role', async () => {
    const { service } = await setup();
    await expect(service.update('boss', 'boss', { isActive: false })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('boss', 'boss', { role: AdminRole.SUPPORT })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps at least one active super admin', async () => {
    const { service } = await setup();
    await service.update('boss', 'mod', { role: AdminRole.SUPER_ADMIN }); // now two
    await service.update('boss', 'mod', { isActive: false });            // back to one: allowed
    await expect(service.update('mod', 'boss', { role: AdminRole.MODERATOR })).rejects.toThrow('LAST_SUPER_ADMIN');
  });

  it('switches a staff account off and never writes a password to the audit log', async () => {
    const { service, admins, logs } = await setup();
    await service.update('boss', 'mod', { isActive: false, password: 'reset-password-1' });
    expect(admins[1].isActive).toBe(false);
    const entry = logs.find((l) => l.action === 'UPDATE_ADMIN');
    expect(JSON.stringify(entry.details)).not.toContain('reset-password-1');
    expect(entry.details.passwordReset).toBe(true);
  });
});
