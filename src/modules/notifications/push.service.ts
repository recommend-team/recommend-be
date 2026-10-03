import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as webpush from 'web-push';
import { PushSubscription } from './entities/push-subscription.entity';

/**
 * What a client's service worker receives. The shape is a contract with every app that
 * subscribes — the vendor app's `sw.ts` reads it — so fields are added, never renamed.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** The `NotificationType`, so a client can decide how loudly to treat it. */
  type?: string;
  /** The in-app path a tap opens, e.g. `/orders/<id>`. Always a path, never a URL. */
  url?: string;
  /**
   * Collapses repeats: a second push with the same tag replaces the first on the device
   * instead of stacking beside it. `order:<id>`, `withdrawal:<id>`.
   */
  tag?: string;
  data?: Record<string, unknown>;
}

export interface PushDelivery {
  /**
   * `high` asks the push service to wake a dozing phone now rather than batch it. For
   * what a person must act on — a new order — and nothing else, or the OS learns to
   * ignore us.
   */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /**
   * How long the push service keeps trying a phone that is off. Past this the push is
   * dropped, which is right for an alert that would be noise by the time it arrived —
   * the feed still holds it.
   */
  ttlSeconds?: number;
}

/**
 * Web Push delivery.
 *
 * Missing VAPID keys are a supported state, not a crash: pushes are skipped and
 * logged, and the in-app feed still carries everything. A vendor is never blocked
 * from being notified because a key was not provisioned.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
  ) {
    const publicKey = this.configService.get<string>('push.publicKey');
    const privateKey = this.configService.get<string>('push.privateKey');
    const subject =
      this.configService.get<string>('push.subject') ??
      'mailto:support@recommend.ng';

    this.enabled = Boolean(publicKey && privateKey);

    if (this.enabled) {
      webpush.setVapidDetails(subject, publicKey!, privateKey!);
    } else {
      this.logger.warn(
        'VAPID keys are not set — web push is disabled (in-app feed still works)',
      );
    }
  }

  /** The key a browser needs before it can subscribe. */
  getPublicKey(): string | null {
    return this.configService.get<string>('push.publicKey') ?? null;
  }

  async subscribe(input: {
    userId: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
  }): Promise<void> {
    // The same browser re-subscribing must not create a duplicate row, and a
    // recycled endpoint must follow the user who now owns it.
    await this.subscriptions.upsert(
      {
        userId: input.userId,
        endpoint: input.endpoint,
        keys: input.keys,
        userAgent: input.userAgent ?? null,
      },
      { conflictPaths: ['endpoint'] },
    );
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.subscriptions.delete({ endpoint });
  }

  /**
   * Best-effort fan-out to every device a user has registered. Failures are
   * swallowed — a push that cannot be delivered must never fail the transaction
   * that triggered it.
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    delivery: PushDelivery = {},
  ): Promise<number> {
    if (!this.enabled) return 0;

    // Left unset, web-push applies its own defaults (normal urgency, four weeks).
    const options = {
      ...(delivery.urgency ? { urgency: delivery.urgency } : {}),
      ...(delivery.ttlSeconds !== undefined
        ? { TTL: delivery.ttlSeconds }
        : {}),
    };

    const devices = await this.subscriptions.find({ where: { userId } });
    if (devices.length === 0) return 0;

    let delivered = 0;

    await Promise.all(
      devices.map(async (device) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: device.endpoint,
              keys: device.keys,
            },
            JSON.stringify(payload),
            options,
          );
          delivered += 1;
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;

          if (statusCode === 404 || statusCode === 410) {
            await this.subscriptions.delete({ id: device.id });
            this.logger.debug(`Pruned expired push subscription ${device.id}`);
          } else {
            this.logger.warn(
              `Push to ${device.id} failed: ${
                error instanceof Error ? error.message : 'unknown error'
              }`,
            );
          }
        }
      }),
    );

    return delivered;
  }
}
