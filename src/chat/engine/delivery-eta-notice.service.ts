import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { BuyerPushService } from './buyer-push.service';
import { ChatChannel } from '../enums/chat.enums';
import { Checkout } from '../../modules/orders/entities/checkout.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';

/** Paid and on the way to the buyer, not yet received. */
const UNDER_WAY = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.READY,
  OrderStatus.DISPATCHED,
];

export const ORDER_IS_CLOSE =
  "Your order should be with you any moment now — it's close. If it hasn't arrived " +
  "in the next few minutes, just reply here and we'll check on it for you.";

/**
 * Tells the buyer, once, that their order is close when its expected time has passed.
 *
 * The buyer's delivery timer runs for `DELIVERY_ETA_MINUTES` from payment. When it runs
 * out and they have not said they received it, silence reads as "forgotten"; this says
 * it is not.
 *
 * Claimed by one conditional UPDATE on the conversation — the reference is added to
 * `context.etaNoticeSent` in the same statement that finds it — so with several
 * instances running, each buyer is told once per order.
 */
@Injectable()
export class DeliveryEtaNoticeService {
  private readonly logger = new Logger(DeliveryEtaNoticeService.name);

  constructor(
    @InjectRepository(Checkout)
    private readonly checkouts: Repository<Checkout>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly conversationService: ConversationService,
    private readonly channels: ChannelRegistry,
    private readonly buyerPush: BuyerPushService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sendDueNotices(): Promise<number> {
    const etaMinutes = this.config.get<number>('chat.deliveryEtaMinutes') ?? 30;
    const now = Date.now();
    const cutoff = new Date(now - etaMinutes * 60_000);
    // A day-old order still "under way" is a stuck one for the team, not news for the
    // buyer — and this keeps the scan to recent orders.
    const oldest = new Date(now - 24 * 60 * 60_000);

    let claimed: ClaimedNotice[];
    try {
      const due = await this.checkouts
        .createQueryBuilder('checkout')
        .select('checkout.reference', 'reference')
        .where('checkout.status IN (:...underWay)', { underWay: UNDER_WAY })
        .andWhere('checkout.fulfillmentType = :delivery', {
          delivery: FulfillmentType.DELIVERY,
        })
        .andWhere('checkout.paidAt <= :cutoff', { cutoff })
        .andWhere('checkout.paidAt > :oldest', { oldest })
        .getRawMany<{ reference: string }>();

      if (due.length === 0) return 0;

      claimed = await this.claim(due.map((row) => row.reference));
    } catch (error) {
      this.logger.error(
        `Could not look for orders past their expected time: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return 0;
    }

    for (const notice of claimed) {
      try {
        const persisted = await this.conversationService.recordOutbound({
          conversationId: notice.id,
          text: ORDER_IS_CLOSE,
        });
        await this.channels.send(notice.channel, notice.channelAddress, {
          text: ORDER_IS_CLOSE,
          messageId: persisted.id,
          createdAt: persisted.createdAt,
        });
        // The app may be closed by now — that is the point of telling them.
        await this.buyerPush.notify(
          notice.id,
          {
            title: 'Your order is close',
            body: 'It should be with you any moment now.',
            type: 'REPLY',
            url: '/',
            tag: `order:${notice.reference}`,
          },
          { ttlSeconds: 1800 },
        );
        this.logger.log(
          `Order ${notice.reference} passed its ${etaMinutes}-minute estimate — told the buyer it is close`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the order-is-close notice for ${notice.reference}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return claimed.length;
  }

  /**
   * Mark each reference as told on the conversation that owns it, returning the ones
   * this call marked. One already marked — by an earlier run or another instance — is
   * not returned, so it is never sent twice.
   */
  private async claim(references: string[]): Promise<ClaimedNotice[]> {
    const raw: unknown = await this.conversations.query(
      `UPDATE conversations c
          SET context = jsonb_set(
                COALESCE(c.context, '{}'::jsonb),
                '{etaNoticeSent}',
                COALESCE(c.context->'etaNoticeSent', '[]'::jsonb) || to_jsonb(due.reference)
              )
         FROM (SELECT unnest($1::text[]) AS reference) due
        WHERE c."mergedIntoId" IS NULL
          AND jsonb_exists(COALESCE(c.context->'orderReferences', '[]'::jsonb), due.reference)
          AND NOT jsonb_exists(COALESCE(c.context->'etaNoticeSent', '[]'::jsonb), due.reference)
        RETURNING c.id, c.channel, c."channelAddress", due.reference`,
      [references],
    );

    // TypeORM hands back [rows, affected] for an UPDATE, and plain rows elsewhere.
    const rows = (
      Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw
    ) as ClaimedNotice[];
    return Array.isArray(rows) ? rows : [];
  }
}

interface ClaimedNotice {
  id: string;
  channel: ChatChannel;
  channelAddress: string;
  reference: string;
}
