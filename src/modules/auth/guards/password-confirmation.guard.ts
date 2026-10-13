import {
  CanActivate,
  ExecutionContext,
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

    if (!user.password || !(await argon2.verify(user.password, supplied))) {
      // Deliberately not cleared on failure — a wrong attempt must not end a window the
      // legitimate user already opened.
      throw new UnauthorizedException({
        code: 'PASSWORD_INCORRECT',
        message: 'That password is not correct.',
      });
    }

    const minutes =
      this.config.get<number>('wallet.passwordConfirmationMinutes') ?? 15;
    await this.redis?.setex(key, minutes * 60, '1');

    return true;
  }
}
