import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the offending window frees up. Only set when blocked. */
  retryAfter?: number;
  reason?: 'PER_MINUTE' | 'PER_HOUR';
}

interface Window {
  key: 'PER_MINUTE' | 'PER_HOUR';
  seconds: number;
  limit: number;
}

/**
 * Per-session limits on chat messages.
 *
 * `ThrottlerModule` guards HTTP routes only — a WebSocket gateway bypasses it
 * completely.
 */
@Injectable()
export class ChatRateLimitService {
  private readonly logger = new Logger(ChatRateLimitService.name);
  private readonly windows: Window[];
  private readonly local = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    this.windows = [
      {
        key: 'PER_MINUTE',
        seconds: 60,
        limit: this.configService.get<number>('chat.rateLimitPerMinute') ?? 20,
      },
      {
        key: 'PER_HOUR',
        seconds: 3600,
        limit: this.configService.get<number>('chat.rateLimitPerHour') ?? 200,
      },
    ];

    if (!this.hasRedis()) {
      this.logger.warn(
        'Chat rate limiting is using in-process counters — limits are per-instance only',
      );
    }
  }

  /**
   * Counts one message against every window. Called before any model work, so a
   * blocked message costs nothing.
   */
  async consume(sessionId: string): Promise<RateLimitVerdict> {
    for (const window of this.windows) {
      const count = await this.increment(
        `chat:rl:${window.key}:${sessionId}`,
        window.seconds,
      );

      if (count > window.limit) {
        this.logger.warn(
          `Session ${sessionId} hit the ${window.key} chat limit (${count}/${window.limit})`,
        );
        return {
          allowed: false,
          retryAfter: window.seconds,
          reason: window.key,
        };
      }
    }

    return { allowed: true };
  }

  private hasRedis(): boolean {
    // The mock client in RedisModule answers every call with a no-op, which would make
    // every counter read as 1 and the limit never fire. Treat it as absent.
    return Boolean(
      this.redis &&
      typeof this.redis.incr === 'function' &&
      'status' in this.redis,
    );
  }

  private async increment(key: string, ttlSeconds: number): Promise<number> {
    if (this.hasRedis()) {
      try {
        const count = await this.redis!.incr(key);
        // Only the first hit sets the TTL, so the window is fixed rather than sliding
        // forward on every message.
        if (count === 1) await this.redis!.expire(key, ttlSeconds);
        return count;
      } catch (error) {
        this.logger.warn(
          `Redis rate-limit check failed, falling back to memory: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return this.incrementLocal(key, ttlSeconds);
  }

  private incrementLocal(key: string, ttlSeconds: number): number {
    const now = Date.now();
    const entry = this.local.get(key);

    if (!entry || entry.expiresAt <= now) {
      this.local.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      this.pruneLocal(now);
      return 1;
    }

    entry.count += 1;
    return entry.count;
  }

  /** Keeps the fallback map from growing without bound over a long uptime. */
  private pruneLocal(now: number): void {
    if (this.local.size < 5000) return;
    for (const [key, entry] of this.local) {
      if (entry.expiresAt <= now) this.local.delete(key);
    }
  }
}
