import { Module } from '@nestjs/common';
import { GameEngineController } from './game-engine.controller';
import { GameEngineService } from './game-engine.service';
import { EconomyModule } from '../economy/economy.module';
import { StatsModule } from '../stats/stats.module';
import { MissionsModule } from '../missions/missions.module';

@Module({
  imports: [EconomyModule, StatsModule, MissionsModule],
  controllers: [GameEngineController],
  providers: [GameEngineService],
  exports: [GameEngineService],
})
export class GameEngineModule {}
