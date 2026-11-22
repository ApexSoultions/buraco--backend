import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminAccountsService } from './admin-accounts.service';
import { ChangeAdminPasswordDto, CreateAdminDto, UpdateAdminDto } from './dto/admin-accounts.dto';

/** The admin panel's own accounts (see AdminAccountsService). Same guards as AdminController. */
@ApiTags('Admin')
@Controller('admin')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard)
@ApiBearerAuth()
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Get('me')
  @ApiOperation({ summary: 'The logged-in admin (name, email, role)' })
  me(@CurrentUser('id') adminId: string) {
    return this.accounts.me(adminId);
  }

  @Patch('auth/password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Change your own admin password' })
  changePassword(@CurrentUser('id') adminId: string, @Body() dto: ChangeAdminPasswordDto) {
    return this.accounts.changePassword(adminId, dto);
  }

  @Get('admins')
  @UseGuards(AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'All admin accounts (super admin)' })
  list() {
    return this.accounts.list();
  }

  @Post('admins')
  @UseGuards(AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Add an admin account (super admin)' })
  create(@CurrentUser('id') actorId: string, @Body() dto: CreateAdminDto) {
    return this.accounts.create(actorId, dto);
  }

  @Patch('admins/:adminId')
  @UseGuards(AdminRolesGuard)
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Change an admin: name, role, on/off, new password (super admin)' })
  update(@CurrentUser('id') actorId: string, @Param('adminId') adminId: string, @Body() dto: UpdateAdminDto) {
    return this.accounts.update(actorId, adminId, dto);
  }
}
