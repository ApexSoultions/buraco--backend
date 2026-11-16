import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrencyType, ShopCategory } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShopService } from './shop.service';

@ApiTags('Shop')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shop')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Get shop catalog. Optionally filter by category.' })
  @ApiQuery({ name: 'category', required: false, enum: ShopCategory, description: 'Filter items by category' })
  @ApiResponse({ status: 200, description: 'Array of shop items with ownership status per item' })
  getCatalog(@CurrentUser('id') userId: string, @Query('category') category?: ShopCategory) {
    return this.shopService.getCatalog(category, userId);
  }

  @Get('item/:itemId')
  @ApiOperation({ summary: 'Get single shop item detail' })
  @ApiParam({ name: 'itemId', description: 'Shop item UUID' })
  @ApiResponse({ status: 200, description: 'Item detail' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  getItem(@Param('itemId') itemId: string) {
    return this.shopService.getItemById(itemId);
  }

  @Post('purchase')
  @ApiOperation({ summary: 'Purchase a shop item with coins or diamonds' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        itemId:   { type: 'string', description: 'Shop item UUID' },
        currency: { type: 'string', enum: Object.values(CurrencyType), description: 'Payment currency' },
      },
      required: ['itemId', 'currency'],
    },
  })
  @ApiResponse({ status: 201, description: 'Purchase successful, item added to inventory' })
  @ApiResponse({ status: 400, description: 'Insufficient balance or item not available for that currency' })
  @ApiResponse({ status: 409, description: 'Item already owned (non-consumable)' })
  purchaseItem(
    @CurrentUser('id') userId: string,
    @Body('itemId') itemId: string,
    @Body('currency') currency: CurrencyType,
  ) {
    return this.shopService.purchaseItem(userId, itemId, currency);
  }

  @Get('inventory')
  @ApiOperation({ summary: 'Get own inventory (all purchased items)' })
  @ApiResponse({ status: 200, description: 'Inventory array with equip status per item' })
  getInventory(@CurrentUser('id') userId: string) {
    return this.shopService.getInventory(userId);
  }

  @Put('inventory/:itemId/equip')
  @ApiOperation({ summary: 'Equip an owned cosmetic item' })
  @ApiParam({ name: 'itemId', description: 'Shop item UUID (must be owned)' })
  @ApiResponse({ status: 200, description: 'Item equipped' })
  @ApiResponse({ status: 403, description: 'Item not owned' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  equipItem(@CurrentUser('id') userId: string, @Param('itemId') itemId: string) {
    return this.shopService.equipItem(userId, itemId);
  }

  @Put('equip-default/:category')
  @ApiOperation({ summary: 'Back to the default card back / table colour / emoji set: unequip that category' })
  @ApiParam({ name: 'category', enum: ['CARDS', 'TABLES', 'EMOJIS'] })
  @ApiResponse({ status: 200, description: '{ category, equipped: null }' })
  @ApiResponse({ status: 400, description: 'INVALID_CATEGORY' })
  equipDefault(@CurrentUser('id') userId: string, @Param('category') category: string) {
    return this.shopService.equipDefault(userId, category);
  }

  @Get('equipped')
  @ApiOperation({ summary: 'Get all currently equipped cosmetics' })
  @ApiResponse({ status: 200, description: 'Map of category → equipped item' })
  getEquipped(@CurrentUser('id') userId: string) {
    return this.shopService.getEquipped(userId);
  }

  @Post('redeem')
  @ApiOperation({ summary: 'Redeem a promo code for coins, diamonds, or items' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Promo code (case-insensitive)' } },
      required: ['code'],
    },
  })
  @ApiResponse({ status: 201, description: 'Code redeemed, rewards applied' })
  @ApiResponse({ status: 400, description: 'Code expired, maxed-out, or already used by this player' })
  @ApiResponse({ status: 404, description: 'Code not found' })
  redeemCode(@CurrentUser('id') userId: string, @Body('code') code: string) {
    return this.shopService.redeemCode(userId, code);
  }
}
