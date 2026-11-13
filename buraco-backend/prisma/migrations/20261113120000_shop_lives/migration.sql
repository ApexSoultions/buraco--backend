-- Shop: LIVES category, lives granted per pack, and display order. Only adds; the running
-- version keeps working on the migrated database.
ALTER TYPE "ShopCategory" ADD VALUE IF NOT EXISTS 'LIVES';
ALTER TABLE "shop_items" ADD COLUMN IF NOT EXISTS "grantLives" INTEGER;
ALTER TABLE "shop_items" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
