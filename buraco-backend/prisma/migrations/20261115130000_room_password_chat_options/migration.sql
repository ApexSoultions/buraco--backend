-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "textChat" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "voiceChat" BOOLEAN NOT NULL DEFAULT true;
