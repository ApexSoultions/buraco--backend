-- Store subscriptions (Premium and Voice chat). Only adds.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "voiceChatExpiry" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "iap_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "originalId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "iap_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "iap_subscriptions_store_originalId_key" ON "iap_subscriptions"("store", "originalId");
CREATE INDEX IF NOT EXISTS "iap_subscriptions_userId_idx" ON "iap_subscriptions"("userId");
ALTER TABLE "iap_subscriptions" ADD CONSTRAINT "iap_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
