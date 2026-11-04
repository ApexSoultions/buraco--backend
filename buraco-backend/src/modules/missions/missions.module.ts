import { Module } from '@nestjs/common';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';
import { EconomyModule } from '../economy/economy.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [EconomyModule, NotificationsModule],
  controllers: [MissionsController],
  providers: [MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
