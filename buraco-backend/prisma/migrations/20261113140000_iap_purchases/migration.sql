-- Real-money store purchases (coin packs). Only adds.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'IAP_PURCHASE';

CREATE TABLE IF NOT EXISTS "iap_purchases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "coins" INTEGER NOT NULL,
    "environment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "iap_purchases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "iap_purchases_store_transactionId_key" ON "iap_purchases"("store", "transactionId");
CREATE INDEX IF NOT EXISTS "iap_purchases_userId_idx" ON "iap_purchases"("userId");
ALTER TABLE "iap_purchases" ADD CONSTRAINT "iap_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
