import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminBroadcastService } from './admin-broadcast.service';
import { AdminSettingsService } from './admin-settings.service';
import { SendBroadcastDto, SettingValueDto } from './dto/admin-settings.dto';

/** Messages to players (staff) and game settings (super admins). */
@ApiTags('Admin')
@Controller('admin')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@ApiBearerAuth()
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService, private readonly broadcast: AdminBroadcastService) {}

  // ─── Broadcast ───────────────────────────────────────────────────────────────

  @Get('broadcast/audience')
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiOperation({ summary: 'How many players a broadcast reaches' })
  audience() { return this.broadcast.audienceCount(); }

  @Get('broadcast/history')
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiOperation({ summary: 'Latest broadcasts that were sent' })
  history(@Query('limit') limit = '20') { return this.broadcast.history(+limit); }

  @Post('broadcast')
  @AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
  @ApiOperation({ summary: 'Send a message to every active player (the same message twice within 10 minutes is refused)' })
  send(@CurrentUser('id') adminId: string, @Body() dto: SendBroadcastDto) {
    return this.broadcast.send(adminId, dto.title, dto.body);
  }

  // ─── Game settings ───────────────────────────────────────────────────────────

  @Get('settings')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Every game setting: value, whether the game really uses it, and whether a secret is set (never its value)' })
  list() { return this.settings.list(); }

  @Put('settings/:key')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Change one setting (only settings the game uses; the value is checked)' })
  set(@CurrentUser('id') adminId: string, @Param('key') key: string, @Body() dto: SettingValueDto) {
    return this.settings.set(adminId, key, dto.value);
  }
}
