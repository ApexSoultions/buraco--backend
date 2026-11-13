/**
 * Real-money products sold through Google Play and the App Store.
 *
 * The product IDs here must be created with exactly the same IDs in the Play Console
 * (In-app products, "Managed product") and in App Store Connect (In-App Purchases,
 * "Consumable"). The price shown to players comes from the store; referencePriceUsd is
 * Figma's price, for whoever sets the prices in the consoles.
 */
export type IapProductType = 'CONSUMABLE';

export interface IapProduct {
  productId: string;
  type: IapProductType;
  coins: number;
  referencePriceUsd: number;
  sortOrder: number;
}

export const IAP_PRODUCTS: readonly IapProduct[] = [
  { productId: 'coins_50000', type: 'CONSUMABLE', coins: 50000, referencePriceUsd: 120.99, sortOrder: 1 },
  { productId: 'coins_25000', type: 'CONSUMABLE', coins: 25000, referencePriceUsd: 70.99, sortOrder: 2 },
  { productId: 'coins_10000', type: 'CONSUMABLE', coins: 10000, referencePriceUsd: 40.99, sortOrder: 3 },
  { productId: 'coins_5000', type: 'CONSUMABLE', coins: 5000, referencePriceUsd: 25.99, sortOrder: 4 },
  { productId: 'coins_3000', type: 'CONSUMABLE', coins: 3000, referencePriceUsd: 15.99, sortOrder: 5 },
  { productId: 'coins_2000', type: 'CONSUMABLE', coins: 2000, referencePriceUsd: 9.99, sortOrder: 6 },
  { productId: 'coins_1000', type: 'CONSUMABLE', coins: 1000, referencePriceUsd: 5.99, sortOrder: 7 },
];

export function findIapProduct(productId: string): IapProduct | undefined {
  return IAP_PRODUCTS.find((p) => p.productId === productId);
}
