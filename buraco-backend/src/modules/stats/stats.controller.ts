import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StatsService } from './stats.service';

@ApiTags('Stats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get own player stats (level, wins, points, streak …)' })
  @ApiResponse({ status: 200, description: 'Stats object returned' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getMyStats(@CurrentUser('id') userId: string) {
    return this.statsService.getStats(userId);
  }

  // Before ':userId', so "levels" isn't read as a player id.
  @Get('levels')
  @ApiOperation({ summary: 'Level List: XP each level needs and the total XP to reach it, plus my level' })
  @ApiQuery({ name: 'upTo', required: false, type: Number, description: 'Last level to list (default 50, max 200)' })
  getLevels(@CurrentUser('id') userId: string, @Query('upTo') upTo = 50) {
    return this.statsService.levelTable(+upTo, userId);
  }

  @Get(':userId')
  @ApiOperation({ summary: "Get another player's stats" })
  @ApiParam({ name: 'userId', description: 'Target player UUID' })
  @ApiResponse({ status: 200, description: 'Stats object returned' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Player not found' })
  getStats(@Param('userId') userId: string) {
    return this.statsService.getStats(userId);
  }
}
