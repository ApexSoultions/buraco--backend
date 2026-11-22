import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeAdminPasswordDto, CreateAdminDto, UpdateAdminDto } from './dto/admin-accounts.dto';

const SAFE = { id: true, email: true, name: true, role: true, isActive: true, createdAt: true, lastLoginAt: true } as const;

/**
 * The admin panel's own accounts: who is logged in, changing your password, and (super admins
 * only) adding staff, changing their role or switching an account off. Two rules keep the panel
 * usable: nobody can switch off or demote themselves, and there is always one active super admin.
 * Every change goes to the audit log.
 */
@Injectable()
export class AdminAccountsService {
  constructor(private prisma: PrismaService) {}

  async me(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: SAFE });
    if (!admin) throw new NotFoundException('ADMIN_NOT_FOUND');
    return admin;
  }

  async changePassword(adminId: string, dto: ChangeAdminPasswordDto) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('ADMIN_NOT_FOUND');
    if (!(await bcrypt.compare(dto.currentPassword, admin.passwordHash))) {
      throw new UnauthorizedException('WRONG_PASSWORD');
    }
    if (dto.currentPassword === dto.newPassword) throw new BadRequestException('SAME_PASSWORD');
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });
    await this.audit(adminId, 'CHANGE_OWN_PASSWORD', adminId, {});
    return { changed: true };
  }

  list() {
    return this.prisma.adminUser.findMany({ select: SAFE, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
  }

  async create(actorId: string, dto: CreateAdminDto) {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.adminUser.findUnique({ where: { email } })) {
      throw new ConflictException('EMAIL_IN_USE');
    }
    const admin = await this.prisma.adminUser.create({
      data: { email, name: dto.name.trim(), role: dto.role, passwordHash: await bcrypt.hash(dto.password, 12) },
      select: SAFE,
    });
    await this.audit(actorId, 'CREATE_ADMIN', admin.id, { email, role: dto.role });
    return admin;
  }

  async update(actorId: string, adminId: string, dto: UpdateAdminDto) {
    const target = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!target) throw new NotFoundException('ADMIN_NOT_FOUND');

    const self = actorId === adminId;
    if (self && dto.isActive === false) throw new BadRequestException('CANNOT_DISABLE_SELF');
    if (self && dto.role && dto.role !== target.role) throw new BadRequestException('CANNOT_CHANGE_OWN_ROLE');

    // Removing an active super admin (switch off or demote) must leave another one.
    const losesSuper = target.role === AdminRole.SUPER_ADMIN && target.isActive &&
      (dto.isActive === false || (dto.role !== undefined && dto.role !== AdminRole.SUPER_ADMIN));
    if (losesSuper) {
      const supers = await this.prisma.adminUser.count({ where: { role: AdminRole.SUPER_ADMIN, isActive: true } });
      if (supers <= 1) throw new BadRequestException('LAST_SUPER_ADMIN');
    }

    const data: { name?: string; role?: AdminRole; isActive?: boolean; passwordHash?: string } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.password !== undefined) data.passwordHash = await bcrypt.hash(dto.password, 12);

    const admin = await this.prisma.adminUser.update({ where: { id: adminId }, data, select: SAFE });
    // Never log the password itself; only that it was reset.
    const { password, ...logged } = dto;
    await this.audit(actorId, 'UPDATE_ADMIN', adminId, { ...logged, passwordReset: password !== undefined });
    return admin;
  }

  private async audit(adminId: string, action: string, targetId: string, details: object) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType: 'AdminUser', targetId, details } });
  }
}
