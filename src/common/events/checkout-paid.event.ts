/**
 * Emitted once a checkout is confirmed paid.
 *
 * Deliberately plain data — no entities, no repositories. This is the contract
 * between the orders module and everything that reacts to a payment (the chat
 * context, vendor notifications), so listeners never reach back into order
 * internals and the chat context stays extractable.
 */
export const CHECKOUT_PAID_EVENT = 'checkout.paid';

export interface CheckoutPaidVendorOrder {
  orderId: string;
  vendorId: string;
  /** This vendor's goods subtotal. */
  subtotal: number;
  /** What this vendor is owed. */
  vendorAmount: number;
  items: { name: string; quantity: number }[];
}

export class CheckoutPaidEvent {
  constructor(
    readonly checkoutId: string,
    readonly reference: string,
    readonly buyerName: string,
    /** E.164. */
    readonly buyerPhone: string,
    readonly buyerEmail: string | null,
    readonly fulfillmentType: string,
    readonly deliveryAddress: string | null,
    readonly goodsTotal: number,
    readonly deliveryFee: number,
    readonly totalAmount: number,
    readonly orders: CheckoutPaidVendorOrder[],
    readonly paidAt: Date,
  ) {}
}
