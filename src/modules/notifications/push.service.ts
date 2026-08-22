import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as webpush from 'web-push';
import { PushSubscription } from './entities/push-subscription.entity';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
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
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.enabled) return 0;

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
