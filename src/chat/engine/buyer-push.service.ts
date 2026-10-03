import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BuyerPushSubscription } from '../conversation/entities/buyer-push-subscription.entity';
import { PUSH_PORT } from '../ports/push.port';
import type { BuyerPushMessage, PushPort } from '../ports/push.port';

/** Straight off the socket — nothing about its shape is trusted until checked. */
export interface SubscriptionInput {
  endpoint?: unknown;
  keys?: unknown;
  userAgent?: unknown;
}

@Injectable()
export class BuyerPushService {
  private readonly logger = new Logger(BuyerPushService.name);

  constructor(
    @InjectRepository(BuyerPushSubscription)
    private readonly subscriptions: Repository<BuyerPushSubscription>,
    @Inject(PUSH_PORT) private readonly push: PushPort,
  ) {}

  async subscribe(
    conversationId: string,
    input: SubscriptionInput,
  ): Promise<boolean> {
    const subscription = validSubscription(input);
    if (!subscription) return false;

    await this.subscriptions.upsert(
      { conversationId, ...subscription },
      { conflictPaths: ['endpoint'] },
    );
    return true;
  }

  async unsubscribe(conversationId: string, endpoint: unknown): Promise<void> {
    if (typeof endpoint !== 'string') return;
    // Scoped to the conversation: a device cannot unsubscribe someone else's endpoint.
    await this.subscriptions.delete({ conversationId, endpoint });
  }

  /** Never throws — a buyer who cannot be nudged is not a reason to fail anything else. */
  async notify(
    conversationId: string,
    message: BuyerPushMessage,
    delivery: { urgency?: 'normal' | 'high'; ttlSeconds?: number } = {},
  ): Promise<void> {
    try {
      if (!this.push.isEnabled()) return;

      const devices = await this.subscriptions.find({
        where: { conversationId },
      });
      if (devices.length === 0) return;

      const { gone } = await this.push.deliver(
        devices.map(({ endpoint, keys }) => ({ endpoint, keys })),
        message,
        delivery,
      );

      if (gone.length > 0) {
        await this.subscriptions.delete({ endpoint: In(gone) });
      }
    } catch (error) {
      this.logger.warn(
        `Could not push ${message.type} to conversation ${conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

const MAX_ENDPOINT = 1024;
const MAX_KEY = 256;

function validSubscription(input: SubscriptionInput): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
} | null {
  const { endpoint, keys, userAgent } = input ?? {};

  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) {
    return null;
  }
  try {
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const { p256dh, auth } = (keys ?? {}) as Record<string, unknown>;
  if (
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    !p256dh ||
    !auth ||
    p256dh.length > MAX_KEY ||
    auth.length > MAX_KEY
  ) {
    return null;
  }

  return {
    endpoint,
    keys: { p256dh, auth },
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
  };
}
