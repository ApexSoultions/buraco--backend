import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { AdminAuditService } from './admin-audit.service';

/** Audit log. Super admins only. */
@ApiTags('Admin')
@Controller('admin/audit-logs')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN)
@ApiBearerAuth()
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  @ApiOperation({ summary: 'Audit log with filters: group, adminId, action, q (words), from / to (YYYY-MM-DD)' })
  list(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('group') group?: string,
    @Query('adminId') adminId?: string,
    @Query('action') action?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.audit.list({ page: +page, limit: +limit, group, adminId, action, q, from, to });
  }
}
