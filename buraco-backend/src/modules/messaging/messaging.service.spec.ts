import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SocketService } from '../../common/socket/socket.service';
import { MAX_TEXT_LENGTH, MessagingService } from './messaging.service';

// Chat messages used to be broadcast to a `conv:<id>` socket room that no socket ever
// joined, so nothing arrived live. Delivery now goes to each member's personal
// `user:<id>` room, and only members of a conversation may read, send or mark it read.
const CONV = '0b7d3c39-5c5e-4b8e-9a52-7f0f0f4c1a01';
const ALICE = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';
const MALLORY = 'c3333333-3333-4333-8333-333333333333';

function setup(opts: { members?: string[] | null; type?: 'DIRECT' | 'CLUB'; blocked?: boolean } = {}) {
  const members = opts.members === undefined ? [ALICE, BOB] : opts.members;
  const prisma = {
    conversation: {
      findUnique: jest.fn(async ({ select }: any) => {
        if (members === null) return null;
        return select.members ? { members: members.map((userId) => ({ userId })) } : { type: opts.type ?? 'DIRECT' };
      }),
      findFirst: jest.fn(async () => ({ id: CONV, type: 'DIRECT' })),
    },
    message: {
      create: jest.fn(async ({ data }: any) => ({ id: 'm1', ...data, sender: { id: data.senderId } })),
      updateMany: jest.fn(async () => ({ count: 2 })),
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === BOB ? { id: BOB, username: 'bob', avatarUrl: null } : null)),
    },
  };
  const friends = { isBlocked: jest.fn(async () => !!opts.blocked) };
  const socket = { emitToUsers: jest.fn() } as unknown as SocketService & { emitToUsers: jest.Mock };
  const service = new MessagingService(prisma as any, friends as any, socket);
  return { service, prisma, friends, socket };
}

describe('MessagingService — live delivery', () => {
  it('delivers a text message to every member, sender included', async () => {
    const { service, socket } = setup();
    const msg = await service.sendMessage(CONV, ALICE, '  hello  ');

    expect(msg.content).toBe('hello');
    expect(socket.emitToUsers).toHaveBeenCalledWith([ALICE, BOB], 'chat:message', msg);
  });

  it('delivers a voice message to every member', async () => {
    const { service, socket } = setup();
    const msg = await service.sendVoiceMessage(CONV, ALICE, 'voice-messages/x.m4a', 4, [ALICE, BOB]);

    expect(msg.type).toBe('VOICE');
    expect(socket.emitToUsers).toHaveBeenCalledWith([ALICE, BOB], 'chat:message', msg);
  });

  it('sends the read receipt to the other members only', async () => {
    const { service, socket } = setup();
    await service.markAsRead(CONV, BOB);

    expect(socket.emitToUsers).toHaveBeenCalledWith(
      [ALICE],
      'chat:read_receipt',
      expect.objectContaining({ conversationId: CONV, readByUserId: BOB }),
    );
  });

  it('sends typing to the other members only', async () => {
    const { service, socket } = setup();
    await service.notifyTyping(CONV, ALICE, true);

    expect(socket.emitToUsers).toHaveBeenCalledWith([BOB], 'chat:typing', { conversationId: CONV, userId: ALICE, isTyping: true });
  });
});

describe('MessagingService — who may use a conversation', () => {
  it('refuses a sender who is not a member, and saves nothing', async () => {
    const { service, prisma, socket } = setup();
    await expect(service.sendMessage(CONV, MALLORY, 'hi')).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(socket.emitToUsers).not.toHaveBeenCalled();
  });

  it('refuses a non-member reading history or marking it read', async () => {
    const { service, prisma } = setup();
    await expect(service.getHistory(CONV, MALLORY)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.markAsRead(CONV, MALLORY)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a conversation that does not exist', async () => {
    const { service } = setup({ members: null });
    await expect(service.sendMessage(CONV, ALICE, 'hi')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a direct message across a block', async () => {
    const { service, prisma } = setup({ blocked: true });
    await expect(service.sendMessage(CONV, ALICE, 'hi')).rejects.toThrow('USER_BLOCKED');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('does not apply the 1-to-1 block check to a club chat', async () => {
    const { service, friends } = setup({ type: 'CLUB', blocked: true });
    await expect(service.sendMessage(CONV, ALICE, 'hi')).resolves.toBeDefined();
    expect(friends.isBlocked).not.toHaveBeenCalled();
  });

  it('rejects empty and over-long text', async () => {
    const { service } = setup();
    await expect(service.sendMessage(CONV, ALICE, '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.sendMessage(CONV, ALICE, 'x'.repeat(MAX_TEXT_LENGTH + 1))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.sendMessage(CONV, ALICE, undefined as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MessagingService — start a private chat', () => {
  it('returns the conversation with the other player', async () => {
    const { service } = setup();
    const conv = await service.startDirectConversation(ALICE, BOB);

    expect(conv).toEqual(expect.objectContaining({ id: CONV, type: 'DIRECT', participant: expect.objectContaining({ id: BOB }), unreadCount: 0 }));
  });

  it('refuses a chat with yourself', async () => {
    const { service } = setup();
    await expect(service.startDirectConversation(ALICE, ALICE)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for an unknown player', async () => {
    const { service } = setup();
    await expect(service.startDirectConversation(ALICE, MALLORY)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses when either player has blocked the other', async () => {
    const { service } = setup({ blocked: true });
    await expect(service.startDirectConversation(ALICE, BOB)).rejects.toThrow('USER_BLOCKED');
  });
});

describe('SocketService.emitToUsers', () => {
  it("targets each user's personal room in one emit", () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const socket = new SocketService();
    socket.setServer({ to } as any);

    socket.emitToUsers([ALICE, BOB], 'chat:message', { id: 'm1' });

    expect(to).toHaveBeenCalledWith([`user:${ALICE}`, `user:${BOB}`]);
    expect(emit).toHaveBeenCalledWith('chat:message', { id: 'm1' });
  });

  it('does nothing for an empty list', () => {
    const to = jest.fn();
    const socket = new SocketService();
    socket.setServer({ to } as any);

    socket.emitToUsers([], 'chat:message', {});
    expect(to).not.toHaveBeenCalled();
  });
});
