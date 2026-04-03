import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Mock Redis client for development/production when Redis is not configured.
 * Provides a no-op interface that matches ioredis API.
 */
class MockRedisClient {
  private logger = new Logger('MockRedisClient');

  async get(): Promise<null> {
    return null;
  }

  async set(): Promise<'OK'> {
    return 'OK';
  }

  async setex(): Promise<'OK'> {
    return 'OK';
  }

  async del(): Promise<number> {
    return 0;
  }

  async hget(): Promise<null> {
    return null;
  }

  async hset(): Promise<number> {
    return 0;
  }

  async hgetall(): Promise<Record<string, string>> {
    return {};
  }

  async expire(): Promise<number> {
    return 0;
  }

  async keys(): Promise<string[]> {
    return [];
  }

  on(): this {
    return this;
  }

  once(): this {
    return this;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        const redisHost = configService.get<string>('redis.host');
        const logger = new Logger('RedisModule');

        // If Redis is not configured, return mock client
        if (!redisHost) {
          logger.warn(
            'Redis is not configured (REDIS_HOST not set). Using mock Redis client. ' +
              'Set REDIS_HOST, REDIS_PORT, and REDIS_PASSWORD in .env to enable real Redis.',
          );
          return new MockRedisClient();
        }

        const redis = new Redis({
          host: redisHost,
          port: configService.get<number>('redis.port') || 6379,
          password: configService.get<string>('redis.password'),
          retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          enableOfflineQueue: false,
          maxRetriesPerRequest: null,
        });

        // Handle Redis connection errors gracefully
        redis.on('error', (err) => {
          logger.warn(
            `Redis connection error: ${err.message}. Proceeding without Redis caching.`,
          );
        });

        redis.on('connect', () => {
          logger.debug('Redis connected successfully');
        });

        return redis;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
