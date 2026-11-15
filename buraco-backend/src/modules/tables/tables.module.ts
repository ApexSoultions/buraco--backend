import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { GameEngineModule } from '../game-engine/game-engine.module';
import { FriendsModule } from '../friends/friends.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoomInvitesController, TableSocialController } from './tables.controller';
import { TableInvitesService } from './table-invites.service';
import { TableChatService } from './table-chat.service';
import { RematchService } from './rematch.service';

/** Milestone 5 table social: invite a friend to a chair, table chat, rematch. */
@Module({
  imports: [RoomsModule, GameEngineModule, FriendsModule, NotificationsModule],
  controllers: [RoomInvitesController, TableSocialController],
  providers: [TableInvitesService, TableChatService, RematchService],
  exports: [TableChatService, RematchService],
})
export class TablesModule {}
