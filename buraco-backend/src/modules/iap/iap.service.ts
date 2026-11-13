import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrencyType, Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { VerifyPurchaseDto } from './dto/verify-purchase.dto';
import { findIapProduct, IAP_PRODUCTS, IapProduct } from './iap.products';
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

  /** Coin packs and subscription plans the game shows (IDs the game asks the store about). */
  listProducts() {
    return IAP_PRODUCTS.map((p) => ({
      productId: p.productId, type: p.type, coins: p.coins, entitlement: p.entitlement ?? null, period: p.period ?? null,
      label: p.label ?? null, saveLabel: p.saveLabel ?? null, referencePriceUsd: p.referencePriceUsd, sortOrder: p.sortOrder,
    }));
  }

  /** When the player's Premium and Voice chat end (null = not active). */
  async getEntitlements(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionStatus: true, subscriptionExpiry: true, voiceChatExpiry: true },
    });
    const now = new Date();
    const premium = !!user && user.subscriptionStatus !== 'FREE' && (!user.subscriptionExpiry || user.subscriptionExpiry > now);
    return {
      isPremium: premium,
      premiumUntil: premium ? user?.subscriptionExpiry ?? null : null,
      hasVoiceChat: !!user?.voiceChatExpiry && user.voiceChatExpiry > now,
      voiceChatUntil: user?.voiceChatExpiry && user.voiceChatExpiry > now ? user.voiceChatExpiry : null,
    };
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

    if (product.type === 'SUBSCRIPTION') return this.grantSubscription(userId, store, product, verified);

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

  /**
   * A subscription is linked to the first player who claims it; renewals of it only move its
   * end date forward. The player's Premium / Voice chat end date is the latest of their plans.
   * Sending the same subscription again is safe (it just refreshes the date).
   */
  private async grantSubscription(userId: string, store: IapStore, product: IapProduct, verified: VerifiedPurchase) {
    const expiresAt = verified.expiresAt;
    if (!expiresAt) throw new BadRequestException({ message: 'INVALID_PURCHASE', detail: 'Subscription has no end date' });
    const originalId = verified.originalId ?? verified.transactionId;

    const existing = await this.prisma.iapSubscription.findUnique({
      where: { store_originalId: { store, originalId } },
      select: { userId: true, expiresAt: true },
    });
    if (existing && existing.userId !== userId) throw new BadRequestException('PURCHASE_BELONGS_TO_ANOTHER_PLAYER');

    const newEnd = existing && existing.expiresAt > expiresAt ? existing.expiresAt : expiresAt;
    await this.prisma.iapSubscription.upsert({
      where: { store_originalId: { store, originalId } },
      create: { userId, store, originalId, productId: product.productId, expiresAt: newEnd },
      update: { productId: product.productId, expiresAt: newEnd },
    });

    // Purchase history (one row per store transaction; a renewal is a new transaction).
    let alreadyGranted = false;
    try {
      await this.prisma.iapPurchase.create({
        data: { userId, store, productId: product.productId, transactionId: verified.transactionId, coins: 0, environment: verified.environment },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      alreadyGranted = true;
    }

    await this.refreshEntitlements(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
    return {
      granted: !alreadyGranted,
      alreadyGranted,
      productId: product.productId,
      coinsAdded: 0,
      balance: { coins: user?.coins ?? 0 },
      expired: newEnd <= new Date(),
      entitlements: await this.getEntitlements(userId),
    };
  }

  /** Sets the player's Premium and Voice chat end dates from their store subscriptions. */
  private async refreshEntitlements(userId: string) {
    const subs = await this.prisma.iapSubscription.findMany({ where: { userId }, select: { productId: true, expiresAt: true } });
    const latest = (entitlement: string) =>
      subs.filter((s) => findIapProduct(s.productId)?.entitlement === entitlement)
        .reduce<Date | null>((max, s) => (!max || s.expiresAt > max ? s.expiresAt : max), null);
    const premiumUntil = latest('PREMIUM');
    const voiceUntil = latest('VOICE_CHAT');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { subscriptionStatus: true, subscriptionExpiry: true } });
    // An admin-given Premium with no end date is kept as it is.
    const adminPremium = user?.subscriptionStatus !== 'FREE' && !user?.subscriptionExpiry;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(premiumUntil && !adminPremium && { subscriptionStatus: 'PREMIUM', subscriptionExpiry: premiumUntil }),
        ...(voiceUntil && { voiceChatExpiry: voiceUntil }),
      },
    });
  }

  private async verifyWithStore(store: IapStore, dto: VerifyPurchaseDto): Promise<VerifiedPurchase> {
    const product = findIapProduct(dto.productId);
    const isSub = product?.type === 'SUBSCRIPTION';
    switch (store) {
      case 'GOOGLE_PLAY':
        return isSub
          ? this.google.verifySubscription(dto.productId, dto.purchaseToken ?? '')
          : this.google.verify(dto.productId, dto.purchaseToken ?? '');
      case 'APPLE':
        return this.apple.verify(dto.productId, dto.signedTransaction ?? '');
      case 'FAKE':
        if (!this.allowFake) throw new StoreVerifyError('INVALID_PURCHASE', 'Test purchases are not accepted here');
        if (!dto.transactionId) throw new StoreVerifyError('INVALID_PURCHASE', 'Missing transaction ID');
        return {
          transactionId: dto.transactionId, productId: dto.productId, environment: 'fake',
          originalId: dto.transactionId,
          expiresAt: isSub ? addPeriod(new Date(), product?.period ?? 'P1M') : undefined,
        };
      default:
        throw new StoreVerifyError('INVALID_PURCHASE', 'Unknown store');
    }
  }
}

/** Adds an ISO 8601 period (P1W, P1M, P3M, P6M, P1Y) to a date. */
export function addPeriod(from: Date, period: string): Date {
  const m = /^P(\d+)([WMY])$/.exec(period);
  const d = new Date(from);
  if (!m) return d;
  const n = Number(m[1]);
  if (m[2] === 'W') d.setUTCDate(d.getUTCDate() + 7 * n);
  if (m[2] === 'M') d.setUTCMonth(d.getUTCMonth() + n);
  if (m[2] === 'Y') d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}
