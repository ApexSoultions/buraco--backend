import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminContentService } from './admin-content.service';
import {
  CreateAchievementDto, CreateClubObjectiveDto, UpdateAchievementDto, UpdateClubObjectiveDto,
} from './dto/admin-content.dto';

/** Game content: achievements, weekly clan objectives, level table. Super admins only. */
@ApiTags('Admin')
@Controller('admin/content')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN)
@ApiBearerAuth()
export class AdminContentController {
  constructor(private readonly content: AdminContentService) {}

  @Get('achievements')
  @ApiOperation({ summary: 'All achievements with how many players completed / claimed each' })
  achievements() { return this.content.listAchievements(); }

  @Post('achievements')
  @ApiOperation({ summary: 'Create an achievement' })
  createAchievement(@CurrentUser('id') adminId: string, @Body() dto: CreateAchievementDto) {
    return this.content.createAchievement(adminId, dto);
  }

  @Patch('achievements/:id')
  @ApiOperation({ summary: 'Change an achievement (also switch it on / off with isActive)' })
  updateAchievement(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAchievementDto) {
    return this.content.updateAchievement(adminId, id, dto);
  }

  @Delete('achievements/:id')
  @ApiOperation({ summary: 'Delete an achievement nobody has progress on' })
  deleteAchievement(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.deleteAchievement(adminId, id);
  }

  @Get('objectives')
  @ApiOperation({ summary: 'Weekly clan objectives with how often clans completed each' })
  objectives() { return this.content.listObjectives(); }

  @Post('objectives')
  @ApiOperation({ summary: 'Create a weekly clan objective' })
  createObjective(@CurrentUser('id') adminId: string, @Body() dto: CreateClubObjectiveDto) {
    return this.content.createObjective(adminId, dto);
  }

  @Patch('objectives/:id')
  @ApiOperation({ summary: 'Change a clan objective (also switch it on / off with isActive)' })
  updateObjective(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClubObjectiveDto) {
    return this.content.updateObjective(adminId, id, dto);
  }

  @Delete('objectives/:id')
  @ApiOperation({ summary: 'Delete a clan objective no clan has progress on' })
  deleteObjective(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.deleteObjective(adminId, id);
  }

  @Get('levels')
  @ApiOperation({ summary: 'Level table: XP per level and how many players are at each level' })
  levels(@Query('upTo') upTo = '50') { return this.content.levels(+upTo); }
}
