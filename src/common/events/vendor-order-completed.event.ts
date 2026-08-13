
export const VENDOR_ORDER_COMPLETED_EVENT = 'vendor-order.completed';

export class VendorOrderCompletedEvent {
  constructor(
    readonly orderId: string,
    readonly checkoutId: string,
    readonly vendorId: string,
    readonly reference: string,
    readonly subtotal: number,
    readonly platformFee: number,
    readonly vendorAmount: number,
  ) {}
}
