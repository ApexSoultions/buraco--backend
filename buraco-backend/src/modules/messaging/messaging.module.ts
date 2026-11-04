import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { FriendsModule } from '../friends/friends.module';
import { MissionsModule } from '../missions/missions.module';

@Module({
  imports: [FriendsModule, MissionsModule],
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
