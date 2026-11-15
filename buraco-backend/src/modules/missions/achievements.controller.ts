import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AchievementsService } from './achievements.service';

@ApiTags('Achievements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('achievements')
export class AchievementsController {
  constructor(private readonly achievements: AchievementsService) {}

  @Get()
  @ApiOperation({ summary: 'All lifetime achievements with my progress (ready to claim first)' })
  list(@CurrentUser('id') userId: string) {
    return this.achievements.list(userId);
  }

  @Post(':achievementId/claim')
  @ApiOperation({ summary: 'Claim a completed achievement (once)' })
  @ApiResponse({ status: 400, description: 'ACHIEVEMENT_NOT_COMPLETED or REWARD_ALREADY_CLAIMED' })
  claim(@CurrentUser('id') userId: string, @Param('achievementId', new ParseUUIDPipe()) achievementId: string) {
    return this.achievements.claim(userId, achievementId);
  }
}
