import { createHash, createSign, verify as cryptoVerify, X509Certificate } from 'crypto';

/** What a store says about a purchase, once checked. */
export interface VerifiedPurchase {
  transactionId: string;
  productId: string;
  environment: string;
  /** Subscriptions: the same for every renewal (Google purchase token / Apple original transaction ID). */
  originalId?: string;
  /** Subscriptions: when the current paid period ends. */
  expiresAt?: Date;
}

export class StoreVerifyError extends Error {
  constructor(public readonly code: 'INVALID_PURCHASE' | 'STORE_NOT_CONFIGURED' | 'STORE_UNAVAILABLE', message: string) {
    super(message);
  }
}

// ─── Google Play ─────────────────────────────────────────────────────────────

interface GoogleProductPurchase {
  purchaseState?: number;
  orderId?: string;
  purchaseType?: number;
}

interface GoogleSubscriptionPurchase {
  subscriptionState?: string;
  latestOrderId?: string;
  testPurchase?: unknown;
  lineItems?: { productId?: string; expiryTime?: string }[];
}

interface GoogleToken {
  access_token: string;
  expires_in?: number;
}

interface AppleJwsHeader {
  alg?: string;
  x5c?: string[];
}

interface AppleTransaction {
  bundleId?: string;
  productId?: string;
  transactionId?: string | number;
  environment?: string;
  revocationDate?: number;
  originalTransactionId?: string | number;
  expiresDate?: number;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Checks a Google Play purchase token with the Play Developer API
 * (purchases.products.get), using the client's service-account key.
 */
export class GooglePlayVerifier {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly packageName: string,
    private readonly serviceAccountJson: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get configured() {
    return !!this.packageName && !!this.serviceAccountJson;
  }

  async verify(productId: string, purchaseToken: string): Promise<VerifiedPurchase> {
    if (!this.configured) throw new StoreVerifyError('STORE_NOT_CONFIGURED', 'Google Play purchases are not set up on the server yet');
    if (!purchaseToken) throw new StoreVerifyError('INVALID_PURCHASE', 'Missing purchase token');

    const access = await this.accessToken();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}`
      + `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${access}` } });
    } catch {
      throw new StoreVerifyError('STORE_UNAVAILABLE', 'Could not reach Google Play');
    }
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      throw new StoreVerifyError('INVALID_PURCHASE', 'Google Play does not know this purchase');
    }
    if (!res.ok) throw new StoreVerifyError('STORE_UNAVAILABLE', `Google Play answered ${res.status}`);

    const body = (await res.json()) as GoogleProductPurchase;
    // purchaseState: 0 purchased, 1 canceled, 2 pending
    if (body.purchaseState !== 0) throw new StoreVerifyError('INVALID_PURCHASE', 'The purchase is not completed');
    return {
      transactionId: String(body.orderId || purchaseToken),
      productId,
      environment: body.purchaseType === 0 ? 'test' : 'real',
    };
  }

  /**
   * Checks a subscription with purchases.subscriptionsv2. Active, in grace period and
   * cancelled-but-not-yet-ended subscriptions count until their expiry time.
   */
  async verifySubscription(productId: string, purchaseToken: string): Promise<VerifiedPurchase> {
    if (!this.configured) throw new StoreVerifyError('STORE_NOT_CONFIGURED', 'Google Play purchases are not set up on the server yet');
    if (!purchaseToken) throw new StoreVerifyError('INVALID_PURCHASE', 'Missing purchase token');

    const access = await this.accessToken();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}`
      + `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${access}` } });
    } catch {
      throw new StoreVerifyError('STORE_UNAVAILABLE', 'Could not reach Google Play');
    }
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      throw new StoreVerifyError('INVALID_PURCHASE', 'Google Play does not know this subscription');
    }
    if (!res.ok) throw new StoreVerifyError('STORE_UNAVAILABLE', `Google Play answered ${res.status}`);

    const body = (await res.json()) as GoogleSubscriptionPurchase;
    const ok = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];
    if (!ok.includes(body.subscriptionState ?? '')) throw new StoreVerifyError('INVALID_PURCHASE', `Subscription is ${body.subscriptionState ?? 'unknown'}`);
    const item = (body.lineItems ?? []).find((l) => l.productId === productId);
    if (!item?.expiryTime) throw new StoreVerifyError('INVALID_PURCHASE', 'Subscription is for another product');
    return {
      transactionId: String(body.latestOrderId || purchaseToken),
      productId,
      environment: body.testPurchase ? 'test' : 'real',
      originalId: purchaseToken,
      expiresAt: new Date(item.expiryTime),
    };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    let sa: ServiceAccount;
    try {
      const raw = this.serviceAccountJson.trim();
      sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount;
    } catch {
      throw new StoreVerifyError('STORE_NOT_CONFIGURED', 'GOOGLE_PLAY_SERVICE_ACCOUNT is not valid JSON');
    }
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

    let res: Response;
    try {
      res = await this.fetchFn(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
    } catch {
      throw new StoreVerifyError('STORE_UNAVAILABLE', 'Could not reach Google sign-in');
    }
    if (!res.ok) throw new StoreVerifyError('STORE_NOT_CONFIGURED', `Google refused the service account (${res.status})`);
    const body = (await res.json()) as GoogleToken;
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
}

// ─── Apple App Store (StoreKit 2) ────────────────────────────────────────────

/** SHA-256 fingerprint of "Apple Root CA - G3", which signs every App Store transaction. */
export const APPLE_ROOT_CA_G3_SHA256 = '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179';

/**
 * Checks a StoreKit 2 signed transaction (JWS): the certificate chain must end at Apple's
 * root, the signature must match, and the bundle ID and product must be ours.
 * No Apple account access or key is needed.
 */
export class AppleVerifier {
  constructor(
    private readonly bundleId: string,
    private readonly rootSha256: string = APPLE_ROOT_CA_G3_SHA256,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get configured() {
    return !!this.bundleId;
  }

  verify(productId: string, signedTransaction: string): VerifiedPurchase {
    if (!this.configured) throw new StoreVerifyError('STORE_NOT_CONFIGURED', 'App Store purchases are not set up on the server yet');
    const parts = (signedTransaction || '').split('.');
    if (parts.length !== 3) throw new StoreVerifyError('INVALID_PURCHASE', 'Not a signed App Store transaction');

    let header: AppleJwsHeader;
    let payload: AppleTransaction;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as AppleJwsHeader;
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AppleTransaction;
    } catch {
      throw new StoreVerifyError('INVALID_PURCHASE', 'Unreadable App Store transaction');
    }
    if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length < 2) {
      throw new StoreVerifyError('INVALID_PURCHASE', 'Unexpected App Store signature');
    }

    const certs = header.x5c.map((c) => new X509Certificate(Buffer.from(c, 'base64')));
    const at = this.now();
    for (let i = 0; i < certs.length; i++) {
      const cert = certs[i];
      if (new Date(cert.validFrom) > at || new Date(cert.validTo) < at) {
        throw new StoreVerifyError('INVALID_PURCHASE', 'App Store certificate expired');
      }
      const issuer = i + 1 < certs.length ? certs[i + 1] : cert;
      if (!cert.verify(issuer.publicKey)) throw new StoreVerifyError('INVALID_PURCHASE', 'App Store certificate chain is broken');
    }
    const root = certs[certs.length - 1];
    const rootSha = createHash('sha256').update(root.raw).digest('hex');
    if (rootSha !== this.rootSha256.toLowerCase().replace(/:/g, '')) {
      throw new StoreVerifyError('INVALID_PURCHASE', 'Not signed by Apple');
    }

    const signatureOk = cryptoVerify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    );
    if (!signatureOk) throw new StoreVerifyError('INVALID_PURCHASE', 'App Store signature does not match');

    if (payload.bundleId !== this.bundleId) throw new StoreVerifyError('INVALID_PURCHASE', 'Purchase is for another app');
    if (payload.productId !== productId) throw new StoreVerifyError('INVALID_PURCHASE', 'Purchase is for another product');
    if (payload.revocationDate) throw new StoreVerifyError('INVALID_PURCHASE', 'Purchase was refunded');
    if (!payload.transactionId) throw new StoreVerifyError('INVALID_PURCHASE', 'Purchase has no transaction ID');

    return {
      transactionId: String(payload.transactionId),
      productId,
      environment: String(payload.environment ?? 'Production'),
      originalId: String(payload.originalTransactionId ?? payload.transactionId),
      expiresAt: payload.expiresDate ? new Date(payload.expiresDate) : undefined,
    };
  }
}
