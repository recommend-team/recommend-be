import type { BuyerOrderSummary } from '../../ports/ordering.port';
import { sanitizeUntrusted } from './sanitize';

/**
 * A buyer's own orders, put into words — for the model (get_my_orders), for the note
 * about the buyer on every reply, and for "where is my order?" without a model.
 */

/** Where an order is, as the buyer would say it. */
export function orderProgress(order: BuyerOrderSummary): string {
  const pickup = order.fulfillmentType === 'PICKUP';

  switch (order.status) {
    case 'PENDING_PAYMENT':
      return 'not paid yet';
    case 'PAID':
    case 'PROCESSING':
      return 'paid — the vendor is preparing it';
    case 'READY':
      return pickup
        ? 'ready to collect'
        : 'ready — waiting for a rider to pick it up';
    case 'DISPATCHED':
      return order.rider
        ? `on its way with ${firstName(order.rider.name)}`
        : 'on its way';
    case 'COMPLETED':
      return pickup ? 'collected' : 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'REFUNDED':
      return 'refunded';
    default:
      return order.status.toLowerCase().replace(/_/g, ' ');
  }
}

/** What get_my_orders shows the model. Vendor-written text is neutralised first. */
export function orderForModel(order: BuyerOrderSummary) {
  return {
    reference: order.reference,
    placed: order.createdAt,
    progress: orderProgress(order),
    fulfillment: order.fulfillmentType === 'PICKUP' ? 'pickup' : 'delivery',
    deliveryAddress: order.deliveryAddress,
    items: order.vendors.flatMap((vendor) =>
      vendor.items.map((item) => ({
        name: sanitizeUntrusted(item.name, 80),
        quantity: item.quantity,
        vendor: vendor.vendorName
          ? sanitizeUntrusted(vendor.vendorName, 80)
          : null,
      })),
    ),
    totalAmount: order.totalAmount,
    rider: order.rider ? firstName(order.rider.name) : null,
    // Shown to the buyer in their Orders tab already; theirs to read to the rider.
    code: order.handoverCode,
    collectFrom:
      order.vendors
        .map((vendor) => vendor.pickupAddress)
        .filter((address): address is string => !!address)
        .map((address) => sanitizeUntrusted(address, 160))[0] ?? null,
  };
}

/** Every amount an order carries — the price guard's allow-list when orders are shown. */
export function orderPrices(order: BuyerOrderSummary): number[] {
  return [
    order.goodsTotal,
    order.deliveryFee,
    order.totalAmount,
    ...order.vendors.flatMap((vendor) =>
      vendor.items.map((item) => item.lineTotal),
    ),
  ];
}

/** "Where is my order?" answered without a model. */
export function describeLatestOrder(orders: BuyerOrderSummary[]): string {
  const latest = orders[0];
  if (!latest) {
    return (
      "I can't see any orders from you on this device yet. If you ordered on another " +
      'phone or browser, sign in from the menu at the top right to see them here.'
    );
  }

  const progress = orderProgress(latest);
  const code =
    latest.handoverCode &&
    (latest.fulfillmentType === 'PICKUP'
      ? ' Show the collection code in your Orders tab when you get there.'
      : ' When the rider arrives, read them the code in your Orders tab.');

  return `Your latest order, ${latest.reference}, is ${progress}.${code || ''} You can follow it in the Orders tab at the bottom of the screen.`;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
