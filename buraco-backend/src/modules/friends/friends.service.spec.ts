import { ConflictException, NotFoundException } from '@nestjs/common';
import { FriendshipStatus, NotificationType } from '@prisma/client';
import { FriendsService } from './friends.service';

// Friend requests and acceptances now notify the other player, and a request that was
// declined earlier can be sent again (it used to hit the unique sender/receiver index).
const ALICE = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';

function setup(opts: { existing?: any; receiverExists?: boolean; request?: any } = {}) {
  const prisma = {
    block: { findFirst: jest.fn(async () => null) },
    friendship: {
      findFirst: jest.fn(async () => opts.existing ?? null),
      findUnique: jest.fn(async () => opts.request ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 'f-new', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === BOB && opts.receiverExists === false) return null;
        return { id: where.id, username: where.id === ALICE ? 'alice' : 'bob', avatarUrl: null };
      }),
    },
  };
  const notifications = { notifySafely: jest.fn(async () => undefined) };
  const service = new FriendsService(prisma as any, notifications as any);
  return { service, prisma, notifications };
}

describe('FriendsService notifications', () => {
  it('notifies the receiver of a new friend request', async () => {
    const { service, notifications } = setup();
    const req = await service.sendRequest(ALICE, BOB);

    expect(notifications.notifySafely).toHaveBeenCalledWith(BOB, NotificationType.FRIEND_REQUEST, 'New friend request',
      'alice wants to be your friend', expect.objectContaining({ requestId: req.id, fromUserId: ALICE, fromUsername: 'alice' }));
  });

  it('notifies the sender when their request is accepted', async () => {
    const { service, notifications } = setup({ request: { id: 'f1', senderId: ALICE, receiverId: BOB, status: FriendshipStatus.PENDING } });
    await service.acceptRequest(BOB, 'f1');

    expect(notifications.notifySafely).toHaveBeenCalledWith(ALICE, NotificationType.FRIEND_ACCEPTED, 'Friend request accepted',
      'bob accepted your friend request', expect.objectContaining({ friendshipId: 'f1', userId: BOB }));
  });

  it('does not notify when the request is refused', async () => {
    const { service, notifications } = setup({ existing: { id: 'f1', status: FriendshipStatus.PENDING } });
    await expect(service.sendRequest(ALICE, BOB)).rejects.toBeInstanceOf(ConflictException);
    expect(notifications.notifySafely).not.toHaveBeenCalled();
  });

  it('returns 404 for a player that does not exist', async () => {
    const { service, prisma } = setup({ receiverExists: false });
    await expect(service.sendRequest(ALICE, BOB)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.friendship.create).not.toHaveBeenCalled();
  });

  it('reopens a previously declined request instead of creating a duplicate', async () => {
    const { service, prisma } = setup({ existing: { id: 'f-old', senderId: BOB, receiverId: ALICE, status: FriendshipStatus.DECLINED } });
    const req = await service.sendRequest(ALICE, BOB);

    expect(prisma.friendship.create).not.toHaveBeenCalled();
    expect(prisma.friendship.update).toHaveBeenCalledWith({
      where: { id: 'f-old' },
      data: { senderId: ALICE, receiverId: BOB, status: FriendshipStatus.PENDING },
    });
    expect(req.id).toBe('f-old');
  });
});

describe('FriendsService.getFriends — online first', () => {
  it('marks who is online and lists them before offline friends, then by name', async () => {
    const card = (id: string, username: string) => ({ id, username, avatarUrl: null, lastSeenAt: null, stats: { level: 1 } });
    const prisma = {
      friendship: {
        findMany: jest.fn(async () => [
          { id: 'f1', senderId: 'me', receiverId: 'zed', updatedAt: new Date(), sender: card('me', 'me'), receiver: card('zed', 'zed') },
          { id: 'f2', senderId: 'amy', receiverId: 'me', updatedAt: new Date(), sender: card('amy', 'amy'), receiver: card('me', 'me') },
          { id: 'f3', senderId: 'me', receiverId: 'bob', updatedAt: new Date(), sender: card('me', 'me'), receiver: card('bob', 'bob') },
        ]),
      },
    };
    const redis = { mget: jest.fn(async (keys: string[]) => keys.map((k) => (k === 'online:zed' ? '1' : null))) };
    const service = new FriendsService(prisma as any, {} as any, redis as any);

    const list = await service.getFriends('me');
    expect(list.map((f) => [f.user.username, f.user.online])).toEqual([['zed', true], ['amy', false], ['bob', false]]);
  });
});

describe('FriendsService.blockUser', () => {
  it('returns 404 for a player that does not exist (not a 500 from the database)', async () => {
    const prisma = { user: { findUnique: jest.fn(async () => null) }, block: { upsert: jest.fn() }, friendship: { deleteMany: jest.fn() } };
    const service = new FriendsService(prisma as any, {} as any);
    await expect(service.blockUser('me', '00000000-0000-4000-8000-000000000000')).rejects.toThrow('User not found');
    expect(prisma.block.upsert).not.toHaveBeenCalled();
  });

  it('blocks and ends any friendship or request between the two', async () => {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'them', blockLimit: 50 })) },
      block: { upsert: jest.fn(async () => ({})), findUnique: jest.fn(async () => null), count: jest.fn(async () => 3) },
      friendship: { deleteMany: jest.fn(async () => ({ count: 1 })) },
    };
    const service = new FriendsService(prisma as any, {} as any);
    await service.blockUser('me', 'them');
    expect(prisma.block.upsert).toHaveBeenCalled();
    expect(prisma.friendship.deleteMany).toHaveBeenCalled();
  });

  it('refuses a new block when the black list is full (Special Features adds room)', async () => {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'them', blockLimit: 50 })) },
      block: { upsert: jest.fn(), findUnique: jest.fn(async () => null), count: jest.fn(async () => 50) },
      friendship: { deleteMany: jest.fn() },
    };
    const service = new FriendsService(prisma as any, {} as any);
    await expect(service.blockUser('me', 'them')).rejects.toThrow('BLOCK_LIST_FULL');
    expect(prisma.block.upsert).not.toHaveBeenCalled();
  });
});
