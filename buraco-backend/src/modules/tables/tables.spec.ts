import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GameStatus, GameVariant, NotificationType, RoomStatus } from '@prisma/client';
import { TableInvitesService } from './table-invites.service';
import { TableChatService } from './table-chat.service';
import { RematchService } from './rematch.service';
import { GameEngineService } from '../game-engine/game-engine.service';

const ALICE = 'alice-id';
const BOB = 'bob-id';
const CARL = 'carl-id';

/** Minimal in-memory Redis with the calls these services use. */
function fakeRedis() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    kv, sets,
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
    setNx: jest.fn(async (k: string, v: string) => (kv.has(k) ? null : (kv.set(k, v), 'OK'))),
    del: jest.fn(async (k: string) => { kv.delete(k); sets.delete(k); return 1; }),
    expire: jest.fn(async () => 1),
    setJson: jest.fn(async (k: string, v: object) => { kv.set(k, JSON.stringify(v)); }),
    getJson: jest.fn(async (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null)),
    sadd: jest.fn(async (k: string, ...m: string[]) => { const s = sets.get(k) ?? new Set(); m.forEach((x) => s.add(x)); sets.set(k, s); return m.length; }),
    srem: jest.fn(async (k: string, ...m: string[]) => { m.forEach((x) => sets.get(k)?.delete(x)); return m.length; }),
    smembers: jest.fn(async (k: string) => [...(sets.get(k) ?? [])]),
  };
}

const socket = () => ({ emitToUsers: jest.fn(), emitToRoom: jest.fn() });
const engine = { stateKey: (id: string) => `game:${id}:state` };

// ── Invites ──────────────────────────────────────────────────────────────────

function inviteSetup(opts: { seats?: Record<string, string>; friends?: boolean; blocked?: boolean; status?: RoomStatus } = {}) {
  const redis = fakeRedis();
  const sock = socket();
  const room = { id: 'room-1', mode: 'CLASSIC', variant: GameVariant.TWO_VS_TWO, maxPlayers: 4, status: opts.status ?? RoomStatus.WAITING, tableLabel: 'Table of alice', entryFeeCoins: 0 };
  const prisma = {
    room: { findUnique: jest.fn(async () => room) },
    user: { findUnique: jest.fn(async ({ where }: any) => ({ username: where.id === ALICE ? 'alice' : 'bob', avatarUrl: null })) },
  };
  const rooms = {
    getRoomSeats: jest.fn(async () => opts.seats ?? { '0': ALICE, '0:u': 'alice' }),
    joinRoom: jest.fn(async (uid: string, roomId: string, seat?: number) => ({ id: roomId, seatIndex: seat ?? 1 })),
  };
  const friends = { isFriend: jest.fn(async () => opts.friends ?? true), isBlocked: jest.fn(async () => opts.blocked ?? false) };
  const notifications = { notifySafely: jest.fn(async () => undefined) };
  const service = new TableInvitesService(prisma as any, redis as any, sock as any, rooms as any, friends as any, notifications as any);
  return { service, redis, sock, rooms, notifications };
}

describe('TableInvitesService', () => {
  it('sends a live invite and a MATCH_INVITE notification for the tapped chair', async () => {
    const { service, sock, notifications } = inviteSetup();
    const inv = await service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB, seatIndex: 2 });

    expect(inv).toMatchObject({ roomId: 'room-1', fromUserId: ALICE, toUserId: BOB, seatIndex: 2, fromUsername: 'alice' });
    expect(sock.emitToUsers).toHaveBeenCalledWith([BOB], 'room:invite', inv);
    expect(notifications.notifySafely).toHaveBeenCalledWith(BOB, NotificationType.MATCH_INVITE, 'Table invite',
      'alice invites you to their table', expect.objectContaining({ inviteId: inv.id, seatIndex: 2 }));
  });

  it('refuses: not seated, not friends, blocked, seat taken, twice, game started', async () => {
    await expect(inviteSetup({ seats: {} }).service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB }))
      .rejects.toThrow('NOT_IN_ROOM');
    await expect(inviteSetup({ friends: false }).service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB }))
      .rejects.toThrow('NOT_FRIENDS');
    await expect(inviteSetup({ blocked: true }).service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB }))
      .rejects.toThrow('USER_BLOCKED');
    await expect(inviteSetup().service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB, seatIndex: 0 }))
      .rejects.toThrow('SEAT_TAKEN');
    await expect(inviteSetup({ status: RoomStatus.IN_PROGRESS }).service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB }))
      .rejects.toThrow('ROOM_NOT_WAITING');

    const { service } = inviteSetup();
    await service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB });
    await expect(service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB })).rejects.toThrow('INVITE_ALREADY_SENT');
  });

  it('accept seats the friend on the chair and tells the inviter; the invite is then gone', async () => {
    const { service, rooms, sock } = inviteSetup();
    const inv = await service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB, seatIndex: 2 });
    expect(await service.getMyInvites(BOB)).toHaveLength(1);

    await service.accept(BOB, inv.id);
    expect(rooms.joinRoom).toHaveBeenCalledWith(BOB, 'room-1', 2);
    expect(sock.emitToUsers).toHaveBeenCalledWith([ALICE], 'room:invite_answer', expect.objectContaining({ accepted: true, toUserId: BOB }));
    expect(await service.getMyInvites(BOB)).toHaveLength(0);
    await expect(service.accept(BOB, inv.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('falls back to any free chair when the invited one was taken meanwhile', async () => {
    const { service, rooms } = inviteSetup();
    const inv = await service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB, seatIndex: 2 });
    rooms.joinRoom.mockRejectedValueOnce(new BadRequestException('SEAT_TAKEN'));
    await service.accept(BOB, inv.id);
    expect(rooms.joinRoom).toHaveBeenLastCalledWith(BOB, 'room-1');
  });

  it('only the invited player can answer; decline tells the inviter', async () => {
    const { service, sock } = inviteSetup();
    const inv = await service.sendInvite(ALICE, { roomId: 'room-1', friendId: BOB });
    await expect(service.decline(CARL, inv.id)).rejects.toBeInstanceOf(ForbiddenException);
    await service.decline(BOB, inv.id);
    expect(sock.emitToUsers).toHaveBeenCalledWith([ALICE], 'room:invite_answer', expect.objectContaining({ accepted: false, reason: 'DECLINED' }));
  });
});

// ── Table chat ───────────────────────────────────────────────────────────────

function gameState(status: GameStatus = GameStatus.IN_PROGRESS) {
  return {
    gameId: 'g1', mode: 'CLASSIC', variant: 'ONE_VS_ONE', status, endMode: 'INDIRECT', makart: false,
    players: [{ userId: ALICE, teamId: 1, isConnected: true }, { userId: BOB, teamId: 2, isConnected: true }],
    seatMap: { [ALICE]: 0, [BOB]: 1 }, usernames: { [ALICE]: 'alice', [BOB]: 'bob' },
    turnDuration: 30, targetScore: 0,
  };
}

function chatSetup(voiceExpiry: Date | null = null) {
  const redis = fakeRedis();
  redis.kv.set('game:g1:state', JSON.stringify(gameState()));
  const sock = socket();
  const prisma = { user: { findUnique: jest.fn(async () => ({ voiceChatExpiry: voiceExpiry })) } };
  const s3 = { signUrls: jest.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `https://signed/${k}`]))) };
  const service = new TableChatService(prisma as any, redis as any, sock as any, s3 as any, engine as any);
  return { service, sock };
}

describe('TableChatService', () => {
  it('broadcasts to the game room and keeps history', async () => {
    const { service, sock } = chatSetup();
    const msg = await service.send('g1', ALICE, { text: '  good luck  ' });
    expect(msg).toMatchObject({ senderId: ALICE, username: 'alice', teamId: 1, kind: 'TEXT', text: 'good luck' });
    expect(sock.emitToRoom).toHaveBeenCalledWith('game:g1', 'table:chat:message', msg);
    expect(await service.history('g1', BOB)).toHaveLength(1);
  });

  it('refuses strangers, empty and over-long messages, unknown kinds', async () => {
    const { service } = chatSetup();
    await expect(service.send('g1', CARL, { text: 'hi' })).rejects.toThrow('NOT_AT_TABLE');
    await expect(service.history('g1', CARL)).rejects.toThrow('NOT_AT_TABLE');
    await expect(service.send('g1', ALICE, { text: '   ' })).rejects.toThrow('EMPTY_MESSAGE');
    await expect(service.send('g1', ALICE, { text: 'x'.repeat(201) })).rejects.toThrow('MESSAGE_TOO_LONG');
    await expect(service.send('g1', ALICE, { kind: 'VOICE', text: 'x' })).rejects.toThrow('INVALID_KIND');
    await expect(service.send('nope', ALICE, { text: 'hi' })).rejects.toThrow('GAME_NOT_FOUND');
  });

  it('voice needs the Voice chat subscription and is sent as a signed link', async () => {
    await expect(chatSetup(null).service.assertCanSendVoice('g1', ALICE)).rejects.toThrow('VOICE_CHAT_REQUIRED');

    const { service } = chatSetup(new Date(Date.now() + 86400_000));
    await service.assertCanSendVoice('g1', ALICE);
    const msg = await service.sendVoice('g1', ALICE, 'voice-messages/table/g1/a.wav', 3);
    expect(msg).toMatchObject({ kind: 'VOICE', duration: 3, voiceUrl: 'https://signed/voice-messages/table/g1/a.wav' });
  });
});

// ── Rematch ──────────────────────────────────────────────────────────────────

function rematchSetup(opts: { joinFailsFor?: string } = {}) {
  const redis = fakeRedis();
  redis.kv.set('game:g1:state', JSON.stringify(gameState(GameStatus.COMPLETED)));
  const sock = socket();
  const prisma = {
    room: {
      findFirst: jest.fn(async () => ({ id: 'old-room', entryFeeCoins: 0, endMode: null })),
      create: jest.fn(async ({ data }: any) => ({ id: 'new-room', ...data })),
      findUnique: jest.fn(async () => ({ id: 'new-room', gameId: 'g2' })),
    },
  };
  const rooms = {
    joinRoom: jest.fn(async (uid: string) => {
      if (uid === opts.joinFailsFor) throw new BadRequestException('INSUFFICIENT_COINS');
      return {};
    }),
    leaveRoom: jest.fn(async () => ({})),
  };
  const service = new RematchService(prisma as any, redis as any, sock as any, engine as any, rooms as any);
  return { service, sock, rooms, prisma, redis };
}

describe('RematchService', () => {
  it('waits for every player, then opens a new table on the same chairs', async () => {
    const { service, sock, rooms, prisma } = rematchSetup();

    const first = await service.request('g1', ALICE);
    expect(first).toMatchObject({ status: 'OPEN', acceptedUserIds: [ALICE], neededCount: 2 });
    expect(rooms.joinRoom).not.toHaveBeenCalled();

    const done = await service.request('g1', BOB);
    expect(prisma.room.create).toHaveBeenCalledWith({ data: expect.objectContaining({ mode: 'CLASSIC', variant: 'ONE_VS_ONE', maxPlayers: 2, isDefaultTable: false }) });
    expect(rooms.joinRoom).toHaveBeenNthCalledWith(1, ALICE, 'new-room', 0);
    expect(rooms.joinRoom).toHaveBeenNthCalledWith(2, BOB, 'new-room', 1);
    expect(done).toMatchObject({ status: 'STARTED', roomId: 'new-room', newGameId: 'g2' });
    expect(sock.emitToRoom).toHaveBeenCalledWith('game:g1', 'game:rematch:start', expect.objectContaining({ newGameId: 'g2' }));
  });

  it('a decline cancels it for everyone and blocks later taps', async () => {
    const { service, sock } = rematchSetup();
    await service.request('g1', ALICE);
    await service.decline('g1', BOB);
    expect(sock.emitToRoom).toHaveBeenCalledWith('game:g1', 'game:rematch:cancelled', expect.objectContaining({ reason: 'DECLINED', cancelledBy: BOB }));
    await expect(service.request('g1', ALICE)).rejects.toThrow('REMATCH_CANCELLED');
  });

  it('a player who cannot join (e.g. no coins) cancels it and the others are refunded', async () => {
    const { service, rooms, sock } = rematchSetup({ joinFailsFor: BOB });
    await service.request('g1', ALICE);
    const res = await service.request('g1', BOB);
    expect(res).toMatchObject({ status: 'CANCELLED', reason: 'INSUFFICIENT_COINS', cancelledBy: BOB });
    expect(rooms.leaveRoom).toHaveBeenCalledWith(ALICE, 'new-room');
    expect(sock.emitToRoom).toHaveBeenCalledWith('game:g1', 'game:rematch:cancelled', expect.anything());
  });

  it('an expired window starts over on the next tap', async () => {
    const { service, redis } = rematchSetup();
    await service.request('g1', ALICE);
    const meta = JSON.parse(redis.kv.get('game:g1:rematch')!);
    redis.kv.set('game:g1:rematch', JSON.stringify({ ...meta, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const again = await service.request('g1', BOB);
    expect(again).toMatchObject({ status: 'OPEN', acceptedUserIds: [BOB] });
  });

  it('only for finished matches and their players', async () => {
    const { service, redis } = rematchSetup();
    await expect(service.request('g1', CARL)).rejects.toThrow('NOT_AT_TABLE');
    redis.kv.set('game:g1:state', JSON.stringify(gameState(GameStatus.IN_PROGRESS)));
    await expect(service.request('g1', ALICE)).rejects.toThrow('GAME_NOT_FINISHED');
  });
});

// ── Seat card profile in the game state ──────────────────────────────────────

describe('GameEngineService.tableProfileFor', () => {
  const fn = GameEngineService.prototype.tableProfileFor;
  it('returns the stored profile', () => {
    const p = { avatarUrl: 'a.png', country: 'BR', level: 7, clubId: 'c1', clubName: 'Lions', clubIconUrl: null };
    expect(fn.call({}, { profiles: { [ALICE]: p } }, ALICE)).toEqual(p);
  });
  it('is all-null for a state saved before profiles existed', () => {
    expect(fn.call({}, {}, ALICE)).toEqual({ avatarUrl: null, country: null, level: 1, clubId: null, clubName: null, clubIconUrl: null });
  });
});
