import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GlobalChatService } from '../tables/global-chat.service';
import { AdminReportsService } from './admin-reports.service';
import { BanFromReportDto, RemoveGlobalChatDto, ReportStatusDto } from './dto/admin-reports.dto';

/** Moderation: player reports and Global Chat. Super admins and moderators. */
@ApiTags('Admin')
@Controller('admin')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.MODERATOR)
@ApiBearerAuth()
export class AdminReportsController {
  constructor(
    private readonly reports: AdminReportsService,
    private readonly globalChat: GlobalChatService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('reports')
  @ApiOperation({ summary: 'Player reports (status OPEN / REVIEWED / DISMISSED; userId = against one player)' })
  list(@Query('status') status?: string, @Query('page') page = '1', @Query('limit') limit = '20', @Query('userId') userId?: string) {
    return this.reports.list({ status, page: +page, limit: +limit, userId });
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'One report with the reported message and the conversation around it' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(id);
  }

  @Patch('reports/:id')
  @ApiOperation({ summary: 'Close (REVIEWED / DISMISSED) or reopen (OPEN) a report' })
  setStatus(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportStatusDto) {
    return this.reports.setStatus(adminId, id, dto.status, dto.resolution);
  }

  @Post('reports/:id/ban')
  @ApiOperation({ summary: 'Ban the reported player and close all open reports against them' })
  ban(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BanFromReportDto) {
    return this.reports.banFromReport(adminId, id, dto.reason);
  }

  // ─── Global Chat ─────────────────────────────────────────────────────────────

  @Get('global-chat')
  @ApiOperation({ summary: 'The current Global Chat (last 50 messages)' })
  globalChatList() {
    return this.globalChat.adminList();
  }

  @Post('global-chat/remove')
  @ApiOperation({ summary: 'Remove one message (messageId) or all messages of one player (userId)' })
  async globalChatRemove(@CurrentUser('id') adminId: string, @Body() dto: RemoveGlobalChatDto) {
    const result = await this.globalChat.adminRemove(dto);
    await this.prisma.adminAuditLog.create({ data: { adminId, action: 'GLOBAL_CHAT_REMOVE', targetType: 'GlobalChat', targetId: dto.messageId ?? dto.userId ?? '', details: { ...dto, removed: result.removed } } });
    return result;
  }

  @Delete('global-chat')
  @ApiOperation({ summary: 'Empty Global Chat for everyone' })
  async globalChatClear(@CurrentUser('id') adminId: string) {
    const result = await this.globalChat.adminClearAll();
    await this.prisma.adminAuditLog.create({ data: { adminId, action: 'GLOBAL_CHAT_CLEAR', targetType: 'GlobalChat', targetId: 'all', details: { removed: result.removed } } });
    return result;
  }
}
