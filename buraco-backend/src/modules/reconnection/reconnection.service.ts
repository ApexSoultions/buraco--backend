import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';

const DISCONNECT_TTL = 60;        // 60 seconds reconnect window
const ACTIVE_GAME_TTL = 86400;    // 24 hours

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

  /** Remove the active game record for a user */
  async clearActiveGame(userId: string): Promise<void> {
    await this.redis.del(`user:${userId}:activeGame`);
  }
}
