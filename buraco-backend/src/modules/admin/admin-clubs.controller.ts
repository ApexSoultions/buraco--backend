import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminClubsService } from './admin-clubs.service';
import { MakeLeaderDto, ReasonDto } from './dto/admin-clubs.dto';

/** Clan moderation. Super admins and moderators. */
@ApiTags('Admin')
@Controller('admin/clubs')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
@ApiBearerAuth()
export class AdminClubsController {
  constructor(private readonly clubs: AdminClubsService) {}

  @Get()
  @ApiOperation({ summary: 'Clans, best first, with their leader (search, mode, type, page)' })
  list(@Query('search') search?: string, @Query('mode') mode?: string, @Query('type') type?: string, @Query('page') page = '1', @Query('limit') limit = '20') {
    return this.clubs.list({ search, mode, type, page: +page, limit: +limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One clan: details, members (with pending requests) and recent news' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.clubs.get(id);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Remove a member (or decline a pending request); the leader cannot be removed' })
  removeMember(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: ReasonDto) {
    return this.clubs.removeMember(adminId, id, userId, dto?.reason);
  }

  @Post(':id/leader')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hand the leadership to another active member (the old leader becomes vice leader)' })
  makeLeader(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MakeLeaderDto) {
    return this.clubs.makeLeader(adminId, id, dto.userId);
  }

  @Post(':id/reset-name')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace an offensive clan name with "Clan" + 6 digits' })
  resetName(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.clubs.resetName(adminId, id, dto?.reason);
  }

  @Delete(':id/icon')
  @ApiOperation({ summary: 'Remove the clan icon' })
  removeIcon(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.clubs.removeIcon(adminId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a clan with its chat; members are told' })
  remove(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.clubs.remove(adminId, id, dto?.reason);
  }
}
