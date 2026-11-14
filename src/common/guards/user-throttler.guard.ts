import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { clientIp } from './client-ip-throttler.guard';

/**
 * Rate limits per signed-in account rather than per address: a vendor on a phone moves
 * between networks, and one shared address can carry many vendors. Falls back to the
 * client address if the route is ever reached signed out.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): string {
    const user = req.user as { id?: string } | undefined;
    return user?.id ? `user:${user.id}` : clientIp(req);
  }
}
