import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtGuard } from '../../common/guards/admin-jwt.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminEconomyService } from './admin-economy.service';
import { UpdatePromoDto, UpdateShopItemDto } from './dto/admin-economy.dto';

/** Economy: shop prices, promo codes, store purchases. Super admins only. */
@ApiTags('Admin')
@Controller('admin/economy')
@Public()
@SkipThrottle({ anon: true })
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN)
@ApiBearerAuth()
export class AdminEconomyController {
  constructor(private readonly economy: AdminEconomyService) {}

  @Get('items')
  @ApiOperation({ summary: 'All shop items with price, status and how many players own them (optional ?category=)' })
  items(@Query('category') category?: string) {
    return this.economy.listItems(category);
  }

  @Patch('items/:id')
  @ApiOperation({ summary: 'Change an item: name, description, prices, active, order' })
  updateItem(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateShopItemDto) {
    return this.economy.updateItem(adminId, id, dto);
  }

  @Get('price-backup')
  @ApiOperation({ summary: 'Items whose price differs from the saved real prices (Live only)' })
  priceBackup() {
    return this.economy.priceBackup();
  }

  @Post('price-backup/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Put the saved real prices back on every item' })
  restore(@CurrentUser('id') adminId: string) {
    return this.economy.restorePrices(adminId);
  }

  @Patch('promos/:id')
  @ApiOperation({ summary: 'Change a promo code: rewards, limit, expiry, active' })
  updatePromo(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromoDto) {
    return this.economy.updatePromo(adminId, id, dto);
  }

  @Delete('promos/:id')
  @ApiOperation({ summary: 'Delete a promo code nobody has used' })
  deletePromo(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.economy.deletePromo(adminId, id);
  }

  @Get('promos/:id/redemptions')
  @ApiOperation({ summary: 'Who redeemed a promo code (latest 200)' })
  redemptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.economy.promoRedemptions(id);
  }

  @Get('purchases')
  @ApiOperation({ summary: 'Real-money store purchases (Google Play / App Store), with totals' })
  purchases(@Query('store') store?: string, @Query('search') search?: string, @Query('page') page = '1', @Query('limit') limit = '20') {
    return this.economy.purchases({ store, search, page: +page, limit: +limit });
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'Store subscriptions (Premium, Voice chat) and whether they are still active' })
  subscriptions(@Query('page') page = '1', @Query('limit') limit = '20') {
    return this.economy.subscriptions({ page: +page, limit: +limit });
  }
}
