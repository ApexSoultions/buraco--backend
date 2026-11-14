import { Module } from '@nestjs/common';
import { SpecialController } from './special.controller';
import { SpecialService } from './special.service';
import { CustomCardsService } from './custom-cards.service';
import { AdminCustomCardsController } from './admin-custom-cards.controller';

@Module({
  controllers: [SpecialController, AdminCustomCardsController],
  providers: [SpecialService, CustomCardsService],
  exports: [SpecialService, CustomCardsService],
})
export class SpecialModule {}
