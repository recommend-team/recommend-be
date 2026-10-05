import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';

/**
 * The handover code, while it is the buyer's to show — and null otherwise.
 *
 * Exposed for exactly as long as someone is waiting to check it: on a delivery, while a
 * rider has the order (DISPATCHED); on a pickup, while it sits ready at the counter
 * (READY). Not before, so it cannot be learned early, and not after, once it has done its
 * job. The row keeps the code either way, for support looking back at what was issued.
 */
export function liveHandoverCode(checkout: {
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  deliveryCode: string | null;
}): string | null {
  const live =
    checkout.fulfillmentType === FulfillmentType.PICKUP
      ? checkout.status === OrderStatus.READY
      : checkout.status === OrderStatus.DISPATCHED;
  return live ? (checkout.deliveryCode ?? null) : null;
}
