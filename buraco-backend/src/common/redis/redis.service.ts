import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.client = new Redis(this.config.get<string>('redis.url') ?? 'redis://localhost:6379', {
      connectTimeout: 5000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) => {
      console.error('[Redis] connection error:', err.message);
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  get(key: string) {
    return this.client.get(key);
  }

  mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.client.mget(...keys);
  }

  set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) return this.client.set(key, value, 'EX', ttlSeconds);
    return this.client.set(key, value);
  }

  del(key: string) {
    return this.client.del(key);
  }

  exists(key: string) {
    return this.client.exists(key);
  }

  expire(key: string, seconds: number) {
    return this.client.expire(key, seconds);
  }

  // Sorted set ops (rankings / queues)
  zadd(key: string, score: number, member: string) {
    return this.client.zadd(key, score, member);
  }

  zrem(key: string, member: string) {
    return this.client.zrem(key, member);
  }

  zrank(key: string, member: string) {
    return this.client.zrank(key, member);
  }

  zrevrank(key: string, member: string) {
    return this.client.zrevrank(key, member);
  }

  zrangebyscore(key: string, min: number | string, max: number | string, limit?: number) {
    if (limit) return this.client.zrangebyscore(key, min, max, 'LIMIT', 0, limit);
    return this.client.zrangebyscore(key, min, max);
  }

  zrevrangebyscore(key: string, max: number | string, min: number | string, limit?: number) {
    if (limit) return this.client.zrevrangebyscore(key, max, min, 'LIMIT', 0, limit);
    return this.client.zrevrangebyscore(key, max, min);
  }

  zcard(key: string) {
    return this.client.zcard(key);
  }

  zscore(key: string, member: string) {
    return this.client.zscore(key, member);
  }

  // Set ops (active-game index — see GameEngineService.activeGamesKey)
  sadd(key: string, ...members: string[]) {
    if (members.length === 0) return Promise.resolve(0);
    return this.client.sadd(key, ...members);
  }

  srem(key: string, ...members: string[]) {
    if (members.length === 0) return Promise.resolve(0);
    return this.client.srem(key, ...members);
  }

  smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  scard(key: string) {
    return this.client.scard(key);
  }

  // Hash ops (game state)
  hset(key: string, field: string, value: string) {
    return this.client.hset(key, field, value);
  }

  hget(key: string, field: string) {
    return this.client.hget(key, field);
  }

  hgetall(key: string) {
    return this.client.hgetall(key);
  }

  hdel(key: string, ...fields: string[]) {
    return this.client.hdel(key, ...fields);
  }

  // JSON game state helpers
  async setJson(key: string, value: object, ttlSeconds?: number) {
    return this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  // Set only if the key does not already exist; returns 'OK' on success, null if key exists
  setNx(key: string, value: string, ttlSeconds?: number): Promise<'OK' | null> {
    if (ttlSeconds) return this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return this.client.set(key, value, 'NX') as Promise<'OK' | null>;
  }

  // Increment counter
  incr(key: string) {
    return this.client.incr(key);
  }

  ttl(key: string) {
    return this.client.ttl(key);
  }

  keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }
}
