import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';
import { ChatRateLimitService } from './rate-limit.service';

const config = (perMinute: number, perHour: number) => ({
  provide: ConfigService,
  useValue: {
    get: jest.fn((key: string) =>
      key === 'chat.rateLimitPerMinute' ? perMinute : perHour,
    ),
  },
});

/** Minimal stand-in for ioredis with the surface the service actually uses. */
const fakeRedis = () => {
  const store = new Map<string, number>();
  return {
    status: 'ready',
    incr: jest.fn((key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    store,
  };
};

describe('ChatRateLimitService', () => {
  const build = async (
    perMinute: number,
    perHour: number,
    redis?: unknown,
  ): Promise<ChatRateLimitService> => {
    const providers: Provider[] = [
      ChatRateLimitService,
      config(perMinute, perHour),
    ];
    if (redis) providers.push({ provide: 'REDIS_CLIENT', useValue: redis });

    const module: TestingModule = await Test.createTestingModule({
      providers,
    }).compile();
    return module.get<ChatRateLimitService>(ChatRateLimitService);
  };

  describe('with Redis', () => {
    it('allows messages up to the minute limit', async () => {
      const service = await build(3, 100, fakeRedis());

      for (let i = 0; i < 3; i++) {
        await expect(service.consume('s1')).resolves.toMatchObject({
          allowed: true,
        });
      }
    });

    it('blocks the message that exceeds the minute limit', async () => {
      const service = await build(3, 100, fakeRedis());

      for (let i = 0; i < 3; i++) await service.consume('s1');

      await expect(service.consume('s1')).resolves.toMatchObject({
        allowed: false,
        reason: 'PER_MINUTE',
        retryAfter: 60,
      });
    });

    it('blocks on the hour limit even when the minute window is fine', async () => {
      const service = await build(1000, 2, fakeRedis());

      await service.consume('s1');
      await service.consume('s1');

      await expect(service.consume('s1')).resolves.toMatchObject({
        allowed: false,
        reason: 'PER_HOUR',
        retryAfter: 3600,
      });
    });

    it('counts each session separately', async () => {
      const service = await build(1, 100, fakeRedis());

      await service.consume('s1');
      await expect(service.consume('s2')).resolves.toMatchObject({
        allowed: true,
      });
    });

    it('sets the TTL only on the first hit, so the window does not slide forward', async () => {
      const redis = fakeRedis();
      const service = await build(10, 100, redis);

      await service.consume('s1');
      await service.consume('s1');
      await service.consume('s1');

      // One expire per window on the first message only.
      expect(redis.expire).toHaveBeenCalledTimes(2);
    });

    it('falls back to memory when Redis throws rather than failing open', async () => {
      const redis = fakeRedis();
      redis.incr.mockRejectedValue(new Error('redis down'));
      const service = await build(2, 100, redis);

      await expect(service.consume('s1')).resolves.toMatchObject({
        allowed: true,
      });
      await service.consume('s1');
      await expect(service.consume('s1')).resolves.toMatchObject({
        allowed: false,
      });
    });
  });

  describe('without Redis', () => {
    it('still enforces the limit in-process', async () => {
      const service = await build(2, 100);

      await service.consume('s1');
      await service.consume('s1');

      await expect(service.consume('s1')).resolves.toMatchObject({
        allowed: false,
        reason: 'PER_MINUTE',
      });
    });

    it('treats the no-op mock client as absent, so limits still fire', async () => {
      // RedisModule's MockRedisClient answers incr with 0 — trusting it would make
      // every counter read as 1 and the limit would never trigger.
      const mock = {
        incr: () => Promise.resolve(0),
        expire: () => Promise.resolve(0),
      };
      const service = await build(2, 100, mock);

      await service.consume('s1');
      await service.consume('s1');

      await expect(service.consume('s1')).resolves.toMatchObject({
        allowed: false,
      });
    });
  });
});
