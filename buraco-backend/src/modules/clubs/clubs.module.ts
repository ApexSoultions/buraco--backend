import { Module } from '@nestjs/common';
import { ClubsController } from './clubs.controller';
import { ClubsService } from './clubs.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MissionsModule } from '../missions/missions.module';

@Module({
  imports: [NotificationsModule, MissionsModule],
  controllers: [ClubsController],
  providers: [ClubsService],
  exports: [ClubsService],
})
export class ClubsModule {}
