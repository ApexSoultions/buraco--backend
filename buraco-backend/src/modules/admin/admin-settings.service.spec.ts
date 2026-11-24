import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminSettingsService } from './admin-settings.service';
import { AdminBroadcastService } from './admin-broadcast.service';
import { SETTINGS } from './admin-settings.catalog';

// Game settings (only connected ones are editable, values checked, secrets never sent back
// or logged) and broadcasts (audience, double-send guard, history).
function settingsSetup(rows: any[] = []) {
  const store = new Map<string, any>(rows.map((r) => [r.key, r]));
  const audit: any[] = [];
  const prisma: any = {
    systemConfig: {
      findMany: jest.fn(async () => [...store.values()]),
      findUnique: jest.fn(async ({ where }: any) => store.get(where.key) ?? null),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const row = { ...(store.get(where.key) ?? create), ...(store.has(where.key) ? update : {}), updatedAt: new Date() };
        store.set(where.key, row);
        return row;
      }),
    },
    adminAuditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
  };
  const sysConfig: any = { invalidate: jest.fn() };
  return { service: new AdminSettingsService(prisma, sysConfig), store, audit, sysConfig };
}

describe('AdminSettingsService', () => {
  it('lists every setting; settings the game does not use are marked not connected', async () => {
    const { service } = settingsSetup();
    const list = await service.list();
    expect(list).toHaveLength(SETTINGS.length);
    expect(list.find((s) => s.key === 'new_user_coins')).toMatchObject({ connected: true, fallback: '1000' });
    for (const k of ['maintenance_mode', 'turn_duration_seconds', 'classic_entry_fee']) {
      expect(list.find((s) => s.key === k)?.connected).toBe(false);
    }
  });

  it('never sends a secret back, only whether it is set; unknown secret-looking keys are masked too', async () => {
    const { service } = settingsSetup([
      { key: 'smtp_pass', value: 'hunter2', updatedAt: new Date() },
      { key: 'old_api_token', value: 'abc', updatedAt: new Date() },
    ]);
    const list = await service.list();
    expect(list.find((s) => s.key === 'smtp_pass')).toMatchObject({ value: null, isSet: true });
    expect(list.find((s) => s.key === 'old_api_token')).toMatchObject({ value: null, isSet: true, connected: false });
    expect(JSON.stringify(list)).not.toContain('hunter2');
  });

  it('changes a number, clears the cache and logs before and after', async () => {
    const { service, audit, sysConfig, store } = settingsSetup([{ key: 'new_user_coins', value: '1000', updatedAt: new Date() }]);
    await service.set('a1', 'new_user_coins', ' 2500 ');
    expect(store.get('new_user_coins').value).toBe('2500');
    expect(sysConfig.invalidate).toHaveBeenCalledWith('new_user_coins');
    expect(audit[0]).toMatchObject({ action: 'UPDATE_SETTING', details: { from: '1000', to: '2500' } });
  });

  it('checks values: numbers in range, no junk', async () => {
    const { service } = settingsSetup();
    await expect(service.set('a', 'new_user_coins', 'lots')).rejects.toThrow('NOT_A_NUMBER');
    await expect(service.set('a', 'new_user_coins', '-5')).rejects.toThrow('NOT_A_NUMBER');
    await expect(service.set('a', 'new_user_lives', '500')).rejects.toThrow('OUT_OF_RANGE');
    await expect(service.set('a', 'smtp_host', 'x'.repeat(501))).rejects.toThrow('TOO_LONG');
  });

  it('refuses settings the game does not use, and unknown ones', async () => {
    const { service } = settingsSetup();
    await expect(service.set('a', 'maintenance_mode', 'true')).rejects.toThrow('NOT_CONNECTED');
    await expect(service.set('a', 'nope', '1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a secret is saved and logged without its value; blank clears it', async () => {
    const { service, audit, store } = settingsSetup();
    await service.set('a1', 'smtp_pass', 'hunter2');
    expect(store.get('smtp_pass').value).toBe('hunter2');
    expect(JSON.stringify(audit)).not.toContain('hunter2');
    expect(audit[0].details).toMatchObject({ changed: true, cleared: false });
    await service.set('a1', 'smtp_pass', '');
    expect(audit[1].details).toMatchObject({ cleared: true });
  });

  it('saving the same value changes and logs nothing', async () => {
    const { service, audit } = settingsSetup([{ key: 'new_user_coins', value: '1000', updatedAt: new Date() }]);
    await service.set('a1', 'new_user_coins', '1000');
    expect(audit).toHaveLength(0);
  });
});

function broadcastSetup(opts: { recent?: boolean } = {}) {
  const audit: any[] = [];
  const created: any[] = [];
  const prisma: any = {
    user: { findMany: jest.fn(async () => [{ id: 'u1' }, { id: 'u2' }]), count: jest.fn(async () => 2) },
    notification: { createMany: jest.fn(async ({ data }: any) => { created.push(...data); }) },
    adminAuditLog: {
      findFirst: jest.fn(async () => (opts.recent ? { id: 'x' } : null)),
      create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }),
      findMany: jest.fn(async () => [
        { id: 'l1', details: { title: 'Hi', body: 'There', recipientCount: 2 }, createdAt: new Date(), admin: { name: 'Super Admin' } },
        { id: 'l2', details: null, createdAt: new Date(), admin: null },
      ]),
    },
  };
  const socket: any = { emitToAll: jest.fn() };
  return { service: new AdminBroadcastService(prisma, socket), created, audit, socket };
}

describe('AdminBroadcastService', () => {
  it('sends to every active player, goes live, and logs title, message and count', async () => {
    const { service, created, audit, socket } = broadcastSetup();
    expect(await service.send('a1', '  New season  ', ' Play now ')).toEqual({ sent: 2 });
    expect(created.map((n) => n.userId)).toEqual(['u1', 'u2']);
    expect(created[0]).toMatchObject({ title: 'New season', body: 'Play now', type: 'BROADCAST' });
    expect(socket.emitToAll).toHaveBeenCalledTimes(1);
    expect(audit[0]).toMatchObject({ action: 'BROADCAST', details: { title: 'New season', body: 'Play now', recipientCount: 2 } });
  });

  it('refuses the same message twice within ten minutes and empty text', async () => {
    const { service, created } = broadcastSetup({ recent: true });
    await expect(service.send('a1', 'A', 'B')).rejects.toThrow('ALREADY_SENT');
    expect(created).toHaveLength(0);
    await expect(broadcastSetup().service.send('a1', '  ', 'x')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shows the audience size and the history (old entries without text still list)', async () => {
    const { service } = broadcastSetup();
    expect(await service.audienceCount()).toEqual({ count: 2 });
    const h = await service.history();
    expect(h[0]).toMatchObject({ title: 'Hi', body: 'There', recipients: 2, sentBy: 'Super Admin' });
    expect(h[1]).toMatchObject({ title: '', recipients: 0 });
  });
});
