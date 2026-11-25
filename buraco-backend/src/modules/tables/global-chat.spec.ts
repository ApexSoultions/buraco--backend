import { BadRequestException, HttpException } from '@nestjs/common';
import { GlobalChatService, GLOBAL_CHAT_HISTORY, GLOBAL_CHAT_ROOM } from './global-chat.service';

function setup(opts: { blocked?: string[] } = {}) {
  const kv = new Map<string, string>();
  const pictures = new Map<string, string | null>();
  const redis = {
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
    setJson: jest.fn(async (k: string, v: object) => { kv.set(k, JSON.stringify(v)); }),
    getJson: jest.fn(async (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null)),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({ username: where.id.replace('-id', ''), avatarUrl: pictures.get(where.id) ?? null })),
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id, avatarUrl: pictures.get(id) ?? null }))),
    },
    block: { findMany: jest.fn(async () => (opts.blocked ?? []).map((blockedId) => ({ blockedId }))) },
    report: { create: jest.fn(async () => ({})) },
  };
  const socket = { emitToRoom: jest.fn() };
  const service = new GlobalChatService(prisma as any, redis as any, socket as any);
  return { service, prisma, socket, pictures };
}

describe('GlobalChatService', () => {
  it('sends to everyone on the table list and keeps it in the history', async () => {
    const { service, socket } = setup();
    const msg = await service.send('alice-id', { text: '  hi all  ' });
    expect(msg).toMatchObject({ senderId: 'alice-id', username: 'alice', kind: 'TEXT', text: 'hi all' });
    expect(socket.emitToRoom).toHaveBeenCalledWith(GLOBAL_CHAT_ROOM, 'lobby:chat:message', msg);
    expect((await service.history('bob-id')).messages).toEqual([msg]);
  });

  it('the history shows each sender\'s current picture, not the one the message was sent with', async () => {
    const { service, pictures } = setup();
    pictures.set('alice-id', 'https://s3/old.png');
    await service.send('alice-id', { text: 'hello' });
    pictures.set('alice-id', '/avatars/predefined/002.png'); // Alice chose a new picture later
    const [m] = (await service.history('bob-id')).messages;
    expect(m.avatarUrl).toBe('/avatars/predefined/002.png');
  });

  it('rejects empty, too long and unknown kinds', async () => {
    const { service } = setup();
    await expect(service.send('a-id', { text: '   ' })).rejects.toThrow(BadRequestException);
    await expect(service.send('a-id', { text: 'x'.repeat(201) })).rejects.toThrow('MESSAGE_TOO_LONG');
    await expect(service.send('a-id', { kind: 'VOICE', text: 'x' })).rejects.toThrow('INVALID_KIND');
  });

  it('keeps only the last 50 messages', async () => {
    const { service } = setup();
    for (let i = 0; i < GLOBAL_CHAT_HISTORY + 5; i++) await service.send(`u${i}-id`, { text: `m${i}` });
    const { messages } = await service.history('x-id');
    expect(messages).toHaveLength(GLOBAL_CHAT_HISTORY);
    expect(messages[0].text).toBe('m5');
  });

  it('limits how fast one player can send', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i++) await service.send('spam-id', { text: `${i}` });
    await expect(service.send('spam-id', { text: 'again' })).rejects.toThrow(HttpException);
  });

  it('hides blocked players and what I cleared', async () => {
    const { service } = setup({ blocked: ['carl-id'] });
    await service.send('alice-id', { text: 'old' });
    await service.send('carl-id', { text: 'blocked' });
    expect((await service.history('bob-id')).messages.map((m) => m.text)).toEqual(['old']);
    await new Promise((r) => setTimeout(r, 5));
    await service.clear('bob-id');
    await new Promise((r) => setTimeout(r, 5));
    await service.send('alice-id', { text: 'new' });
    expect((await service.history('bob-id')).messages.map((m) => m.text)).toEqual(['new']);
  });

  it('reports a player with their recent messages', async () => {
    const { service, prisma } = setup();
    await service.send('carl-id', { text: 'rude words' });
    await service.report('bob-id', { userId: 'carl-id', reason: 'abuse' });
    expect(prisma.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reporterId: 'bob-id', reportedUserId: 'carl-id', reason: 'ABUSE', details: expect.stringContaining('rude words') }),
    });
    await expect(service.report('bob-id', { userId: 'bob-id' })).rejects.toThrow('CANNOT_REPORT_SELF');
    await expect(service.report('bob-id', { userId: 'dave-id' })).rejects.toThrow('NO_MESSAGES_FROM_USER');
  });
});
