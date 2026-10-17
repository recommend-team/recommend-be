/**
 * An order has been with its rider far longer than a delivery takes. Emitted once per
 * order by `StuckDeliveryService`; admins are alerted, so someone calls the rider.
 */
export const DELIVERY_STUCK_EVENT = 'checkout.delivery-stuck';

export class DeliveryStuckEvent {
  constructor(
    readonly reference: string,
    readonly buyerName: string,
    readonly riderName: string | null,
    readonly riderPhone: string | null,
    /** When it left with the rider. */
    readonly dispatchedAt: Date,
  ) {}
}
