import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';

// How long a "this user dropped" marker survives. Purely informational — a disconnect no
// longer ends or pauses anything. The backend hosts the match, so play continues via the
// auto-play cron and the match ends only when a player reaches 12 auto-played turns.
const DISCONNECT_TTL = 60;
const ACTIVE_GAME_TTL = 86400;   // 24 hours — matches the Redis game-state TTL
const LAST_GAME_TTL = 604800;    // 7 days — long enough to show a missed result

@Injectable()
export class ReconnectionService {
  constructor(private redis: RedisService) {}

  /** Mark a user as disconnected from a game with a 60s TTL */
  async markDisconnected(userId: string, gameId: string): Promise<void> {
    await this.redis.set(
      `disconnect:${userId}:${gameId}`,
      String(Date.now()),
      DISCONNECT_TTL,
    );
  }

  /** Remove the disconnected marker (user reconnected) */
  async markReconnected(userId: string, gameId: string): Promise<void> {
    await this.redis.del(`disconnect:${userId}:${gameId}`);
  }

  /** Check whether the user is currently flagged as disconnected */
  async isDisconnected(userId: string, gameId: string): Promise<boolean> {
    const result = await this.redis.exists(`disconnect:${userId}:${gameId}`);
    return result > 0;
  }

  /** Get the active game ID for a user (set when the game starts) */
  async getActiveGameForUser(userId: string): Promise<string | null> {
    return this.redis.get(`user:${userId}:activeGame`);
  }

  /** Persist the active game for a user with a 24h TTL */
  async setActiveGame(userId: string, gameId: string): Promise<void> {
    await this.redis.set(`user:${userId}:activeGame`, gameId, ACTIVE_GAME_TTL);
  }

  /**
   * Remove the active game record for a user, leaving a `lastGame` breadcrumb behind.
   *
   * Without the breadcrumb a player whose match ended while they were away had nothing on
   * the server pointing at it, so they could not be shown the result when they came back
   * (see GameEngineService.getResumeTarget, which reads it).
   */
  async clearActiveGame(userId: string): Promise<void> {
    const gameId = await this.redis.get(`user:${userId}:activeGame`);
    if (gameId) await this.setLastGame(userId, gameId);
    await this.redis.del(`user:${userId}:activeGame`);
  }

  /** Remember the last match this user played, so its result stays reachable for 7 days. */
  async setLastGame(userId: string, gameId: string): Promise<void> {
    await this.redis.set(`user:${userId}:lastGame`, gameId, LAST_GAME_TTL);
  }

  /** The last match this user played, if it is still within the retention window. */
  async getLastGame(userId: string): Promise<string | null> {
    return this.redis.get(`user:${userId}:lastGame`);
  }
}
