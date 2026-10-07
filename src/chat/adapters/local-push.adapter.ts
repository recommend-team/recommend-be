import { Injectable } from '@nestjs/common';
import { PushService } from '../../modules/notifications/push.service';
import type {
  BuyerPushMessage,
  PushDevice,
  PushPort,
} from '../ports/push.port';

/**
 * In-process implementation of `PushPort`, over the platform's `PushService` — the same
 * VAPID keys and the same sending code as vendor and admin pushes.
 */
@Injectable()
export class LocalPushAdapter implements PushPort {
  constructor(private readonly push: PushService) {}

  isEnabled(): boolean {
    return this.push.isEnabled();
  }

  async deliver(
    devices: PushDevice[],
    message: BuyerPushMessage,
    delivery: { urgency?: 'normal' | 'high'; ttlSeconds?: number } = {},
  ): Promise<{ gone: string[] }> {
    const { gone } = await this.push.deliver(devices, message, delivery);
    return { gone };
  }
}
