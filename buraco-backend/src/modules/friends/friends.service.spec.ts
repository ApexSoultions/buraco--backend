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
