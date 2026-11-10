import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

// A wrong current password used to be a 401, which the app treats as an expired login
// (refresh, retry, then log the player out). It is a 400 now.
describe('AuthService.changePassword', () => {
  it('rejects a wrong current password with 400, not 401', async () => {
    const hash = await bcrypt.hash('Right123', 4);
    const prisma = { user: { findUnique: jest.fn(async () => ({ id: 'u1', passwordHash: hash })), update: jest.fn() } };
    const service = Object.create(AuthService.prototype) as AuthService;
    (service as any).prisma = prisma;

    await expect(service.changePassword('u1', { currentPassword: 'Wrong123', newPassword: 'Newpass123' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('saves a new hash when the current password is right', async () => {
    const hash = await bcrypt.hash('Right123', 4);
    const prisma = { user: { findUnique: jest.fn(async () => ({ id: 'u1', passwordHash: hash })), update: jest.fn(async () => ({})) } };
    const service = Object.create(AuthService.prototype) as AuthService;
    (service as any).prisma = prisma;

    await service.changePassword('u1', { currentPassword: 'Right123', newPassword: 'Newpass123' });
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});
