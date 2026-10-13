import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/** How long a code works. Short: it is typed straight from an inbox. */
export const CODE_TTL_MINUTES = 10;
/** Wrong guesses allowed on one code before it is thrown away. */
export const MAX_ATTEMPTS = 5;
/** Between two codes to the same address — long enough to stop a resend loop. */
export const RESEND_COOLDOWN_SECONDS = 30;
/** Codes one address may be sent in an hour, so nobody can flood an inbox. */
const PER_EMAIL_PER_HOUR = 5;
/** Codes one browser may ask for in an hour, across every address it tries. */
const PER_SESSION_PER_HOUR = 10;

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'COOLDOWN' | 'TOO_MANY'; retryAfter: number };

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: 'WRONG'; attemptsLeft: number }
  | { ok: false; reason: 'EXPIRED' | 'LOCKED' };

interface StoredCode {
  salt: string;
  hash: string;
  attempts: number;
}

/**
 * The six-digit codes that sign a buyer in by email.
 *
 * Kept in Redis with a TTL — a code is worth ten minutes and is never needed again, so it
 * has no business in the database. Stored hashed: what is in Redis cannot be typed in.
 * Without Redis it falls back to process memory, like the chat rate limiter: fine for one
 * instance, and logged.
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);
  private readonly local = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    if (!this.hasRedis()) {
      this.logger.warn(
        'Sign-in codes are held in process memory — they work on this instance only',
      );
    }
  }

  /** A fresh code for this address, replacing any earlier one — or why not yet. */
  async issue(email: string, sessionId: string): Promise<IssueResult> {
    const cooldown = await this.ttl(`chat-login:cooldown:${email}`);
    if (cooldown > 0) {
      return { ok: false, reason: 'COOLDOWN', retryAfter: cooldown };
    }

    const perEmail = await this.increment(`chat-login:email:${email}`, 3600);
    const perSession = await this.increment(
      `chat-login:session:${sessionId}`,
      3600,
    );
    if (perEmail > PER_EMAIL_PER_HOUR || perSession > PER_SESSION_PER_HOUR) {
      this.logger.warn(
        `Sign-in code limit reached (email ${perEmail}, session ${perSession})`,
      );
      return { ok: false, reason: 'TOO_MANY', retryAfter: 3600 };
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const stored: StoredCode = { salt, hash: digest(salt, code), attempts: 0 };

    await this.set(
      `chat-login:code:${email}`,
      JSON.stringify(stored),
      CODE_TTL_MINUTES * 60,
    );
    await this.set(
      `chat-login:cooldown:${email}`,
      '1',
      RESEND_COOLDOWN_SECONDS,
    );

    return { ok: true, code };
  }

  /** Whether `code` is the live one for this address. A right answer uses it up. */
  async check(email: string, code: string): Promise<CheckResult> {
    const key = `chat-login:code:${email}`;
    const raw = await this.get(key);
    if (!raw) return { ok: false, reason: 'EXPIRED' };

    const stored = JSON.parse(raw) as StoredCode;
    const presented = code.replace(/\s+/g, '');
    const expected = Buffer.from(stored.hash, 'hex');
    const actual = Buffer.from(digest(stored.salt, presented), 'hex');

    if (/^\d{6}$/.test(presented) && timingSafeEqual(expected, actual)) {
      await this.del(key);
      return { ok: true };
    }

    const attempts = stored.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.del(key);
      return { ok: false, reason: 'LOCKED' };
    }

    // Keep the code's own expiry: a wrong guess must not buy it more time.
    const remaining = await this.ttl(key);
    await this.set(
      key,
      JSON.stringify({ ...stored, attempts }),
      Math.max(1, remaining),
    );
    return {
      ok: false,
      reason: 'WRONG',
      attemptsLeft: MAX_ATTEMPTS - attempts,
    };
  }

  // ─── Storage: Redis, or memory without it ──────────────────────────────────────

  private hasRedis(): boolean {
    // The mock client in RedisModule answers every call with a no-op. Treat it as absent.
    return Boolean(
      this.redis &&
      typeof this.redis.incr === 'function' &&
      'status' in this.redis,
    );
  }

  private async get(key: string): Promise<string | null> {
    if (this.hasRedis()) return this.redis!.get(key);
    const entry = this.local.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  private async set(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    if (this.hasRedis()) {
      await this.redis!.set(key, value, 'EX', ttlSeconds);
      return;
    }
    this.local.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  private async del(key: string): Promise<void> {
    if (this.hasRedis()) {
      await this.redis!.del(key);
      return;
    }
    this.local.delete(key);
  }

  /** Seconds left on a key, or 0 when it is absent or expired. */
  private async ttl(key: string): Promise<number> {
    if (this.hasRedis()) return Math.max(0, await this.redis!.ttl(key));
    const entry = this.local.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  private async increment(key: string, ttlSeconds: number): Promise<number> {
    if (this.hasRedis()) {
      const count = await this.redis!.incr(key);
      if (count === 1) await this.redis!.expire(key, ttlSeconds);
      return count;
    }
    const now = Date.now();
    const entry = this.local.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.local.set(key, { value: '1', expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    const count = Number(entry.value) + 1;
    entry.value = String(count);
    return count;
  }
}

function digest(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}
