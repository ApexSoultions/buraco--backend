import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { VerifyPurchaseDto } from './dto/verify-purchase.dto';
import { IapService } from './iap.service';

@ApiTags('In-app purchases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('iap')
export class IapController {
  constructor(private readonly iap: IapService) {}

  @Get('products')
  @ApiOperation({ summary: 'Coin packs and subscription plans sold through Google Play / the App Store (IDs, coins or plan, Figma reference price)' })
  products() {
    return this.iap.listProducts();
  }

  @Get('entitlements')
  @ApiOperation({ summary: 'Whether the player has Premium / Voice chat, and until when' })
  entitlements(@CurrentUser('id') userId: string) {
    return this.iap.getEntitlements(userId);
  }

  @Post('verify')
  @ApiOperation({ summary: 'Check a store purchase with Google Play / the App Store and credit its coins once' })
  @ApiResponse({ status: 201, description: '{ granted, alreadyGranted, productId, coinsAdded, balance }. alreadyGranted: this purchase was credited before (safe to confirm).' })
  @ApiResponse({ status: 400, description: 'UNKNOWN_PRODUCT, INVALID_PURCHASE (store says it is not a real, completed purchase) or PURCHASE_BELONGS_TO_ANOTHER_PLAYER' })
  @ApiResponse({ status: 503, description: 'STORE_NOT_CONFIGURED or STORE_UNAVAILABLE: nothing credited, the game keeps the purchase and retries later' })
  verify(@CurrentUser('id') userId: string, @Body() dto: VerifyPurchaseDto) {
    return this.iap.verifyAndGrant(userId, dto);
  }
}
