import { PrismaClient, MissionType, MissionRequirement, AdminRole, ShopCategory } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

// Usage:
//   npx prisma db seed                         local: admin (if missing) + default content
//   npx ts-node prisma/seed.ts --content       any server: missions, shop items and missing
//                                              config keys only — never touches admins
// Safe to run again: existing missions, shop items and config values are left as they are.
const CONTENT_ONLY = process.argv.includes('--content');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const LOCAL_ADMIN_PASSWORD = 'Admin@123!';

async function main() {
  console.log(CONTENT_ONLY ? 'Seeding default content (no admin)...' : 'Seeding database...');

  // ─── Super Admin ──────────────────────────────────────────────────────────
  // The password used to be hard-coded (and is visible in the repo). Outside local
  // development it must come from SEED_ADMIN_PASSWORD.
  const adminExists = CONTENT_ONLY || await prisma.adminUser.findUnique({ where: { email: 'admin@buraco.game' } });
  if (!adminExists) {
    const password = process.env.SEED_ADMIN_PASSWORD ?? (IS_PRODUCTION ? '' : LOCAL_ADMIN_PASSWORD);
    if (password.length < 12) {
      throw new Error('Set SEED_ADMIN_PASSWORD (12+ characters) to create the admin account, or run with --content.');
    }
    await prisma.adminUser.create({
      data: {
        email: 'admin@buraco.game',
        passwordHash: await bcrypt.hash(password, 12),
        name: 'Super Admin',
        role: AdminRole.SUPER_ADMIN,
      },
    });
    console.log(password === LOCAL_ADMIN_PASSWORD
      ? `Created super admin: admin@buraco.game / ${LOCAL_ADMIN_PASSWORD} (local only)`
      : 'Created super admin: admin@buraco.game (password from SEED_ADMIN_PASSWORD)');
  }

  // ─── System Config ────────────────────────────────────────────────────────
  const configs = [
    // App
    { key: 'maintenance_mode',          value: 'false' },
    { key: 'min_version_ios',           value: '1.0.0' },
    { key: 'min_version_android',       value: '1.0.0' },
    // Game
    { key: 'turn_duration_seconds',     value: '30' },
    { key: 'disconnect_timeout_seconds',value: '60' },
    // Economy — new user defaults
    { key: 'new_user_coins',            value: '1000' },
    { key: 'new_user_diamonds',         value: '0' },
    { key: 'new_user_lives',            value: '5' },
    { key: 'daily_login_reward_coins',  value: '200' },
    // Matchmaking
    { key: 'classic_entry_fee',         value: '100' },
    { key: 'professional_entry_fee',    value: '500' },
    // Clubs
    { key: 'max_club_members',          value: '50' },
    // Rate limiting
    { key: 'throttle_ttl_seconds',      value: '60' },
    { key: 'throttle_limit',            value: '100' },
    // Integrations — Google OAuth
    { key: 'google_client_id',          value: '' },
    { key: 'google_client_secret',      value: '' },
    // Integrations — Apple Sign-In
    { key: 'apple_client_id',           value: '' },
    { key: 'apple_team_id',             value: '' },
    { key: 'apple_key_id',              value: '' },
    { key: 'apple_private_key',         value: '' },
    // Integrations — AWS S3
    { key: 'aws_region',                value: '' },
    { key: 'aws_access_key_id',         value: '' },
    { key: 'aws_secret_access_key',     value: '' },
    { key: 'aws_s3_bucket',             value: '' },
    // Integrations — SMTP
    { key: 'smtp_host',                 value: '' },
    { key: 'smtp_port',                 value: '' },
    { key: 'smtp_user',                 value: '' },
    { key: 'smtp_pass',                 value: '' },
    { key: 'smtp_from',                 value: '' },
  ];

  // Only adds missing keys. It used to reset every key to these defaults on each run,
  // wiping values an admin had set in the panel (keys, fees, maintenance mode).
  for (const cfg of configs) {
    await prisma.systemConfig.upsert({
      where: { key: cfg.key },
      update: {},
      create: { key: cfg.key, value: cfg.value },
    });
  }
  console.log('System config keys ensured:', configs.length);

  // ─── Daily Missions ───────────────────────────────────────────────────────
  const dailyMissions = [
    { title: 'Play 3 Games', description: 'Complete 3 games today', type: MissionType.DAILY, requirement: MissionRequirement.PLAY_GAMES, targetValue: 3, rewardCoins: 150 },
    { title: 'Win 1 Game', description: 'Win at least 1 game today', type: MissionType.DAILY, requirement: MissionRequirement.WIN_GAMES, targetValue: 1, rewardCoins: 300 },
    { title: 'Earn 500 Points', description: 'Accumulate 500 points in matches', type: MissionType.DAILY, requirement: MissionRequirement.EARN_POINTS, targetValue: 500, rewardCoins: 200 },
    { title: 'Send 5 Messages', description: 'Chat with friends or club members', type: MissionType.DAILY, requirement: MissionRequirement.SEND_MESSAGES, targetValue: 5, rewardCoins: 100 },
    { title: 'Play Classic Mode', description: 'Complete a Classic mode game', type: MissionType.DAILY, requirement: MissionRequirement.PLAY_CLASSIC, targetValue: 1, rewardCoins: 150 },
  ];

  // ─── Weekly Missions ──────────────────────────────────────────────────────
  const weeklyMissions = [
    { title: 'Win 10 Games', description: 'Win 10 games this week', type: MissionType.WEEKLY, requirement: MissionRequirement.WIN_GAMES, targetValue: 10, rewardCoins: 1500, rewardDiamonds: 5 },
    { title: 'Play 25 Games', description: 'Play 25 games this week', type: MissionType.WEEKLY, requirement: MissionRequirement.PLAY_GAMES, targetValue: 25, rewardCoins: 1000 },
    { title: 'Win Streak of 3', description: 'Win 3 games in a row', type: MissionType.WEEKLY, requirement: MissionRequirement.WIN_STREAK, targetValue: 3, rewardCoins: 800, rewardDiamonds: 3 },
    { title: 'Play Professional Mode', description: 'Complete 5 Professional mode games', type: MissionType.WEEKLY, requirement: MissionRequirement.PLAY_PROFESSIONAL, targetValue: 5, rewardCoins: 1200, rewardDiamonds: 2 },
    { title: 'Join a Club', description: 'Be a member of any club', type: MissionType.WEEKLY, requirement: MissionRequirement.JOIN_CLUB, targetValue: 1, rewardCoins: 500 },
  ];

  const allMissions = [...dailyMissions, ...weeklyMissions];
  for (const m of allMissions) {
    await prisma.mission.upsert({
      where: { id: (await prisma.mission.findFirst({ where: { title: m.title, type: m.type } }))?.id ?? 'nonexistent' },
      update: {},
      create: { ...m, rewardDiamonds: (m as any).rewardDiamonds ?? 0 },
    });
  }
  console.log('Seeded missions:', allMissions.length);

  // ─── Shop Items ───────────────────────────────────────────────────────────
  const shopItems = [
    // Subscriptions
    { name: 'Basic Subscription', description: 'Monthly Basic plan — ad-free + bonus coins', category: ShopCategory.SUBSCRIPTIONS, priceDiamonds: 50, isConsumable: false },
    { name: 'Premium Subscription', description: 'Monthly Premium plan — all features unlocked', category: ShopCategory.SUBSCRIPTIONS, priceDiamonds: 150, isConsumable: false },
    // Coins
    { name: '1,000 Coins', description: 'Pack of 1,000 coins', category: ShopCategory.COINS, priceDiamonds: 10, isConsumable: true },
    { name: '5,000 Coins', description: 'Pack of 5,000 coins', category: ShopCategory.COINS, priceDiamonds: 45, isConsumable: true },
    { name: '15,000 Coins', description: 'Pack of 15,000 coins', category: ShopCategory.COINS, priceDiamonds: 120, isConsumable: true },
    // Card Decks
    { name: 'Classic Blue Deck', description: 'Default classic card deck', category: ShopCategory.CARDS, priceCoins: 500, isConsumable: false },
    { name: 'Gold Foil Deck', description: 'Premium gold foil card design', category: ShopCategory.CARDS, priceDiamonds: 30, isConsumable: false },
    { name: 'Night Sky Deck', description: 'Dark themed starfield card deck', category: ShopCategory.CARDS, priceDiamonds: 25, isConsumable: false },
    // Tables
    { name: 'Classic Green Table', description: 'Standard green felt table', category: ShopCategory.TABLES, priceCoins: 1000, isConsumable: false },
    { name: 'Marble Table', description: 'Elegant marble surface table', category: ShopCategory.TABLES, priceDiamonds: 40, isConsumable: false },
    { name: 'Beach Table', description: 'Casual beach-themed table', category: ShopCategory.TABLES, priceDiamonds: 20, isConsumable: false },
    // Emojis
    { name: 'Basic Emoji Pack', description: '10 standard in-game emojis', category: ShopCategory.EMOJIS, priceCoins: 300, isConsumable: false },
    { name: 'Animated Emoji Pack', description: '5 animated emojis', category: ShopCategory.EMOJIS, priceDiamonds: 15, isConsumable: false },
    // Special
    { name: 'Double XP (1 day)', description: 'Earn double XP for 24 hours', category: ShopCategory.SPECIAL, priceDiamonds: 10, isConsumable: true },
    { name: 'Name Change Token', description: 'Change your username once', category: ShopCategory.SPECIAL, priceDiamonds: 20, isConsumable: true },
  ];

  for (const item of shopItems) {
    const existing = await prisma.shopItem.findFirst({ where: { name: item.name } });
    if (!existing) {
      await prisma.shopItem.create({ data: item });
    }
  }
  console.log('Seeded shop items:', shopItems.length);

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
