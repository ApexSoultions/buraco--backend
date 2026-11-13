import { Module } from '@nestjs/common';
import { IapController } from './iap.controller';
import { IapService } from './iap.service';

@Module({
  controllers: [IapController],
  providers: [IapService],
  exports: [IapService],
})
export class IapModule {}
