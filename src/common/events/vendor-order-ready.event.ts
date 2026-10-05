import { FulfillmentType } from '../enums/fulfillment-type.enum';

/**
 * A vendor tapped "Ready for pickup" on their part of a basket.
 *
 * Published after the transaction commits, with how much of the basket is now ready —
 * the last vendor being ready on a delivery is the moment an admin has to send a rider.
 */
export const VENDOR_ORDER_READY_EVENT = 'order.vendor-ready';

export class VendorOrderReadyEvent {
  constructor(
    readonly orderId: string,
    readonly checkoutId: string,
    readonly reference: string,
    readonly vendorName: string | null,
    readonly fulfillmentType: FulfillmentType,
    /** Vendors on the basket now ready, including this one. Cancelled ones not counted. */
    readonly readyCount: number,
    readonly vendorCount: number,
  ) {}
}
