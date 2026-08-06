/**
 * Ordering seam — the contract only. There is deliberately no adapter yet: checkout
 * lands in B4, and the `checkouts` / `order_items` tables it needs do not exist. The
 * interface is here so the engine can be written against it, and so the shape is
 * agreed before the schema is built.
 */

export const ORDERING_PORT = Symbol('ORDERING_PORT');

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface PlaceCheckoutInput {
  /** Lines may span vendors — the platform splits them into one order per vendor. */
  lines: CartLine[];
  buyerId: string | null;
  buyerName: string;
  /** Must already be E.164. */
  buyerPhone: string;
  buyerEmail?: string;
  fulfillmentType: 'PICKUP' | 'DELIVERY';
  deliveryAddress?: string;
  notes?: string;
}

export interface PlacedCheckout {
  checkoutId: string;
  reference: string;
  authorizationUrl: string;
  goodsTotal: number;
  deliveryFee: number;
  totalAmount: number;
}

export interface OrderingPort {
  /** Prices are recomputed server-side; anything the client sent is untrusted. */
  placeCheckout(input: PlaceCheckoutInput): Promise<PlacedCheckout>;
}
