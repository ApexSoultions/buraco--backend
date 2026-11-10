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

type SetupOpts = {
  members?: string[] | null;
  type?: 'DIRECT' | 'CLUB';
  blocked?: boolean;
  clearedAt?: Date | null;
  message?: { conversationId: string; senderId: string } | null;
  openReport?: boolean;
};

function setup(opts: SetupOpts = {}) {
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
      findUnique: jest.fn(async () => opts.message ?? null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    conversationMember: {
      findUnique: jest.fn(async () => ({ clearedAt: opts.clearedAt ?? null })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: any) => data),
    },
    report: {
      findFirst: jest.fn(async () => (opts.openReport ? { id: 'r-old', status: 'OPEN', createdAt: new Date(0) } : null)),
      create: jest.fn(async ({ data }: any) => ({ id: 'r-new', status: 'OPEN', createdAt: new Date(), ...data })),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === BOB ? { id: BOB, username: 'bob', avatarUrl: null } : null)),
    },
  };
  const friends = { isBlocked: jest.fn(async () => !!opts.blocked) };
  const socket = { emitToUsers: jest.fn() } as unknown as SocketService & { emitToUsers: jest.Mock };
  const s3 = {
    signUrls: jest.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `https://signed.example/${k}?sig=1`]))),
  };
  const missions = { updateProgressSafely: jest.fn(async () => undefined) };
  const service = new MessagingService(prisma as any, friends as any, socket, s3 as any, missions as any);
  return { service, prisma, friends, socket, s3, missions };
}

describe('MessagingService — live delivery', () => {
  it('delivers a text message to every member, sender included', async () => {
    const { service, socket } = setup();
    const msg = await service.sendMessage(CONV, ALICE, '  hello  ');

    expect(msg.content).toBe('hello');
    expect(socket.emitToUsers).toHaveBeenCalledWith([ALICE, BOB], 'chat:message', msg);
  });

  it('delivers a voice message to every member with a signed link, storing only the key', async () => {
    const { service, socket, prisma } = setup();
    const msg = await service.sendVoiceMessage(CONV, ALICE, 'voice-messages/x.m4a', 4, [ALICE, BOB]);

    expect(prisma.message.create.mock.calls[0][0].data.voiceUrl).toBe('voice-messages/x.m4a');
    expect(msg.type).toBe('VOICE');
    expect(msg.voiceUrl).toBe('https://signed.example/voice-messages/x.m4a?sig=1');
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

describe('MessagingService — clear chat', () => {
  const CLEARED = new Date('2026-11-10T12:00:00Z');

  it("hides earlier messages from the clearer's own view only", async () => {
    const { service, prisma, socket } = setup();
    const res = await service.clearConversation(CONV, ALICE);

    expect(prisma.conversationMember.update).toHaveBeenCalledWith({
      where: { conversationId_userId: { conversationId: CONV, userId: ALICE } },
      data: { clearedAt: res.clearedAt },
    });
    expect(socket.emitToUsers).toHaveBeenCalledWith([ALICE], 'chat:cleared', expect.objectContaining({ conversationId: CONV }));
  });

  it('refuses a non-member', async () => {
    const { service, prisma } = setup();
    await expect(service.clearConversation(CONV, MALLORY)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.conversationMember.update).not.toHaveBeenCalled();
  });

  it('history after clearing only returns newer messages', async () => {
    const { service, prisma } = setup({ clearedAt: CLEARED });
    await service.getHistory(CONV, ALICE);

    const expected = { conversationId: CONV, createdAt: { gt: CLEARED } };
    expect(prisma.message.findMany.mock.calls[0][0].where).toEqual(expected);
    expect(prisma.message.count.mock.calls[0][0].where).toEqual(expected);
  });

  it('history of a never-cleared chat is not filtered', async () => {
    const { service, prisma } = setup();
    await service.getHistory(CONV, ALICE);
    expect(prisma.message.findMany.mock.calls[0][0].where).toEqual({ conversationId: CONV });
  });

  it('the chat list hides a last message from before the clear and counts only newer unread', async () => {
    const { service, prisma } = setup();
    (prisma.conversation as any).findMany = jest.fn(async () => [{
      id: CONV, type: 'DIRECT', club: null,
      members: [{ user: { id: BOB, username: 'bob', avatarUrl: null } }],
      messages: [{ id: 'old', createdAt: new Date('2026-11-10T11:00:00Z') }],
    }]);
    prisma.conversationMember.findMany.mockResolvedValue([{ conversationId: CONV, clearedAt: CLEARED }] as any);

    const [row] = await service.getConversations(ALICE);

    expect(row.lastMessage).toBeNull();
    expect(prisma.message.count.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ conversationId: CONV, createdAt: { gt: CLEARED }, isRead: false }),
    );
  });
});

describe('MessagingService — report', () => {
  it('reports the other player of a 1-to-1 chat when no message is picked', async () => {
    const { service, prisma } = setup();
    const res = await service.reportConversation(CONV, ALICE, { reason: 'ABUSE' as any, details: '  rude  ' });

    expect(prisma.report.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { reporterId: ALICE, reportedUserId: BOB, conversationId: CONV, messageId: null, reason: 'ABUSE', details: 'rude' },
    }));
    expect(res.alreadyReported).toBe(false);
  });

  it("reports a picked message's sender", async () => {
    const { service, prisma } = setup({ type: 'CLUB', members: [ALICE, BOB, MALLORY], message: { conversationId: CONV, senderId: MALLORY } });
    await service.reportConversation(CONV, ALICE, { reason: 'SPAM' as any, messageId: 'm9' });

    expect(prisma.report.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ reportedUserId: MALLORY, messageId: 'm9' }));
  });

  it('needs a picked message in a club chat', async () => {
    const { service, prisma } = setup({ type: 'CLUB', members: [ALICE, BOB, MALLORY] });
    await expect(service.reportConversation(CONV, ALICE, { reason: 'SPAM' as any })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('refuses reporting your own message, or a message from another chat', async () => {
    const own = setup({ message: { conversationId: CONV, senderId: ALICE } });
    await expect(own.service.reportConversation(CONV, ALICE, { reason: 'SPAM' as any, messageId: 'm1' }))
      .rejects.toBeInstanceOf(BadRequestException);

    const elsewhere = setup({ message: { conversationId: 'other-conv', senderId: BOB } });
    await expect(elsewhere.service.reportConversation(CONV, ALICE, { reason: 'SPAM' as any, messageId: 'm1' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a non-member', async () => {
    const { service, prisma } = setup();
    await expect(service.reportConversation(CONV, MALLORY, { reason: 'SPAM' as any })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('does not file the same open report twice', async () => {
    const { service, prisma } = setup({ openReport: true });
    const res = await service.reportConversation(CONV, ALICE, { reason: 'ABUSE' as any });

    expect(res).toEqual(expect.objectContaining({ id: 'r-old', alreadyReported: true }));
    expect(prisma.report.create).not.toHaveBeenCalled();
  });
});

describe('MessagingService — mission progress', () => {
  it('counts each sent message towards the sender\'s chat missions', async () => {
    const { service, missions } = setup();
    await service.sendMessage(CONV, ALICE, 'hi');
    await service.sendVoiceMessage(CONV, ALICE, 'voice-messages/x.m4a', 2, [ALICE, BOB]);
    expect(missions.updateProgressSafely).toHaveBeenCalledTimes(2);
    expect(missions.updateProgressSafely).toHaveBeenCalledWith(ALICE, 'SEND_MESSAGES');
  });

  it('does not count a refused message', async () => {
    const { service, missions } = setup();
    await expect(service.sendMessage(CONV, MALLORY, 'hi')).rejects.toBeDefined();
    expect(missions.updateProgressSafely).not.toHaveBeenCalled();
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
