-- CreateEnum
CREATE TYPE "ClubInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'ACHIEVEMENT_REWARD';
ALTER TYPE "TransactionType" ADD VALUE 'CLUB_OBJECTIVE_REWARD';

-- AlterTable
ALTER TABLE "club_members" ADD COLUMN     "points" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "country" VARCHAR(2);

-- CreateTable
CREATE TABLE "club_invites" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "status" "ClubInviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "club_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_activities" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "text" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_advices" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_advices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_objectives" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requirement" "MissionRequirement" NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "mode" "GameMode",
    "rewardCoins" INTEGER NOT NULL DEFAULT 0,
    "rewardClubPoints" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_objective_progress" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "currentValue" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "club_objective_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requirement" "MissionRequirement" NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "mode" "GameMode",
    "rewardCoins" INTEGER NOT NULL DEFAULT 0,
    "rewardDiamonds" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_progress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "currentValue" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "achievement_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "club_invites_inviteeId_status_idx" ON "club_invites"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "club_invites_clubId_status_idx" ON "club_invites"("clubId", "status");

-- CreateIndex
CREATE INDEX "club_activities_clubId_createdAt_idx" ON "club_activities"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "club_advices_clubId_createdAt_idx" ON "club_advices"("clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "club_objective_progress_clubId_objectiveId_period_key" ON "club_objective_progress"("clubId", "objectiveId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_progress_userId_achievementId_key" ON "achievement_progress"("userId", "achievementId");

-- CreateIndex
CREATE INDEX "clubs_points_idx" ON "clubs"("points");

-- AddForeignKey
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_activities" ADD CONSTRAINT "club_activities_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_advices" ADD CONSTRAINT "club_advices_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_advices" ADD CONSTRAINT "club_advices_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_objective_progress" ADD CONSTRAINT "club_objective_progress_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_objective_progress" ADD CONSTRAINT "club_objective_progress_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "club_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievement_progress" ADD CONSTRAINT "achievement_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievement_progress" ADD CONSTRAINT "achievement_progress_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
