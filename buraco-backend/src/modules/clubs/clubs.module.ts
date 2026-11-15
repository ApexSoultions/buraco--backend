import { Module } from '@nestjs/common';
import { ClubsController } from './clubs.controller';
import { ClubSocialController } from './club-social.controller';
import { ClubsService } from './clubs.service';
import { ClubInvitesService } from './club-invites.service';
import { ClubFeedService } from './club-feed.service';
import { ClubObjectivesService } from './club-objectives.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MissionsModule } from '../missions/missions.module';
import { EconomyModule } from '../economy/economy.module';

@Module({
  imports: [NotificationsModule, MissionsModule, EconomyModule],
  controllers: [ClubsController, ClubSocialController],
  providers: [ClubsService, ClubInvitesService, ClubFeedService, ClubObjectivesService],
  exports: [ClubsService, ClubObjectivesService],
})
export class ClubsModule {}
