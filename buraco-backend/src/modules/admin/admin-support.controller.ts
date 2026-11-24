import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminSupportService } from './admin-support.service';
import { SupportReplyDto, SupportStatusDto } from './dto/admin-support.dto';

/** Support tickets. All staff roles (this is the Support role's main page). */
@ApiTags('Admin')
@Controller('admin/support')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR, AdminRole.SUPPORT)
@ApiBearerAuth()
export class AdminSupportController {
  constructor(private readonly support: AdminSupportService) {}

  @Get('tickets')
  @ApiOperation({ summary: 'Support tickets (status OPEN / ANSWERED / CLOSED, search, page) with counts' })
  list(@Query('status') status?: string, @Query('search') search?: string, @Query('page') page = '1', @Query('limit') limit = '20') {
    return this.support.list({ status, search, page: +page, limit: +limit });
  }

  @Get('tickets/:id')
  @ApiOperation({ summary: 'One ticket with the player and the whole conversation' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(id);
  }

  @Post('tickets/:id/reply')
  @HttpCode(200)
  @ApiOperation({ summary: 'Answer a ticket: the player gets a game notification and an email' })
  reply(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportReplyDto) {
    return this.support.reply(adminId, id, dto.message);
  }

  @Patch('tickets/:id/status')
  @ApiOperation({ summary: 'Close a ticket, or reopen it' })
  status(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupportStatusDto) {
    return this.support.setStatus(adminId, id, dto.status);
  }
}
