import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import configuration from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { S3Module } from './common/s3/s3.module';
import { SocketModule } from './common/socket/socket.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AppThrottlerGuard, clientIp, isSignedIn, trackerFor } from './common/guards/app-throttler.guard';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProfileModule } from './modules/profile/profile.module';
import { StatsModule } from './modules/stats/stats.module';
import { EconomyModule } from './modules/economy/economy.module';
import { MissionsModule } from './modules/missions/missions.module';
import { FriendsModule } from './modules/friends/friends.module';
import { ClubsModule } from './modules/clubs/clubs.module';
import { RankingsModule } from './modules/rankings/rankings.module';
import { ShopModule } from './modules/shop/shop.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MatchmakingModule } from './modules/matchmaking/matchmaking.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { GameEngineModule } from './modules/game-engine/game-engine.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { MatchHistoryModule } from './modules/match-history/match-history.module';
import { AdminModule } from './modules/admin/admin.module';
import { CloudScriptingModule } from './modules/cloud-scripting/cloud-scripting.module';
import { ReconnectionModule } from './modules/reconnection/reconnection.module';
import { MailModule } from './common/mail/mail.module';
import { AppGateway } from './websocket/gateway';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    // The module was configured but its guard was never registered, so no limit (including
    // the stricter @Throttle ones on login / register / password reset) ever applied.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttl = (config.get<number>('throttle.ttl') ?? 60) * 1000;
        return {
          throttlers: [
            { name: 'default', ttl, limit: config.get<number>('throttle.limit') ?? 100 },
            {
              name: 'anon',
              ttl,
              limit: config.get<number>('throttle.anonLimit') ?? 60,
              getTracker: (req: Record<string, any>) => `ip:${clientIp(req)}`,
              skipIf: isSignedIn,
            },
          ],
          getTracker: trackerFor,
        };
      },
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    S3Module,
    SocketModule,
    AuthModule,
    UsersModule,
    ProfileModule,
    StatsModule,
    EconomyModule,
    MissionsModule,
    FriendsModule,
    ClubsModule,
    RankingsModule,
    ShopModule,
    NotificationsModule,
    MatchmakingModule,
    RoomsModule,
    GameEngineModule,
    MessagingModule,
    MatchHistoryModule,
    AdminModule,
    CloudScriptingModule,
    ReconnectionModule,
    MailModule,
  ],
  providers: [
    AppGateway,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // After JwtAuthGuard on purpose: it sets req.user, which the limits are keyed on.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
