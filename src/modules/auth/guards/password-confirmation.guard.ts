import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type Redis from 'ioredis';
import * as argon2 from 'argon2';
import { REQUIRES_PASSWORD_KEY } from '../decorators/requires-password.decorator';

type AuthedRequest = Omit<Request, 'body'> & {
  user?: { id: string; password?: string | null };
  body?: { currentPassword?: string };
};

/**
 * Requires the password on `@RequiresPassword()` routes, then remembers it briefly.
 *
 * The window exists so a vendor doing several things in one sitting types it once. Asking
 * on every action pushes people to a password they can type quickly, or to one saved in
 * the browser — either of which hands it to the same attacker this is meant to stop.
 *
 * Wrong passwords are counted per account: after five in fifteen minutes, no more are
 * checked until the fifteen minutes are up. Without that, someone holding a stolen
 * session could guess here for as long as they liked — the login page's lock-out never
 * sees these attempts.
 */
@Injectable()
export class PasswordConfirmationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    // Absent in development, where RedisModule supplies a no-op client. The window then
    // never opens and the password is asked for every time, which is the safe direction.
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_PASSWORD_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const user = request.user;
    if (!user) throw new UnauthorizedException('User not authenticated');

    const supplied = request.body?.currentPassword;
    const key = `pwconfirm:${user.id}`;

    if (!supplied) {
      if (this.redis && (await this.redis.get(key))) return true;
      throw new UnauthorizedException({
        code: 'PASSWORD_REQUIRED',
        message: 'Confirm your password to continue.',
      });
    }

    const failuresKey = `pwconfirm:fail:${user.id}`;
    const failures = Number((await this.redis?.get(failuresKey)) ?? 0);
    if (failures >= MAX_WRONG_PASSWORDS) {
      throw new HttpException(
        {
          code: 'PASSWORD_LOCKED',
          message:
            'Too many wrong passwords. Try again in 15 minutes, or reset your password.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!user.password || !(await argon2.verify(user.password, supplied))) {
      // Counted, and the count lasts fifteen minutes from the first miss. Deliberately
      // not clearing the window — a wrong attempt must not end one the legitimate user
      // already opened.
      const count = await this.redis?.incr(failuresKey);
      if (count === 1) await this.redis?.expire(failuresKey, LOCK_SECONDS);
      throw new UnauthorizedException({
        code: 'PASSWORD_INCORRECT',
        message: 'That password is not correct.',
      });
    }
    await this.redis?.del(failuresKey);

    const minutes =
      this.config.get<number>('wallet.passwordConfirmationMinutes') ?? 15;
    await this.redis?.setex(key, minutes * 60, '1');

    return true;
  }
}

/** Wrong passwords allowed before the check stops for a while. */
const MAX_WRONG_PASSWORDS = 5;

/** How long the count, and the wait once it is reached, lasts. */
const LOCK_SECONDS = 15 * 60;
