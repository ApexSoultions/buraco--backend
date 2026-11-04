-- AlterTable
-- The Classic ranking gets its own score. Before, every match added the same total to
-- both ranking sets, so Classic and International were identical lists.
ALTER TABLE "player_stats" ADD COLUMN "classicPoints" INTEGER NOT NULL DEFAULT 0;

-- Backfill from finished Classic matches, using the same reward curve as
-- calculateMatchReward(): a winner earns 50 + floor(score / 20) points, a loser 0.
UPDATE "player_stats" ps
SET "classicPoints" = sub.total
FROM (
  SELECT mp."userId", SUM(50 + FLOOR(GREATEST(mp."score", 0) / 20.0))::INTEGER AS total
  FROM "match_players" mp
  JOIN "match_records" mr ON mr."id" = mp."matchId"
  WHERE mr."mode" = 'CLASSIC' AND mp."result" = 'WIN'
  GROUP BY mp."userId"
) sub
WHERE ps."userId" = sub."userId";
