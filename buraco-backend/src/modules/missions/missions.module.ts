import { Module } from '@nestjs/common';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';
import { AchievementsController } from './achievements.controller';
import { AchievementsService } from './achievements.service';
import { EconomyModule } from '../economy/economy.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [EconomyModule, NotificationsModule],
  controllers: [MissionsController, AchievementsController],
  providers: [MissionsService, AchievementsService],
  exports: [MissionsService, AchievementsService],
})
export class MissionsModule {}
