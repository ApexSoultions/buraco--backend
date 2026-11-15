-- Hand ranking: points earned in Professional-mode matches (additive, existing rows start at 0).
ALTER TABLE "player_stats" ADD COLUMN "professionalPoints" INTEGER NOT NULL DEFAULT 0;
