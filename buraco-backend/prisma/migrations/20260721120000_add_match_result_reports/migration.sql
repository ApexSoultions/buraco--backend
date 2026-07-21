-- CreateTable
CREATE TABLE "match_result_reports" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "reportedBy" TEXT NOT NULL,
    "winnerTeam" INTEGER NOT NULL DEFAULT 0,
    "winnerIds" TEXT[],
    "reason" TEXT NOT NULL DEFAULT 'finished',
    "payload" JSONB NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_result_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "match_result_reports_gameId_key" ON "match_result_reports"("gameId");

-- AddForeignKey
ALTER TABLE "match_result_reports" ADD CONSTRAINT "match_result_reports_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
