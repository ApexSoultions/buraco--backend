-- CreateEnum
CREATE TYPE "GameHost" AS ENUM ('SERVER', 'FUSION');

-- AlterTable
-- New games default to SERVER: this backend is the authoritative match host.
ALTER TABLE "game_sessions" ADD COLUMN "hostedBy" "GameHost" NOT NULL DEFAULT 'SERVER';

-- Backfill every pre-existing row to FUSION so the turn-timeout cron never picks up a
-- historical (player-hosted) match. The DEFAULT above still applies to new inserts.
UPDATE "game_sessions" SET "hostedBy" = 'FUSION';

-- CreateIndex
CREATE INDEX "game_sessions_hostedBy_status_idx" ON "game_sessions"("hostedBy", "status");
