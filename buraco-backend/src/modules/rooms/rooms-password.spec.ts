import { ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { RoomsService, publicRoom } from './rooms.service';

// Create Table "Password": the hash never leaves the server, and joining a private
// table needs the password unless the player was invited (trusted).
function setup(passwordHash: string | null) {
  const prisma = {
    room: { findUnique: jest.fn(async (): Promise<any> => ({ passwordHash })), findMany: jest.fn(async () => []) },
  };
  const redis = { del: jest.fn() };
  const service = new RoomsService(prisma as any, {} as any, {} as any, redis as any, {} as any);
  return { service, prisma };
}

describe('Room password', () => {
  it('publicRoom hides the hash and reports hasPassword', () => {
    expect(publicRoom({ id: 'r', passwordHash: 'x' } as any)).toEqual({ id: 'r', hasPassword: true });
    expect(publicRoom({ id: 'r', passwordHash: null } as any)).toEqual({ id: 'r', hasPassword: false });
  });

  it('asks for the password, refuses a wrong one', async () => {
    const hash = await bcrypt.hash('1234', 4);
    const { service } = setup(hash);
    await expect(service.joinRoom('u', 'r')).rejects.toThrow('PASSWORD_REQUIRED');
    await expect(service.joinRoom('u', 'r', undefined, { password: '9999' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the right password and invited players past the check', async () => {
    const hash = await bcrypt.hash('1234', 4);
    for (const opts of [{ password: '1234' }, { trusted: true }]) {
      const { service, prisma } = setup(hash);
      // Past the check the service goes on to look the room up again; stop there.
      prisma.room.findUnique.mockResolvedValueOnce({ passwordHash: hash }).mockResolvedValueOnce(null);
      await expect(service.joinRoom('u', 'r', undefined, opts)).rejects.toThrow('Room not found');
    }
  });
});
