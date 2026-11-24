export type SettingType = 'number' | 'boolean' | 'text' | 'secret' | 'version';

export interface SettingDef {
  key: string;
  label: string;
  description: string;
  group: string;
  type: SettingType;
  unit?: string;
  /**
   * True only when the game server really reads this setting. The others are kept in the
   * database for later but do nothing yet, so the panel shows them read-only instead of
   * letting staff believe they work (for example Maintenance Mode).
   */
  connected: boolean;
  /** The value used when the setting is blank (numbers) or "uses the server's own value" (text). */
  fallback?: string;
  min?: number;
  max?: number;
}

/** Order of the groups on the page. */
export const SETTING_GROUPS = ['Players', 'Rewards', 'Email', 'Storage', 'Sign in', 'Not connected yet'] as const;

const NC = 'Not connected yet';

export const SETTINGS: SettingDef[] = [
  // Players: what a new player starts with
  { key: 'new_user_coins', label: 'New player coins', description: 'Coins every new player starts with.', group: 'Players', type: 'number', unit: 'coins', connected: true, fallback: '1000', min: 0, max: 1_000_000 },
  { key: 'new_user_diamonds', label: 'New player diamonds', description: 'Diamonds every new player starts with.', group: 'Players', type: 'number', unit: 'diamonds', connected: true, fallback: '0', min: 0, max: 10_000 },
  { key: 'new_user_lives', label: 'New player lives', description: 'Lives every new player starts with.', group: 'Players', type: 'number', unit: 'lives', connected: true, fallback: '5', min: 0, max: 100 },
  // Rewards
  { key: 'daily_login_reward_coins', label: 'Daily login reward', description: 'Coins a player gets for logging in each day.', group: 'Rewards', type: 'number', unit: 'coins', connected: true, fallback: '200', min: 0, max: 1_000_000 },
  // Email (password reset and similar). Blank = the server's own setting.
  { key: 'smtp_host', label: 'Mail server', description: 'Mail server name, for example smtp.gmail.com. Blank uses the server’s own setting.', group: 'Email', type: 'text', connected: true },
  { key: 'smtp_port', label: 'Mail port', description: '587 for TLS or 465 for SSL. Blank uses the server’s own setting.', group: 'Email', type: 'text', connected: true },
  { key: 'smtp_user', label: 'Mail user name', description: 'The mail account user name or address.', group: 'Email', type: 'text', connected: true },
  { key: 'smtp_pass', label: 'Mail password', description: 'The mail account password or app password. It is never shown again after saving.', group: 'Email', type: 'secret', connected: true },
  { key: 'smtp_from', label: 'Sender address', description: 'The address players see on emails from the game.', group: 'Email', type: 'text', connected: true },
  // Storage (avatars, voice messages, custom cards)
  { key: 'aws_region', label: 'AWS region', description: 'For example ap-south-1. Blank uses the server’s own setting.', group: 'Storage', type: 'text', connected: true },
  { key: 'aws_access_key_id', label: 'AWS access key ID', description: 'Key with permission to use the storage bucket.', group: 'Storage', type: 'text', connected: true },
  { key: 'aws_secret_access_key', label: 'AWS secret key', description: 'The secret part of the key. It is never shown again after saving.', group: 'Storage', type: 'secret', connected: true },
  { key: 'aws_s3_bucket', label: 'Storage bucket', description: 'Name of the bucket for avatars, voice messages and custom cards.', group: 'Storage', type: 'text', connected: true },
  // Sign in
  { key: 'google_client_id', label: 'Google client ID', description: 'Used to check Google sign-in. Blank uses the server’s own setting.', group: 'Sign in', type: 'text', connected: true },

  // Kept in the database but not read by the game server yet.
  { key: 'maintenance_mode', label: 'Maintenance mode', description: 'Meant to take the game offline for everyone.', group: NC, type: 'boolean', connected: false },
  { key: 'min_version_ios', label: 'Minimum iOS version', description: 'Meant to force an update on old iOS versions.', group: NC, type: 'version', connected: false },
  { key: 'min_version_android', label: 'Minimum Android version', description: 'Meant to force an update on old Android versions.', group: NC, type: 'version', connected: false },
  { key: 'turn_duration_seconds', label: 'Turn time', description: 'Seconds per turn. The game uses a fixed time today.', group: NC, type: 'number', unit: 'sec', connected: false },
  { key: 'disconnect_timeout_seconds', label: 'Disconnect time', description: 'Seconds a player may stay disconnected.', group: NC, type: 'number', unit: 'sec', connected: false },
  { key: 'classic_entry_fee', label: 'Classic entry fee', description: 'Entry fee per Classic match.', group: NC, type: 'number', unit: 'coins', connected: false },
  { key: 'professional_entry_fee', label: 'Professional entry fee', description: 'Entry fee per Professional match.', group: NC, type: 'number', unit: 'coins', connected: false },
  { key: 'max_club_members', label: 'Clan size', description: 'Clans start with 30 seats today (set per clan).', group: NC, type: 'number', unit: 'players', connected: false },
  { key: 'throttle_ttl_seconds', label: 'Rate limit window', description: 'The server uses fixed limits today.', group: NC, type: 'number', unit: 'sec', connected: false },
  { key: 'throttle_limit', label: 'Rate limit requests', description: 'The server uses fixed limits today.', group: NC, type: 'number', unit: 'requests', connected: false },
  { key: 'google_client_secret', label: 'Google client secret', description: 'Not used by the game.', group: NC, type: 'secret', connected: false },
  { key: 'apple_client_id', label: 'Apple client ID', description: 'Sign in with Apple is not built yet.', group: NC, type: 'text', connected: false },
  { key: 'apple_team_id', label: 'Apple team ID', description: 'Sign in with Apple is not built yet.', group: NC, type: 'text', connected: false },
  { key: 'apple_key_id', label: 'Apple key ID', description: 'Sign in with Apple is not built yet.', group: NC, type: 'text', connected: false },
  { key: 'apple_private_key', label: 'Apple private key', description: 'Sign in with Apple is not built yet.', group: NC, type: 'secret', connected: false },
];

export const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
