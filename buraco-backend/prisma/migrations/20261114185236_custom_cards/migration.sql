-- CreateEnum
CREATE TYPE "CustomCardStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'REFUND';

-- CreateTable
CREATE TABLE "custom_cards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "imageKey" TEXT NOT NULL,
    "status" "CustomCardStatus" NOT NULL DEFAULT 'PENDING',
    "isEquipped" BOOLEAN NOT NULL DEFAULT false,
    "pricePaid" INTEGER NOT NULL DEFAULT 0,
    "rejectReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_cards_userId_idx" ON "custom_cards"("userId");

-- CreateIndex
CREATE INDEX "custom_cards_status_idx" ON "custom_cards"("status");

-- AddForeignKey
ALTER TABLE "custom_cards" ADD CONSTRAINT "custom_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
