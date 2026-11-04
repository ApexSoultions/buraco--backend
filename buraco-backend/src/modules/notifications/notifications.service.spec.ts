import { NotificationType } from '@prisma/client';
import { NotificationsService } from './notifications.service';

// Notifications used to be written to the database only: a player saw them after reopening
// the list, never as they happened. Each one is now also pushed live as `notification:new`
// to the player's `user:<id>` room, with their unread count for the badge.
const ALICE = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';

function setup(opts: { createFails?: boolean; unread?: number } = {}) {
  let seq = 0;
  const prisma = {
    notification: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.createFails) throw new Error('db down');
        return { id: `n${++seq}`, isRead: false, ...data };
      }),
      createManyAndReturn: jest.fn(async ({ data }: any) => data.map((d: any) => ({ id: `n${++seq}`, isRead: false, ...d }))),
      count: jest.fn(async () => opts.unread ?? 1),
    },
    user: { findUnique: jest.fn(async () => ({ fcmToken: null })) },
  };
  const socket = { emitToUsers: jest.fn() };
  const service = new NotificationsService(prisma as any, socket as any);
  return { service, prisma, socket };
}

describe('NotificationsService — live delivery', () => {
  it('saves the notification and sends it live with the unread count', async () => {
    const { service, socket } = setup({ unread: 3 });
    const n = await service.create(ALICE, NotificationType.FRIEND_REQUEST, 'New friend request', 'bob wants to be your friend', { requestId: 'r1' });

    expect(n).toEqual(expect.objectContaining({ userId: ALICE, type: NotificationType.FRIEND_REQUEST, data: { requestId: 'r1' } }));
    expect(socket.emitToUsers).toHaveBeenCalledWith([ALICE], 'notification:new', { notification: n, unreadCount: 3 });
  });

  it('sends each player their own copy when notifying several', async () => {
    const { service, socket, prisma } = setup();
    const rows = await service.createForUsers([ALICE, BOB, ALICE], NotificationType.CLUB_UPDATE, 'Club', 'someone joined');

    expect(prisma.notification.createManyAndReturn.mock.calls[0][0].data).toHaveLength(2);
    expect(rows.map((r) => r.userId)).toEqual([ALICE, BOB]);
    expect(socket.emitToUsers).toHaveBeenCalledWith([ALICE], 'notification:new', expect.objectContaining({ notification: rows[0] }));
    expect(socket.emitToUsers).toHaveBeenCalledWith([BOB], 'notification:new', expect.objectContaining({ notification: rows[1] }));
  });

  it('does nothing for an empty list', async () => {
    const { service, prisma, socket } = setup();
    await service.notifySafely([], NotificationType.CLUB_UPDATE, 'Club', 'nobody');

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    expect(socket.emitToUsers).not.toHaveBeenCalled();
  });
});

describe('NotificationsService.notifySafely', () => {
  it('never throws, so the action that caused it is not undone', async () => {
    const { service, socket } = setup({ createFails: true });
    await expect(service.notifySafely(ALICE, NotificationType.REWARD, 'Reward', 'x')).resolves.toBeUndefined();
    expect(socket.emitToUsers).not.toHaveBeenCalled();
  });

  it('uses a single insert for one player and a batch for several', async () => {
    const { service, prisma } = setup();
    await service.notifySafely(ALICE, NotificationType.REWARD, 'Reward', 'x');
    await service.notifySafely([ALICE, BOB], NotificationType.REWARD, 'Reward', 'x');

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledTimes(1);
  });
});
