-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "source" TEXT;
