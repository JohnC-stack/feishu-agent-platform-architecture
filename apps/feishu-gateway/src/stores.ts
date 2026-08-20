import { createHash, randomUUID } from 'node:crypto';

import Redis from 'ioredis';

export interface IdempotencyLease {
  namespace: string;
  key: string;
  token: string;
}

export interface IdempotencyStore {
  begin(namespace: string, key: string, leaseSeconds: number): Promise<IdempotencyLease | null>;
  complete(lease: IdempotencyLease, ttlSeconds: number): Promise<boolean>;
  release(lease: IdempotencyLease): Promise<boolean>;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(scope: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2000),
  });
}

export class RedisIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly redis: Redis) {}

  public async begin(
    namespace: string,
    key: string,
    leaseSeconds: number,
  ): Promise<IdempotencyLease | null> {
    const lease = { namespace, key, token: randomUUID() };
    const result = await this.redis.set(
      redisKey(namespace, key),
      lease.token,
      'EX',
      leaseSeconds,
      'NX',
    );
    return result === 'OK' ? lease : null;
  }

  public async complete(lease: IdempotencyLease, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], 'completed', 'EX', ARGV[2]); return 1 else return 0 end",
      1,
      redisKey(lease.namespace, lease.key),
      lease.token,
      String(ttlSeconds),
    );
    return result === 1;
  }

  public async release(lease: IdempotencyLease): Promise<boolean> {
    const result = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      redisKey(lease.namespace, lease.key),
      lease.token,
    );
    return result === 1;
  }
}

export class RedisRateLimiter implements RateLimiter {
  public constructor(private readonly redis: Redis) {}

  public async consume(
    scope: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const windowMs = windowSeconds * 1000;
    const result = (await this.redis.eval(
      "local current=redis.call('INCR',KEYS[1]); if current==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {current,redis.call('PTTL',KEYS[1])}",
      1,
      `feishu-agent:rate:${hash(scope)}`,
      String(windowMs),
    )) as [number, number];
    const [count, ttl] = result;
    return {
      allowed: count <= limit,
      count,
      retryAfterMs: Math.max(ttl, 0),
    };
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  public begin(
    namespace: string,
    key: string,
    leaseSeconds: number,
  ): Promise<IdempotencyLease | null> {
    const storageKey = `${namespace}:${key}`;
    const current = this.entries.get(storageKey);
    if (current && current.expiresAt > Date.now()) {
      return Promise.resolve(null);
    }
    const lease = { namespace, key, token: randomUUID() };
    this.entries.set(storageKey, {
      value: lease.token,
      expiresAt: Date.now() + leaseSeconds * 1000,
    });
    return Promise.resolve(lease);
  }

  public complete(lease: IdempotencyLease, ttlSeconds: number): Promise<boolean> {
    const storageKey = `${lease.namespace}:${lease.key}`;
    if (this.entries.get(storageKey)?.value !== lease.token) {
      return Promise.resolve(false);
    }
    this.entries.set(storageKey, { value: 'completed', expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve(true);
  }

  public release(lease: IdempotencyLease): Promise<boolean> {
    const storageKey = `${lease.namespace}:${lease.key}`;
    if (this.entries.get(storageKey)?.value !== lease.token) {
      return Promise.resolve(false);
    }
    return Promise.resolve(this.entries.delete(storageKey));
  }
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  public consume(scope: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const current = this.entries.get(scope);
    const entry =
      current && current.expiresAt > now
        ? current
        : { count: 0, expiresAt: now + windowSeconds * 1000 };
    entry.count += 1;
    this.entries.set(scope, entry);
    return Promise.resolve({
      allowed: entry.count <= limit,
      count: entry.count,
      retryAfterMs: Math.max(entry.expiresAt - now, 0),
    });
  }
}

function redisKey(namespace: string, key: string): string {
  return `feishu-agent:idempotency:${namespace}:${hash(key)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
