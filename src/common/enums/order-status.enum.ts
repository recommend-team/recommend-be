/**
 * Where an order has got to.
 *
 * The same enum serves two levels. On an `order` it is what one vendor is doing, and a
 * vendor only ever moves it to `READY`. On a `checkout` it is the buyer's whole purchase,
 * derived from the least-advanced of its vendor orders — so a buyer is never told the
 * order is on its way while half of it has not been picked up.
 *
 * Values are ordered by lifecycle, which is also how Postgres sorts the enum type.
 */
export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  /** Vendor has the goods and a rider can collect. Their only transition. */
  READY = 'READY',
  /**
   * A rider has collected everything and left. Checkout-level only: with one rider
   * carrying the whole basket, no single vendor knows collection has finished.
   */
  DISPATCHED = 'DISPATCHED',
  /**
   * Predates the lifecycle and is written by nothing. Kept because removing a value from
   * a Postgres enum means rebuilding the type and every column using it — a real
   * migration risk in exchange for tidiness.
   */
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}
