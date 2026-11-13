import { RedisService } from '../redis/redis.service';

/**
 * Which of these players are online right now. A player is online while their game
 * socket is connected: the gateway keeps `online:<id>` alive (30 s, renewed by ping).
 * Never throws: if Redis is unavailable everyone simply shows as offline.
 */
export async function onlineSet(redis: RedisService | undefined, userIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (!redis || unique.length === 0) return new Set();
  try {
    const flags = await redis.mget(unique.map((id) => `online:${id}`));
    return new Set(unique.filter((_, i) => !!flags[i]));
  } catch {
    return new Set();
  }
}
