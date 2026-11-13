import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createPrivateKey, sign, X509Certificate } from 'crypto';
import { Prisma } from '@prisma/client';
import { addPeriod, IapService } from './iap.service';
import { AppleVerifier, StoreVerifyError } from './store-verifier';
import { TEST_LEAF_B64, TEST_LEAF_KEY_PEM, TEST_ROOT_B64 } from './test-certs.fixture';

// Coin packs are bought with real money, so coins are only given after the store confirms
// the purchase, and each store transaction can only credit once.
const ROOT_SHA = createHash('sha256').update(new X509Certificate(Buffer.from(TEST_ROOT_B64, 'base64')).raw).digest('hex');
const BUNDLE = 'com.test.game';

function jws(payload: object, opts: { tamper?: boolean } = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: [TEST_LEAF_B64, TEST_ROOT_B64] })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key: createPrivateKey(TEST_LEAF_KEY_PEM), dsaEncoding: 'ieee-p1363' });
  if (opts.tamper) sig[0] ^= 0xff;
  return `${h}.${p}.${sig.toString('base64url')}`;
}

const tx = (over: object = {}) => ({ bundleId: BUNDLE, productId: 'coins_1000', transactionId: 't-1', environment: 'Sandbox', ...over });

describe('AppleVerifier', () => {
  const apple = new AppleVerifier(BUNDLE, ROOT_SHA);

  it('accepts a transaction signed through the pinned root', () => {
    expect(apple.verify('coins_1000', jws(tx()))).toMatchObject({ transactionId: 't-1', productId: 'coins_1000', environment: 'Sandbox', originalId: 't-1' });
  });

  it('refuses a changed signature, another app, another product, a refund, or a non-Apple root', () => {
    const bad = (fn: () => unknown) => expect(fn).toThrow(StoreVerifyError);
    bad(() => apple.verify('coins_1000', jws(tx(), { tamper: true })));
    bad(() => apple.verify('coins_1000', jws(tx({ bundleId: 'com.other.app' }))));
    bad(() => apple.verify('coins_50000', jws(tx())));
    bad(() => apple.verify('coins_1000', jws(tx({ revocationDate: 1 }))));
    bad(() => new AppleVerifier(BUNDLE).verify('coins_1000', jws(tx()))); // real Apple root pinned
    bad(() => apple.verify('coins_1000', 'not-a-jws'));
  });
});

function setup(env: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { 'iap.appleBundleId': BUNDLE, 'iap.appleRootSha256': ROOT_SHA, 'iap.allowFake': true, nodeEnv: 'development', ...env };
  const config = { get: jest.fn((k: string) => values[k]) };
  const rows = new Map<string, { userId: string }>();
  let coins = 100;
  const txClient = {
    iapPurchase: {
      create: jest.fn(async ({ data }: any) => {
        const key = `${data.store}:${data.transactionId}`;
        if (rows.has(key)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        rows.set(key, { userId: data.userId });
        return data;
      }),
    },
    user: { update: jest.fn(async ({ data }: any) => { coins += data.coins.increment; return { coins }; }) },
    transaction: { create: jest.fn(async () => ({})) },
  };
  const subs = new Map<string, { userId: string; productId: string; expiresAt: Date }>();
  const user = { subscriptionStatus: 'FREE', subscriptionExpiry: null as Date | null, voiceChatExpiry: null as Date | null };
  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(txClient)),
    iapPurchase: {
      findUnique: jest.fn(async ({ where }: any) => rows.get(`${where.store_transactionId.store}:${where.store_transactionId.transactionId}`) ?? null),
      create: txClient.iapPurchase.create,
    },
    iapSubscription: {
      findUnique: jest.fn(async ({ where }: any) => subs.get(`${where.store_originalId.store}:${where.store_originalId.originalId}`) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.store_originalId.store}:${where.store_originalId.originalId}`;
        const row = subs.get(key);
        subs.set(key, row ? { ...row, ...update } : create);
      }),
      findMany: jest.fn(async ({ where }: any) => [...subs.values()].filter((r) => r.userId === where.userId)),
    },
    user: {
      findUnique: jest.fn(async () => ({ coins, ...user })),
      update: jest.fn(async ({ data }: any) => Object.assign(user, data)),
    },
  };
  return { service: new IapService(prisma as any, config as any), coins: () => coins, user };
}

describe('IapService.verifyAndGrant', () => {
  it('credits an Apple purchase once; the same transaction again is alreadyGranted', async () => {
    const { service, coins } = setup();
    const first = await service.verifyAndGrant('u1', { store: 'APPLE', productId: 'coins_1000', signedTransaction: jws(tx()) });
    const again = await service.verifyAndGrant('u1', { store: 'APPLE', productId: 'coins_1000', signedTransaction: jws(tx()) });
    expect(first).toMatchObject({ granted: true, coinsAdded: 1000, balance: { coins: 1100 } });
    expect(again).toMatchObject({ granted: false, alreadyGranted: true, coinsAdded: 0 });
    expect(coins()).toBe(1100);
  });

  it('refuses a purchase another player already used', async () => {
    const { service } = setup();
    await service.verifyAndGrant('u1', { store: 'FAKE', productId: 'coins_1000', transactionId: 'x' });
    await expect(service.verifyAndGrant('u2', { store: 'FAKE', productId: 'coins_1000', transactionId: 'x' })).rejects.toThrow(BadRequestException);
  });

  it('refuses unknown products and invalid purchases (nothing credited)', async () => {
    const { service, coins } = setup();
    await expect(service.verifyAndGrant('u1', { store: 'FAKE', productId: 'gems_1', transactionId: 'x' })).rejects.toThrow(BadRequestException);
    await expect(service.verifyAndGrant('u1', { store: 'APPLE', productId: 'coins_1000', signedTransaction: jws(tx(), { tamper: true }) })).rejects.toThrow(BadRequestException);
    expect(coins()).toBe(100);
  });

  it('never accepts editor test purchases in production', async () => {
    const { service } = setup({ nodeEnv: 'production' });
    await expect(service.verifyAndGrant('u1', { store: 'FAKE', productId: 'coins_1000', transactionId: 'x' })).rejects.toThrow(BadRequestException);
  });

  it('answers 503 (game retries later, nothing credited) while Google is not set up', async () => {
    const { service, coins } = setup({ 'iap.googlePackageName': 'com.test', 'iap.googleServiceAccount': '' });
    await expect(service.verifyAndGrant('u1', { store: 'GOOGLE_PLAY', productId: 'coins_1000', purchaseToken: 'tok' })).rejects.toThrow(ServiceUnavailableException);
    expect(coins()).toBe(100);
  });

  it('lists the 7 coin packs in Figma order and the 7 plans', () => {
    const list = setup().service.listProducts();
    expect(list.filter((p) => p.type === 'CONSUMABLE').map((p) => p.productId)).toEqual(['coins_50000', 'coins_25000', 'coins_10000', 'coins_5000', 'coins_3000', 'coins_2000', 'coins_1000']);
    expect(list.filter((p) => p.type === 'SUBSCRIPTION')).toHaveLength(7);
  });
});

describe('IapService — subscriptions', () => {
  const later = (days: number) => Date.now() + days * 86400000;

  it('a Premium plan sets Premium until the store end date; a renewal moves it forward', async () => {
    const { service, user } = setup();
    const end1 = later(30);
    const first = await service.verifyAndGrant('u1', {
      store: 'APPLE', productId: 'premium_1_month',
      signedTransaction: jws(tx({ productId: 'premium_1_month', transactionId: 'r1', originalTransactionId: 'orig', expiresDate: end1 })),
    });
    expect(first).toMatchObject({ granted: true, entitlements: { isPremium: true, hasVoiceChat: false } });
    expect(user.subscriptionStatus).toBe('PREMIUM');
    expect(user.subscriptionExpiry?.getTime()).toBe(end1);

    const end2 = later(60);
    await service.verifyAndGrant('u1', {
      store: 'APPLE', productId: 'premium_1_month',
      signedTransaction: jws(tx({ productId: 'premium_1_month', transactionId: 'r2', originalTransactionId: 'orig', expiresDate: end2 })),
    });
    expect(user.subscriptionExpiry?.getTime()).toBe(end2);
  });

  it('a subscription can only belong to one player', async () => {
    const { service } = setup();
    const signed = jws(tx({ productId: 'premium_1_month', transactionId: 'r1', originalTransactionId: 'orig', expiresDate: later(30) }));
    await service.verifyAndGrant('u1', { store: 'APPLE', productId: 'premium_1_month', signedTransaction: signed });
    await expect(service.verifyAndGrant('u2', { store: 'APPLE', productId: 'premium_1_month', signedTransaction: signed })).rejects.toThrow(BadRequestException);
  });

  it('Voice chat is separate from Premium; an ended plan unlocks nothing', async () => {
    const { service, user } = setup();
    await service.verifyAndGrant('u1', { store: 'FAKE', productId: 'voice_chat_1_week', transactionId: 'v1' });
    expect(user.voiceChatExpiry && user.voiceChatExpiry.getTime() > Date.now()).toBe(true);
    expect(user.subscriptionStatus).toBe('FREE');

    const ended = await service.verifyAndGrant('u1', {
      store: 'APPLE', productId: 'premium_1_week',
      signedTransaction: jws(tx({ productId: 'premium_1_week', transactionId: 'old', originalTransactionId: 'old', expiresDate: later(-1) })),
    });
    expect(ended).toMatchObject({ expired: true, entitlements: { isPremium: false } });
  });

  it('adds store periods', () => {
    const from = new Date('2026-01-31T00:00:00Z');
    expect(addPeriod(from, 'P1W').toISOString()).toBe('2026-02-07T00:00:00.000Z');
    expect(addPeriod(from, 'P1Y').toISOString()).toBe('2027-01-31T00:00:00.000Z');
  });
});

