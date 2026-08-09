import { OrderStatus } from '../enums/order-status.enum';

/**
 * Emitted when a buyer's whole purchase moves, never when one vendor does.
 *
 * The distinction is the point. A basket split across two vendors has two independent
 * statuses, and the buyer made one payment for one delivery — telling them "on its way"
 * because the faster vendor finished would be a lie about the thing they are waiting for.
 *
 * Plain data, like `CheckoutPaidEvent`: this is the contract between the orders module
 * and whatever reacts to it, so listeners never reach back into order internals and the
 * chat context stays extractable.
 */
export const CHECKOUT_STATUS_CHANGED_EVENT = 'checkout.status.changed';

export class CheckoutStatusChangedEvent {
  constructor(
    readonly checkoutId: string,
    readonly reference: string,
    readonly buyerName: string,
    /** E.164 — how a conversation is found when the reference marker is already cleared. */
    readonly buyerPhone: string,
    readonly fulfillmentType: string,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    /** What they bought, so a closing message can be about their order and not generic. */
    readonly items: { name: string; quantity: number }[],
    readonly vendorNames: string[],
  ) {}
}
