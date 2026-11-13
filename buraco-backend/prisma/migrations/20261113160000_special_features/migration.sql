-- Special Features: black list size per player, seats per club. Only adds.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "blockLimit" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "maxMembers" INTEGER NOT NULL DEFAULT 30;
