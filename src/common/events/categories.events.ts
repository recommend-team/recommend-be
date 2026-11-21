/**
 * An admin created, renamed, archived or re-priced a category, or changed its words.
 * The assistant reloads the categories it offers and the words that point at them.
 */
export const CATEGORIES_CHANGED_EVENT = 'categories.changed';

/**
 * What Recommend keeps of this vendor's sales went up — their category's rate rose, the
 * Super Admin set their own rate higher, or they were moved to a category that costs
 * more. They are told before their next order, not after it.
 */
export const COMMISSION_RATE_RAISED_EVENT = 'commission.rate-raised';

export class CommissionRateRaisedEvent {
  constructor(
    readonly vendorId: string,
    readonly previousPercent: number,
    readonly newPercent: number,
  ) {}
}
