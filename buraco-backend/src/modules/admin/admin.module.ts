import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SystemConfigModule } from '../../common/system-config/system-config.module';
import { TablesModule } from '../tables/tables.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminPlayersService } from './admin-players.service';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';
import { AdminEconomyController } from './admin-economy.controller';
import { AdminEconomyService } from './admin-economy.service';

@Module({
  imports: [PrismaModule, JwtModule.register({}), SystemConfigModule, TablesModule],
  controllers: [AdminController, AdminAccountsController, AdminReportsController, AdminEconomyController],
  providers: [AdminService, AdminAccountsService, AdminDashboardService, AdminPlayersService, AdminReportsService, AdminEconomyService],
  exports: [AdminService],
})
export class AdminModule {}
