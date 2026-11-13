/**
 * Real-money products sold through Google Play and the App Store.
 *
 * The product IDs here must be created with exactly the same IDs in the Play Console and in
 * App Store Connect:
 * - CONSUMABLE: Play "In-app product" / App Store "Consumable" (coin packs)
 * - SUBSCRIPTION: Play "Subscription" (one base plan, auto-renewing, the period below) /
 *   App Store "Auto-Renewable Subscription", all in ONE subscription group per entitlement
 *   (Premium, Voice chat) so a player can only have one plan of each at a time.
 * The price shown to players comes from the store; referencePriceUsd is Figma's price.
 */
export type IapProductType = 'CONSUMABLE' | 'SUBSCRIPTION';
export type IapEntitlement = 'PREMIUM' | 'VOICE_CHAT';

export interface IapProduct {
  productId: string;
  type: IapProductType;
  /** CONSUMABLE: coins added per purchase. */
  coins: number;
  /** SUBSCRIPTION: what it unlocks, its store period and its card text. */
  entitlement?: IapEntitlement;
  period?: string; // ISO 8601: P1W, P1M, P3M, P6M, P1Y
  label?: string; // "12 Months", "1 Week"
  saveLabel?: string; // Figma "Save 33%"
  referencePriceUsd: number;
  sortOrder: number;
}

const coins = (productId: string, amount: number, price: number, sortOrder: number): IapProduct =>
  ({ productId, type: 'CONSUMABLE', coins: amount, referencePriceUsd: price, sortOrder });

const sub = (productId: string, entitlement: IapEntitlement, period: string, label: string, price: number, sortOrder: number, saveLabel?: string): IapProduct =>
  ({ productId, type: 'SUBSCRIPTION', coins: 0, entitlement, period, label, saveLabel, referencePriceUsd: price, sortOrder });

export const IAP_PRODUCTS: readonly IapProduct[] = [
  coins('coins_50000', 50000, 120.99, 1),
  coins('coins_25000', 25000, 70.99, 2),
  coins('coins_10000', 10000, 40.99, 3),
  coins('coins_5000', 5000, 25.99, 4),
  coins('coins_3000', 3000, 15.99, 5),
  coins('coins_2000', 2000, 9.99, 6),
  coins('coins_1000', 1000, 5.99, 7),

  // Figma "Subscriptions". The stores only allow auto-renewing periods of 1 week, 1/2/3/6
  // months or 1 year, so Figma's 7 and 5 months plans became one 6 months plan.
  sub('premium_12_months', 'PREMIUM', 'P1Y', '12 Months', 39.99, 11, 'Save 33%'),
  sub('premium_6_months', 'PREMIUM', 'P6M', '6 Months', 21.99, 12, 'Save 27%'),
  sub('premium_3_months', 'PREMIUM', 'P3M', '3 Months', 12.99, 13, 'Save 13%'),
  sub('premium_1_month', 'PREMIUM', 'P1M', '1 Month', 4.99, 14),
  sub('premium_1_week', 'PREMIUM', 'P1W', '7 Days', 2.49, 15),
  sub('voice_chat_1_week', 'VOICE_CHAT', 'P1W', '1 Week', 1.99, 16),
  sub('voice_chat_1_month', 'VOICE_CHAT', 'P1M', '1 Month', 3.99, 17),
];

export function findIapProduct(productId: string): IapProduct | undefined {
  return IAP_PRODUCTS.find((p) => p.productId === productId);
}
