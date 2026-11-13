import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../../common/system-config/system-config.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { SpecialModule } from '../special/special.module';

@Module({
  imports: [SystemConfigModule, SpecialModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
