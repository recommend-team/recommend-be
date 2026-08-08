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
  /**
   * What the client last displayed. Never used for pricing — only so the platform can
   * tell the buyer "this changed since you added it" instead of quietly charging more.
   */
  expectedUnitPrice?: number;
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
  accessCode: string;
  paystackPublicKey: string | null;
  goodsTotal: number;
  deliveryFee: number;
  totalAmount: number;
}

/** Raised when the cart no longer matches reality, so the flow can explain it in chat. */
export interface CartRejection {
  code: 'CART_CHANGED';
  changes: {
    productId: string;
    productName: string | null;
    reason: string;
    expectedUnitPrice?: number;
    currentUnitPrice?: number;
  }[];
}

export interface OrderingPort {
  /** Prices are recomputed server-side; anything the client sent is untrusted. */
  placeCheckout(input: PlaceCheckoutInput): Promise<PlacedCheckout>;

  /**
   * What delivery will cost, before the checkout exists.
   *
   * The conversation reads the order back before charging for it, so it needs the fee a
   * moment earlier than `placeCheckout` can supply it. Asking the platform rather than
   * reading config here keeps a single rule for what delivery costs.
   */
  deliveryFeeFor(fulfillmentType: 'PICKUP' | 'DELIVERY'): number;
}
