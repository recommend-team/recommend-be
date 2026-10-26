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
  /**
   * A dish built as a pack (PRODUCT_OPTIONS_PLAN.md): `quantity` is portions per pack,
   * `packs` identical packs, with these extras and choices in each. Absent from older apps.
   */
  packs?: number;
  extras?: {
    productId: string;
    quantity: number;
    expectedUnitPrice?: number;
  }[];
  choices?: { groupId: string; optionIds: string[] }[];
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
  /** Picked from Google: the token, and the house number or landmark Google can't know. */
  deliveryPlace?: { token: string; details?: string };
  notes?: string;
  createdByAdminId?: string;
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
    dishName?: string;
    groupName?: string;
    optionName?: string | null;
    /** On a closed vendor: when they next open (ISO), or null. */
    opensAt?: string | null;
  }[];
}

/** One past order, as the buyer's Orders tab shows it. */
export interface BuyerOrderSummary {
  reference: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
  fulfillmentType: string;
  deliveryAddress: string | null;
  goodsTotal: number;
  deliveryFee: number;
  totalAmount: number;
  canComplete: boolean;
  handoverCode: string | null;
  rider: { name: string; phone: string | null } | null;
  /**
   * When a paid delivery is expected: payment plus `DELIVERY_ETA_MINUTES`. Null for a
   * pickup or an unpaid order. What the buyer's delivery timer counts towards.
   */
  expectedBy: string | null;
  /** The minutes behind `expectedBy`, so the timer knows its full length. */
  etaMinutes: number;
  vendors: {
    vendorName: string | null;
    /** Where to collect from. Pickup orders only, and only once paid. */
    pickupAddress: string | null;
    status: string;
    items: { name: string; quantity: number; lineTotal: number }[];
  }[];
}

export interface CartQuote {
  /** One per dish as built — "Rice and beans (2 portions, with Beef ×2)". */
  lines: {
    name: string;
    vendorName: string | null;
    /** Packs for a built dish; the count otherwise. */
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  goodsTotal: number;
}

export interface OrderingPort {
  /** Prices are recomputed server-side; anything the client sent is untrusted. */
  placeCheckout(input: PlaceCheckoutInput): Promise<PlacedCheckout>;

  /**
   * The buyer's own orders, by the references their device holds.
   *
   * Takes references rather than a buyer id because there is no login — the session
   * token is the identity, and the conversation is what remembers which orders belong
   * to it.
   */
  listOrders(references: string[]): Promise<BuyerOrderSummary[]>;

  /** "I have it." The buyer's one transition. */
  completeOrder(reference: string): Promise<void>;

  /**
   * The cart priced exactly as `placeCheckout` will price it — packs, choices, extras —
   * without placing it, so the summary the buyer agrees to is what they're charged.
   * Null when it can't be priced right now (a changed cart is caught at checkout).
   */
  quoteCart(lines: CartLine[]): Promise<CartQuote | null>;

  deliveryFeeFor(fulfillmentType: 'PICKUP' | 'DELIVERY'): number;

  /** Whether buyers may choose pickup right now. Off: delivery is the only option. */
  pickupEnabled(): boolean;
}
