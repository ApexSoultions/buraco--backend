import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RankingsService } from './rankings.service';

@ApiTags('Rankings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rankings')
export class RankingsController {
  constructor(private readonly rankingsService: RankingsService) {}

  @Get('classic')
  @ApiOperation({ summary: 'Get Classic mode leaderboard (ordered by points earned in Classic matches)' })
  @ApiQuery({ name: 'page',  required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Players per page (default 50)' })
  @ApiResponse({ status: 200, description: 'Ranked player list with current user rank included' })
  getClassicRanking(
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.rankingsService.getClassicRanking(+page, +limit, userId);
  }

  @Get('international')
  @ApiOperation({ summary: 'Get International leaderboard (wins across all modes)' })
  @ApiQuery({ name: 'page',  required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Players per page (default 50)' })
  @ApiResponse({ status: 200, description: 'Ranked player list with current user rank included' })
  getInternationalRanking(
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.rankingsService.getInternationalRanking(+page, +limit, userId);
  }

  @Get('player/:userId')
  @ApiOperation({ summary: "Get a specific player's rank and surrounding leaderboard context" })
  @ApiParam({ name: 'userId', description: 'Player UUID' })
  @ApiQuery({ name: 'type', required: false, enum: ['classic', 'international'], description: 'Ranking type (default: classic)' })
  @ApiResponse({ status: 200, description: 'Player rank detail' })
  @ApiResponse({ status: 404, description: 'Player not found' })
  getPlayerRank(@Param('userId') userId: string, @Query('type') type: string = 'classic') {
    return this.rankingsService.getPlayerRank(userId, type);
  }
}
