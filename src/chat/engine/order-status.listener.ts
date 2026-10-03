import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { BuyerPushService } from './buyer-push.service';
import { AppreciationService } from './appreciation.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import {
  CHECKOUT_STATUS_CHANGED_EVENT,
  CheckoutStatusChangedEvent,
} from '../../common/events/checkout-status-changed.event';

@Injectable()
export class OrderStatusListener {
  private readonly logger = new Logger(OrderStatusListener.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly channelRegistry: ChannelRegistry,
    private readonly appreciation: AppreciationService,
    private readonly buyerPush: BuyerPushService,
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

      await this.pushFor(event, conversation.id, text);
    } catch (error) {
      // A buyer who cannot be told is not a reason to unwind a delivery that happened.
      this.logger.error(
        `Failed to tell the buyer about ${event.reference} → ${event.to}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async pushFor(
    event: CheckoutStatusChangedEvent,
    conversationId: string,
    text: string,
  ): Promise<void> {
    const tag = `order:${event.reference}`;

    if (event.to === OrderStatus.READY) {
      await this.buyerPush.notify(
        conversationId,
        {
          title: 'Ready for collection',
          body: text,
          type: 'ORDER_READY',
          url: '/',
          tag,
        },
        { ttlSeconds: 6 * 60 * 60 },
      );
    } else if (event.to === OrderStatus.DISPATCHED) {
      // Carries the delivery code. Urgent: the rider is on the way to their door.
      await this.buyerPush.notify(
        conversationId,
        {
          title: 'On its way',
          body: text,
          type: 'ORDER_DISPATCHED',
          url: '/',
          tag,
        },
        { urgency: 'high', ttlSeconds: 6 * 60 * 60 },
      );
    }
  }

  /** Null for every transition the buyer has no use for. */
  private async messageFor(
    event: CheckoutStatusChangedEvent,
  ): Promise<string | null> {
    const isPickup = event.fulfillmentType === FulfillmentType.PICKUP;

    switch (event.to) {
      case OrderStatus.READY:
        return isPickup ? 'Your order is ready for collection.' : null;
      case OrderStatus.DISPATCHED:
        return event.deliveryCode
          ? `Your order is on its way. Your delivery code is ${event.deliveryCode} — read it to the rider when they arrive.`
          : 'Your order is on its way.';

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
