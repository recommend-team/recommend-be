import { OrderStatus } from '../enums/order-status.enum';
import { FulfillmentType } from '../enums/fulfillment-type.enum';

export const CHECKOUT_STATUS_CHANGED_EVENT = 'checkout.status.changed';

export class CheckoutStatusChangedEvent {
  constructor(
    readonly checkoutId: string,
    readonly reference: string,
    readonly buyerName: string,
    /** E.164 — how a conversation is found when the reference marker is already cleared. */
    readonly buyerPhone: string,
    readonly fulfillmentType: FulfillmentType,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    /** What they bought, so a closing message can be about their order and not generic. */
    readonly items: { name: string; quantity: number }[],
    readonly vendorNames: string[],
    readonly deliveryCode: string | null,
  ) {}
}
