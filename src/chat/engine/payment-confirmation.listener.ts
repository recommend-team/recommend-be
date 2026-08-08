import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import {
  CHECKOUT_PAID_EVENT,
  CheckoutPaidEvent,
} from '../../common/events/checkout-paid.event';

/**
 * Closes the loop: the buyer paid, so tell them so — in the conversation they
 * already had, not in an email they will not open.
 */
@Injectable()
export class PaymentConfirmationListener {
  private readonly logger = new Logger(PaymentConfirmationListener.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly channelRegistry: ChannelRegistry,
  ) {}

  @OnEvent(CHECKOUT_PAID_EVENT)
  async onCheckoutPaid(event: CheckoutPaidEvent): Promise<void> {
    try {
      const conversation = await this.conversationService.findForCheckout(
        event.reference,
        event.buyerPhone,
      );

      // A checkout placed from the storefront rather than the chat has no thread to
      // post into. Not an error — there is simply nobody listening.
      if (!conversation) {
        this.logger.debug(
          `No conversation found for checkout ${event.reference} — nothing to confirm`,
        );
        return;
      }

      const text = buildConfirmation(event);

      // Persisted before it is sent, so a buyer who closed the tab mid-payment
      // still finds the confirmation waiting in their history.
      const persisted = await this.conversationService.recordOutbound({
        conversationId: conversation.id,
        text,
        payload: {
          kind: 'order_summary',
          data: {
            reference: event.reference,
            status: 'PAID',
            goodsTotal: event.goodsTotal,
            deliveryFee: event.deliveryFee,
            totalAmount: event.totalAmount,
            fulfillmentType: event.fulfillmentType,
            deliveryAddress: event.deliveryAddress,
            vendors: event.orders.map((order) => ({
              orderId: order.orderId,
              vendorName: order.vendorName,
              subtotal: order.subtotal,
              items: order.items,
            })),
          },
        },
      });

      await this.channelRegistry.send(
        conversation.channel,
        conversation.channelAddress,
        {
          text,
          payload: persisted.payload ?? undefined,
          messageId: persisted.id,
          createdAt: persisted.createdAt,
        },
      );

      // Clear the pending marker so a later checkout in the same thread cannot be
      // confused with this one.
      await this.conversationService.mergeContext(conversation.id, {
        pendingPaymentReference: undefined,
        pendingCheckoutId: undefined,
      });

      this.logger.log(
        `Confirmed checkout ${event.reference} in conversation ${conversation.id}`,
      );
    } catch (error) {
      // Never let this bubble into the webhook — Paystack would retry a payment we
      // have already recorded.
      this.logger.error(
        `Failed to confirm checkout ${event.reference} in chat: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

function buildConfirmation(event: CheckoutPaidEvent): string {
  const itemCount = event.orders.reduce(
    (sum, order) =>
      sum + order.items.reduce((inner, item) => inner + item.quantity, 0),
    0,
  );

  // Name the sellers rather than counting them — "from Tasty Pot and Gizmo Hub" tells the
  // buyer their basket really did split the way they meant it to.
  const named = event.orders
    .map((order) => order.vendorName)
    .filter((name): name is string => !!name);
  const places =
    named.length === event.orders.length && named.length > 0
      ? joinNames(named)
      : `${event.orders.length} vendor${event.orders.length === 1 ? '' : 's'}`;

  const where =
    event.fulfillmentType === 'DELIVERY'
      ? `We'll deliver to ${event.deliveryAddress ?? 'your address'}.`
      : "It'll be ready for pickup.";

  // Vendor-neutral on purpose: vendors sell cooked food, gadgets, appliances — anything.
  // "on its way to the kitchen" would be wrong for most of them.
  return (
    `Payment confirmed — thank you! Your order of ${itemCount} item${
      itemCount === 1 ? '' : 's'
    } from ${places} has been sent through. ` +
    `${where} Your reference is ${event.reference}.`
  );
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
