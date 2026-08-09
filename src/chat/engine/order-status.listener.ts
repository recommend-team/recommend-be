import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { AppreciationService } from './appreciation.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import {
  CHECKOUT_STATUS_CHANGED_EVENT,
  CheckoutStatusChangedEvent,
} from '../../common/events/checkout-status-changed.event';

/**
 * What the buyer hears about their order after paying — which is almost nothing.
 *
 * The lifecycle has five states and the buyer sees two messages: one when the order is
 * genuinely on its way to them (or ready to collect), and one when it is over. Every
 * other transition is real, recorded, and visible to vendors and admin — and none of
 * their business.
 *
 * The restraint is the design. Each message pushes their conversation up the screen, and
 * a running commentary on someone else's workflow is noise dressed up as service.
 */
@Injectable()
export class OrderStatusListener {
  private readonly logger = new Logger(OrderStatusListener.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly channelRegistry: ChannelRegistry,
    private readonly appreciation: AppreciationService,
  ) {}

  @OnEvent(CHECKOUT_STATUS_CHANGED_EVENT)
  async onStatusChanged(event: CheckoutStatusChangedEvent): Promise<void> {
    try {
      const text = await this.messageFor(event);
      if (!text) return;

      const conversation = await this.conversationService.findForCheckout(
        event.reference,
        event.buyerPhone,
      );

      // An order placed from the storefront rather than the chat has no thread to post
      // into. Not an error — there is simply nobody listening.
      if (!conversation) {
        this.logger.debug(
          `No conversation for ${event.reference} — nothing to say about ${event.to}`,
        );
        return;
      }

      // Persisted before it is sent, so a buyer whose socket is dead still finds it
      // waiting in their history.
      const persisted = await this.conversationService.recordOutbound({
        conversationId: conversation.id,
        text,
      });

      await this.channelRegistry.send(
        conversation.channel,
        conversation.channelAddress,
        {
          text,
          messageId: persisted.id,
          createdAt: persisted.createdAt,
        },
      );
    } catch (error) {
      // A buyer who cannot be told is not a reason to unwind a delivery that happened.
      this.logger.error(
        `Failed to tell the buyer about ${event.reference} → ${event.to}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /** Null for every transition the buyer has no use for. */
  private async messageFor(
    event: CheckoutStatusChangedEvent,
  ): Promise<string | null> {
    const isPickup = event.fulfillmentType === FulfillmentType.PICKUP;

    switch (event.to) {
      // On a pickup order this is the buyer's cue to leave the house, and the only
      // message that matters. On a delivery it is an internal handoff signal.
      case OrderStatus.READY:
        return isPickup ? 'Your order is ready for collection.' : null;

      // Only ever set on a delivery, and only once a rider has everything.
      case OrderStatus.DISPATCHED:
        return 'Your order is on its way.';

      case OrderStatus.COMPLETED:
        return this.appreciation.write({
          buyerName: event.buyerName,
          items: event.items,
          vendorNames: event.vendorNames,
        });

      default:
        return null;
    }
  }
}
