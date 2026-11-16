-- Unlock everything on TWO test accounts (for testing on Live).
--
-- The accounts must already exist: register them in the game first (New Account).
-- Run on the server, replacing the two usernames:
--
--   docker exec -i buraco_postgres psql -U postgres -d buraco_db -v a=tester_one -v b=tester_two < unlock-test-accounts.sql
--
-- What it does, only for those two usernames:
--   * Premium and Voice chat for 1 year
--   * 1,000,000 coins, 100,000 diamonds, 999 lives
--   * level 30 and 5,000 points (Classic, Professional and total) for min-level / min-points tables
--   * owns every table colour, card back and emoji in the shop
--   * the two accounts are friends (for table invites and private chat)
-- Everything runs in one transaction: if anything fails, nothing changes.

\set ON_ERROR_STOP on
BEGIN;

UPDATE users
   SET "subscriptionStatus" = 'PREMIUM',
       "subscriptionExpiry" = now() + interval '1 year',
       "voiceChatExpiry"    = now() + interval '1 year',
       coins    = 1000000,
       diamonds = 100000,
       lives    = 999
 WHERE username IN (:'a', :'b');

UPDATE player_stats
   SET level                = GREATEST(level, 30),
       points               = GREATEST(points, 5000),
       "classicPoints"      = GREATEST("classicPoints", 5000),
       "professionalPoints" = GREATEST("professionalPoints", 5000)
 WHERE "userId" IN (SELECT id FROM users WHERE username IN (:'a', :'b'));

INSERT INTO inventory (id, "userId", "itemId", quantity, "isEquipped", "purchasedAt")
SELECT gen_random_uuid(), u.id, s.id, 1, false, now()
  FROM users u
 CROSS JOIN shop_items s
 WHERE u.username IN (:'a', :'b')
   AND s.category IN ('TABLES', 'CARDS', 'EMOJIS')
   AND s."isConsumable" = false
   AND s."isActive" = true
ON CONFLICT ("userId", "itemId") DO NOTHING;

INSERT INTO friendships (id, "senderId", "receiverId", status, "createdAt", "updatedAt")
SELECT gen_random_uuid(), a.id, b.id, 'ACCEPTED', now(), now()
  FROM users a, users b
 WHERE a.username = :'a' AND b.username = :'b'
   AND NOT EXISTS (
         SELECT 1 FROM friendships f
          WHERE (f."senderId" = a.id AND f."receiverId" = b.id)
             OR (f."senderId" = b.id AND f."receiverId" = a.id));

COMMIT;

-- Check: both rows should show PREMIUM and the new balances.
SELECT u.username, u."subscriptionStatus", u."subscriptionExpiry"::date AS premium_until,
       u."voiceChatExpiry"::date AS voice_until, u.coins, u.diamonds, u.lives, p.level,
       (SELECT count(*) FROM inventory i WHERE i."userId" = u.id) AS items_owned
  FROM users u LEFT JOIN player_stats p ON p."userId" = u.id
 WHERE u.username IN (:'a', :'b');
