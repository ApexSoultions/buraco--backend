import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrencyType, Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { VerifyPurchaseDto } from './dto/verify-purchase.dto';
import { findIapProduct, IAP_PRODUCTS } from './iap.products';
import { AppleVerifier, GooglePlayVerifier, StoreVerifyError, VerifiedPurchase } from './store-verifier';

export type IapStore = 'GOOGLE_PLAY' | 'APPLE' | 'FAKE';

@Injectable()
export class IapService {
  private readonly google: GooglePlayVerifier;
  private readonly apple: AppleVerifier;
  private readonly allowFake: boolean;

  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    this.google = new GooglePlayVerifier(
      config.get<string>('iap.googlePackageName') ?? '',
      config.get<string>('iap.googleServiceAccount') ?? '',
    );
    this.apple = new AppleVerifier(config.get<string>('iap.appleBundleId') ?? '', config.get<string>('iap.appleRootSha256') || undefined);
    // Unity's editor "fake store" purchases: never accepted in production.
    this.allowFake = config.get<boolean>('iap.allowFake') === true && config.get<string>('nodeEnv') !== 'production';
  }

  /** The coin packs the game shows (IDs the game asks the store about). */
  listProducts() {
    return IAP_PRODUCTS.map((p) => ({ productId: p.productId, type: p.type, coins: p.coins, referencePriceUsd: p.referencePriceUsd, sortOrder: p.sortOrder }));
  }

  /**
   * Checks a store purchase and credits its coins once.
   * The same store transaction sent again (app restarted before confirming) returns
   * alreadyGranted with no second credit, so the game can confirm it with the store.
   */
  async verifyAndGrant(userId: string, dto: VerifyPurchaseDto) {
    const product = findIapProduct(dto.productId);
    if (!product) throw new BadRequestException('UNKNOWN_PRODUCT');

    const store = dto.store as IapStore;
    let verified: VerifiedPurchase;
    try {
      verified = await this.verifyWithStore(store, dto);
    } catch (err) {
      if (err instanceof StoreVerifyError) {
        if (err.code === 'INVALID_PURCHASE') throw new BadRequestException({ message: 'INVALID_PURCHASE', detail: err.message });
        throw new ServiceUnavailableException({ message: err.code, detail: err.message });
      }
      throw err;
    }

    try {
      const coins = await this.prisma.$transaction(async (tx) => {
        await tx.iapPurchase.create({
          data: {
            userId, store, productId: product.productId, transactionId: verified.transactionId,
            coins: product.coins, environment: verified.environment,
          },
        });
        const user = await tx.user.update({ where: { id: userId }, data: { coins: { increment: product.coins } }, select: { coins: true } });
        await tx.transaction.create({
          data: {
            userId, type: TransactionType.IAP_PURCHASE, currency: CurrencyType.COINS, amount: product.coins,
            balanceBefore: user.coins - product.coins, balanceAfter: user.coins,
            referenceId: verified.transactionId, description: `Store purchase: ${product.productId}`,
          },
        });
        return user.coins;
      });
      return { granted: true, alreadyGranted: false, productId: product.productId, coinsAdded: product.coins, balance: { coins } };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.iapPurchase.findUnique({
          where: { store_transactionId: { store, transactionId: verified.transactionId } },
          select: { userId: true },
        });
        if (existing && existing.userId !== userId) throw new BadRequestException('PURCHASE_BELONGS_TO_ANOTHER_PLAYER');
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
        return { granted: false, alreadyGranted: true, productId: product.productId, coinsAdded: 0, balance: { coins: user?.coins ?? 0 } };
      }
      throw err;
    }
  }

  private async verifyWithStore(store: IapStore, dto: VerifyPurchaseDto): Promise<VerifiedPurchase> {
    switch (store) {
      case 'GOOGLE_PLAY':
        return this.google.verify(dto.productId, dto.purchaseToken ?? '');
      case 'APPLE':
        return this.apple.verify(dto.productId, dto.signedTransaction ?? '');
      case 'FAKE':
        if (!this.allowFake) throw new StoreVerifyError('INVALID_PURCHASE', 'Test purchases are not accepted here');
        if (!dto.transactionId) throw new StoreVerifyError('INVALID_PURCHASE', 'Missing transaction ID');
        return { transactionId: dto.transactionId, productId: dto.productId, environment: 'fake' };
      default:
        throw new StoreVerifyError('INVALID_PURCHASE', 'Unknown store');
    }
  }
}
