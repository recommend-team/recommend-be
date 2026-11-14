import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limits per client address — the real one.
 *
 * Behind Heroku's router every request arrives from the router, so the client is read
 * from X-Forwarded-For. The router *appends* the address it saw to whatever the client
 * sent, so the last entry is the one that can be trusted: the first can be anything a
 * caller likes, and limiting on it would let them reset their own limit every request.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): string {
    return clientIp(req);
  }
}

/** The client's address as Heroku's router saw it, else the socket's. */
export function clientIp(req: Record<string, unknown>): string {
  const forwarded = (req.headers as Record<string, string | undefined>)?.[
    'x-forwarded-for'
  ];
  const last = forwarded?.split(',').pop()?.trim();
  if (last) return last;
  return typeof req.ip === 'string' ? req.ip : 'unknown';
}
